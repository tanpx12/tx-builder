// Retry open_short on Stellar — bridge already completed, USDC is on Stellar
// Usage: npx tsx src/mainnet/retry-open-short.ts

import "dotenv/config";
import {
  TransactionBuilder,
  Networks,
  Operation,
  nativeToScVal,
  Address as StellarAddress,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import {
  STELLAR_SOROBAN_RPC,
  STELLAR_USDC_TOKEN,
  STELLAR_XLM_TOKEN,
  UNTANGLED_LOOP_CONTRACT,
  BLEND_POOL_CONTRACT,
} from "./config.js";
import { deriveMainnetAddresses } from "./near.js";
import { deriveKeypairFromPublicKey } from "../core/stellar.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Aquarius swap quote ──

interface SwapHopDecoded {
  tokens_in_pool: string[];
  pool_index: string;
  token_out: string;
}

async function getAquariusQuote(
  tokenIn: string, tokenOut: string, amountStroops: string,
): Promise<{ swapChain: SwapHopDecoded[]; estimatedOutput: bigint }> {
  const res = await fetch("https://amm-api.aqua.network/pools/find-path/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token_in_address: tokenIn, token_out_address: tokenOut, amount: amountStroops }),
  });
  if (!res.ok) throw new Error(`Aquarius API failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  if (!data.success) throw new Error(`Aquarius quote failed: ${JSON.stringify(data)}`);
  const swapChain = decodeSwapChainXdr(data.swap_chain_xdr);
  return { swapChain, estimatedOutput: BigInt(String(data.amount).split(".")[0]) };
}

function decodeSwapChainXdr(swapChainXdr: string): SwapHopDecoded[] {
  const scVal = xdr.ScVal.fromXDR(swapChainXdr, "base64");
  const swapChain: SwapHopDecoded[] = [];
  if (scVal.switch().name === "scvVec") {
    for (const hop of scVal.vec()!) {
      if (hop.switch().name === "scvVec") {
        const t = hop.vec()!;
        swapChain.push({
          tokens_in_pool: t[0].vec()!.map((a) => StellarAddress.fromScVal(a).toString()),
          pool_index: Buffer.from(t[1].bytes()).toString("hex"),
          token_out: StellarAddress.fromScVal(t[2]).toString(),
        });
      }
    }
  }
  return swapChain;
}

function buildSwapHopScVal(hop: SwapHopDecoded): xdr.ScVal {
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("pool_index"), val: xdr.ScVal.scvBytes(Buffer.from(hop.pool_index, "hex")) }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("token_out"), val: StellarAddress.fromString(hop.token_out).toScVal() }),
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("tokens_in_pool"), val: xdr.ScVal.scvVec(hop.tokens_in_pool.map((a) => StellarAddress.fromString(a).toScVal())) }),
  ]);
}

function buildSwapChainScVal(swapChain: SwapHopDecoded[]): xdr.ScVal {
  return xdr.ScVal.scvVec(swapChain.map(buildSwapHopScVal));
}

// ── Main ──

async function main() {
  const flashXlm = process.argv[2] ?? "15";
  const marginUsdc = process.argv[3] ?? "3.4";

  const flashAmountStroops = BigInt(Math.floor(parseFloat(flashXlm) * 10_000_000));
  const marginAmountStroops = BigInt(Math.floor(parseFloat(marginUsdc) * 10_000_000));

  console.log(`Flash: ${flashXlm} XLM (${flashAmountStroops} stroops)`);
  console.log(`Margin: ${marginUsdc} USDC (${marginAmountStroops} stroops)\n`);

  const addrs = await deriveMainnetAddresses();
  console.log(`Stellar: ${addrs.stellar.address}`);
  const keypair = deriveKeypairFromPublicKey(addrs.stellar.secp256k1PublicKeyHex);
  const sorobanServer = new rpc.Server(STELLAR_SOROBAN_RPC);

  // Get swap quote
  console.log("\nGetting Aquarius swap quote (XLM -> USDC)...");
  const aquariusQuote = await getAquariusQuote(
    STELLAR_XLM_TOKEN, STELLAR_USDC_TOKEN, flashAmountStroops.toString(),
  );
  const minSwapOutput = (aquariusQuote.estimatedOutput * 99n) / 100n;
  console.log(`  Estimated output: ${Number(aquariusQuote.estimatedOutput) / 1e7} USDC`);
  console.log(`  Min output (1%):  ${Number(minSwapOutput) / 1e7} USDC`);
  console.log(`  Hops: ${aquariusQuote.swapChain.length}`);

  // Approve USDC for Blend pool
  const estimatedCollateral = marginAmountStroops + minSwapOutput;
  const approveAmount = estimatedCollateral + 10_000_000n;
  console.log(`\nApproving ${Number(approveAmount) / 1e7} USDC for Blend pool...`);

  const freshAccount = await sorobanServer.getAccount(addrs.stellar.address);
  const latestLedger = (await sorobanServer.getLatestLedger()).sequence;

  const approveTx = new TransactionBuilder(freshAccount, {
    fee: "10000000",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: STELLAR_USDC_TOKEN,
      function: "approve",
      args: [
        nativeToScVal(addrs.stellar.address, { type: "address" }),
        nativeToScVal(BLEND_POOL_CONTRACT, { type: "address" }),
        nativeToScVal(approveAmount, { type: "i128" }),
        nativeToScVal(Number(latestLedger) + 1000, { type: "u32" }),
      ],
    }))
    .setTimeout(300)
    .build();

  const preparedApprove = await sorobanServer.prepareTransaction(approveTx);
  preparedApprove.sign(keypair);
  const approveResult = await sorobanServer.sendTransaction(preparedApprove);
  console.log(`  Approve tx: ${approveResult.hash}`);

  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const txr = await sorobanServer.getTransaction(approveResult.hash);
      if (txr.status !== "NOT_FOUND") { console.log(`  Status: ${txr.status}`); break; }
    } catch (e: any) {
      console.log(`  Status check: ${e.message} (likely OK)`);
      break;
    }
  }

  // Build open_short args
  const swapChainScVal = buildSwapChainScVal(aquariusQuote.swapChain);
  const openShortArgs = [
    nativeToScVal(addrs.stellar.address, { type: "address" }),
    nativeToScVal(flashAmountStroops, { type: "i128" }),
    nativeToScVal(marginAmountStroops, { type: "i128" }),
    nativeToScVal(minSwapOutput, { type: "i128" }),
    nativeToScVal(true, { type: "bool" }),
    swapChainScVal,
  ];

  // Build + simulate open_short
  console.log("\nSimulating open_short...");
  const freshAccount2 = await sorobanServer.getAccount(addrs.stellar.address);
  const openShortTx = new TransactionBuilder(freshAccount2, {
    fee: "20000000",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: UNTANGLED_LOOP_CONTRACT,
      function: "open_short",
      args: openShortArgs,
    }))
    .setTimeout(300)
    .build();

  const simResult = await sorobanServer.simulateTransaction(openShortTx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.error("Simulation FAILED:");
    console.error("Error:", simResult.error);

    // Check for restore preamble
    if ((simResult as any).restorePreamble) {
      console.log("\nExpired ledger entries — restoring...");
      const restorePreamble = (simResult as any).restorePreamble;
      const restoreAccount = await sorobanServer.getAccount(addrs.stellar.address);
      const restoreTx = new TransactionBuilder(restoreAccount, {
        fee: restorePreamble.minResourceFee?.toString() || "10000000",
        networkPassphrase: Networks.PUBLIC,
      })
        .setSorobanData(restorePreamble.transactionData)
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(300)
        .build();
      restoreTx.sign(keypair);
      const restoreResult = await sorobanServer.sendTransaction(restoreTx);
      console.log(`Restore tx: ${restoreResult.hash}`);
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const txr = await sorobanServer.getTransaction(restoreResult.hash);
        if (txr.status !== "NOT_FOUND") { console.log(`Restore: ${txr.status}`); break; }
      }

      // Re-simulate
      console.log("\nRe-simulating open_short...");
      const freshAccount3 = await sorobanServer.getAccount(addrs.stellar.address);
      const retryTx = new TransactionBuilder(freshAccount3, {
        fee: "20000000", networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(Operation.invokeContractFunction({
          contract: UNTANGLED_LOOP_CONTRACT, function: "open_short", args: openShortArgs,
        }))
        .setTimeout(300).build();
      const retrySimResult = await sorobanServer.simulateTransaction(retryTx);
      if (rpc.Api.isSimulationError(retrySimResult)) {
        console.error("Re-simulation failed:", retrySimResult.error);
        process.exit(1);
      }
      const assembled = rpc.assembleTransaction(retryTx, retrySimResult);
      const prepared = assembled.build();
      prepared.sign(keypair);
      const sendResult = await sorobanServer.sendTransaction(prepared);
      console.log(`Tx: ${sendResult.hash}, status: ${sendResult.status}`);
      await pollTx(sorobanServer, sendResult.hash);
    } else {
      // Show last few events for debugging
      if (simResult.events?.length) {
        console.error(`\nEvents (last 5 of ${simResult.events.length}):`);
        for (const ev of simResult.events.slice(-5)) console.error(" ", ev);
      }
      process.exit(1);
    }
  } else if (rpc.Api.isSimulationRestore(simResult)) {
    console.log("Expired entries — restoring first...");
    const restoreAccount = await sorobanServer.getAccount(addrs.stellar.address);
    const restoreTx = new TransactionBuilder(restoreAccount, {
      fee: simResult.restorePreamble.minResourceFee.toString(),
      networkPassphrase: Networks.PUBLIC,
    })
      .setSorobanData(simResult.restorePreamble.transactionData)
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(300).build();
    restoreTx.sign(keypair);
    const restoreResult = await sorobanServer.sendTransaction(restoreTx);
    console.log(`Restore: ${restoreResult.hash}`);
    await pollTx(sorobanServer, restoreResult.hash);

    const freshAccount3 = await sorobanServer.getAccount(addrs.stellar.address);
    const retryTx = new TransactionBuilder(freshAccount3, {
      fee: "20000000", networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(Operation.invokeContractFunction({
        contract: UNTANGLED_LOOP_CONTRACT, function: "open_short", args: openShortArgs,
      }))
      .setTimeout(300).build();
    const retrySimResult = await sorobanServer.simulateTransaction(retryTx);
    if (rpc.Api.isSimulationError(retrySimResult)) {
      console.error("Re-simulation failed:", retrySimResult.error);
      process.exit(1);
    }
    const assembled = rpc.assembleTransaction(retryTx, retrySimResult);
    const prepared = assembled.build();
    prepared.sign(keypair);
    const sendResult = await sorobanServer.sendTransaction(prepared);
    console.log(`Tx: ${sendResult.hash}, status: ${sendResult.status}`);
    await pollTx(sorobanServer, sendResult.hash);
  } else {
    // Success path
    const assembled = rpc.assembleTransaction(openShortTx, simResult);
    const prepared = assembled.build();
    prepared.sign(keypair);
    console.log("Submitting open_short...");
    const sendResult = await sorobanServer.sendTransaction(prepared);
    console.log(`Tx: ${sendResult.hash}, status: ${sendResult.status}`);
    await pollTx(sorobanServer, sendResult.hash);
  }

  console.log("\nDone!");
}

async function pollTx(server: rpc.Server, hash: string) {
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    try {
      const txr = await server.getTransaction(hash);
      if (txr.status !== "NOT_FOUND") {
        console.log(`Final: ${txr.status}`);
        if (txr.status === "SUCCESS") console.log(`Ledger: ${txr.ledger}`);
        return;
      }
    } catch (e: any) {
      console.log(`Status check: ${e.message} (likely OK)`);
      return;
    }
    if (i % 5 === 4) console.log(`Still pending... (${(i + 1) * 2}s)`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
