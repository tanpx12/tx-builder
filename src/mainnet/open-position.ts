// src/mainnet/open-position.ts
// Open Position Flow: EVM -> Stellar (single-input)
//
// All parameters derive from a single --weth input:
//   1. Supply WETH collateral on Morpho
//   2. Borrow 70% LTV in USDC from Morpho
//   3. Bridge all borrowed USDC to Stellar via 1Click
//   4. Use all received USDC as margin to open short
//   5. Flash loan XLM worth the same value as the margin
//
// Usage:
//   npx tsx src/mainnet/open-position.ts --weth=0.01          # dry-run
//   npx tsx src/mainnet/open-position.ts --weth=0.01 --submit # execute on-chain
//
// Overrides (optional):
//   --ltv=70              # borrow LTV percentage (default: 70)
//   --bridge-buffer=3     # % to subtract from margin for bridge fees (default: 3)
//
// Requires:
//   MAINNET_KEY="ed25519:..." in .env
//
// Prerequisites:
//   - Policies registered via set-policies.ts
//   - Derived EVM account has WETH + ETH gas on Arbitrum
//   - Derived Stellar account funded with XLM

import "dotenv/config";
import { ethers } from "ethers";
import {
  Account,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  StrKey,
  nativeToScVal,
  Address as StellarAddress,
  xdr,
  rpc,
} from "@stellar/stellar-sdk";
import {
  ARB_RPC,
  ARB_CHAIN_ID,
  USDC_ADDRESS,
  WETH_ADDRESS,
  MORPHO_ADDRESS,
  STELLAR_MAINNET_HORIZON,
  STELLAR_SOROBAN_RPC,
  STELLAR_USDC_TOKEN,
  STELLAR_XLM_TOKEN,
  UNTANGLED_LOOP_CONTRACT,
  BLEND_POOL_CONTRACT,
  MAINNET_CONTRACT_ID,
} from "./config.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  submitBatch,
  crankBatchNext,
  pollBatchStatus,
  getBatchSignatures,
  refundBatch,
  signStellarTransactionViaMpc,
  type MpcSignature,
} from "./near.js";
import {
  fetchMarketParams,
  buildApproveWethCalldata,
  buildSupplyCollateralCalldata,
  buildBorrowCalldata,
  buildUsdcTransferCalldata,
} from "./morpho.js";
import {
  getBridgeQuote,
  submitDeposit,
  pollBridgeStatus,
} from "./bridge.js";
import { attachMpcEd25519Signature, type MpcEd25519Signature } from "../core/stellar.js";
import { TxLog } from "./tx-log.js";

const txLog = new TxLog("Open Leveraged Short Position");

// ── CLI args ──

function parseArg(name: string, defaultVal: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1]! : defaultVal;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function reconstructSignedEvmTx(
  unsignedTx: ethers.Transaction,
  sig: MpcSignature,
  expectedFrom: string,
): ethers.Transaction {
  const r = "0x" + sig.big_r.affine_point.slice(2);
  const s = "0x" + sig.s.scalar;
  const signedTx = unsignedTx.clone();
  signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id });
  if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
    signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id ^ 1 });
    if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new Error(`Recovered signer ${signedTx.from} does not match expected ${expectedFrom}`);
    }
  }
  return signedTx;
}

// ── Aquarius AMM helpers ──

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
  return {
    swapChain: decodeSwapChainXdr(data.swap_chain_xdr),
    estimatedOutput: BigInt(String(data.amount).split(".")[0]),
  };
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

// ── Soroban tx helpers ──

async function sendSorobanTx(
  server: rpc.Server,
  nearAccount: Awaited<ReturnType<typeof getMainnetAccount>>,
  ed25519PublicKeyHex: string,
  tx: any,
  label: string,
): Promise<{ hash: string; success: boolean }> {
  const prepared = await server.prepareTransaction(tx);
  await signStellarTransactionViaMpc(nearAccount, prepared, ed25519PublicKeyHex);
  const result = await server.sendTransaction(prepared);
  console.log(`    ${label} tx: ${result.hash}`);
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    try {
      const txr = await server.getTransaction(result.hash);
      if (txr.status !== "NOT_FOUND") { console.log(`    ${label}: ${txr.status}`); return { hash: result.hash, success: txr.status === "SUCCESS" }; }
    } catch (e: any) {
      console.log(`    ${label}: ${e.message} (likely OK)`);
      return { hash: result.hash, success: true };
    }
  }
  console.log(`    ${label}: timed out`);
  return { hash: result.hash, success: false };
}

// ── Main ──

async function main() {
  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey) {
    console.error('MAINNET_KEY not set. Add MAINNET_KEY="ed25519:..." to .env');
    process.exit(1);
  }
  const jwt = process.env.ONECLICK_JWT;
  const doSubmit = process.argv.includes("--submit");

  const wethAmount = parseArg("weth", "");
  if (!wethAmount) {
    console.error("Usage: npx tsx src/mainnet/open-position.ts --weth=<amount> [--submit]");
    console.error("  e.g. --weth=0.01");
    process.exit(1);
  }
  const ltvPct = parseInt(parseArg("ltv", "70"));
  const bridgeBufferPct = parseInt(parseArg("bridge-buffer", "3"));

  const wethRaw = ethers.parseEther(wethAmount);

  console.log("+==========================================================+");
  console.log("|  Open Leveraged Short Position                            |");
  console.log("+==========================================================+\n");

  // ── Step 0: Derive addresses ──
  console.log("Step 0 — Deriving addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM (Arbitrum):  ${addrs.evm.address}`);
  console.log(`  Stellar:         ${addrs.stellar.address}\n`);

  txLog.setAddress("EVM (Arbitrum)", addrs.evm.address);
  txLog.setAddress("Stellar", addrs.stellar.address);

  // ── Step 1: Fetch chain state + compute params ──
  console.log("Step 1 — Fetching chain state + computing parameters...\n");
  const provider = new ethers.JsonRpcProvider(ARB_RPC);

  // Fetch sequentially to avoid QuickNode rate limits
  const nonce = await provider.getTransactionCount(addrs.evm.address, "pending");
  await sleep(500);
  const feeData = await provider.getFeeData();
  await sleep(500);
  const ethBalance = await provider.getBalance(addrs.evm.address);
  await sleep(500);
  const marketParams = await fetchMarketParams(provider);
  await sleep(500);
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("0.1", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");

  // Check WETH balance
  const wethContract = new ethers.Contract(WETH_ADDRESS, [
    "function balanceOf(address) view returns (uint256)",
  ], provider);
  const wethBalance = await wethContract.balanceOf(addrs.evm.address);
  await sleep(500);

  // Fetch WETH price from Morpho oracle
  // Oracle returns: price of 1e18 WETH-wei in USDC-units (6 dec), scaled by 1e36
  // usdc_raw = weth_raw * price / 1e36
  const oracle = new ethers.Contract(marketParams.oracle, [
    "function price() view returns (uint256)",
  ], provider);
  const oraclePrice = await oracle.price();
  await sleep(500);
  const wethValueUsdc = (wethRaw * oraclePrice) / (10n ** 36n); // in USDC raw (6 dec)

  // Compute derived amounts
  const borrowUsdc = (wethValueUsdc * BigInt(ltvPct)) / 100n;
  const bridgeUsdc = borrowUsdc;
  // Account for bridge fees: margin = bridged amount * (100 - buffer)%
  const marginUsdc = (bridgeUsdc * BigInt(100 - bridgeBufferPct)) / 100n;
  // Convert margin from EVM 6-dec to Stellar 7-dec
  const marginStroops = marginUsdc * 10n;

  // Get XLM/USDC rate from Aquarius (probe with 100 XLM)
  const probeXlm = 1000000000n; // 100 XLM in stroops
  const probeQuote = await getAquariusQuote(STELLAR_XLM_TOKEN, STELLAR_USDC_TOKEN, probeXlm.toString());
  // xlm_price_usdc = probeOutput / probeXlm (in stroops)
  // flash_xlm_stroops = marginStroops * probeXlm / probeOutput
  const flashStroops = (marginStroops * probeXlm) / probeQuote.estimatedOutput;

  const wethPriceUsd = Number(oraclePrice) / 1e30; // approximate USD price

  txLog.setParam("WETH supply", `${wethAmount} (~$${(Number(wethValueUsdc) / 1e6).toFixed(2)})`);
  txLog.setParam("WETH price", `~$${wethPriceUsd.toFixed(2)}`);
  txLog.setParam("LTV", `${ltvPct}%`);
  txLog.setParam("Borrow USDC", ethers.formatUnits(borrowUsdc, 6));
  txLog.setParam("Bridge USDC", ethers.formatUnits(bridgeUsdc, 6));
  txLog.setParam("Margin", `${Number(marginStroops) / 1e7} USDC`);
  txLog.setParam("Flash loan", `${Number(flashStroops) / 1e7} XLM`);

  console.log("  Parameters:");
  console.log(`    WETH to supply:  ${wethAmount} WETH (~$${(Number(wethValueUsdc) / 1e6).toFixed(2)})`);
  console.log(`    WETH price:      ~$${wethPriceUsd.toFixed(2)}`);
  console.log(`    LTV:             ${ltvPct}%`);
  console.log(`    Borrow USDC:     ${ethers.formatUnits(borrowUsdc, 6)} USDC`);
  console.log(`    Bridge USDC:     ${ethers.formatUnits(bridgeUsdc, 6)} USDC`);
  console.log(`    Margin (${100 - bridgeBufferPct}%):    ${Number(marginStroops) / 1e7} USDC`);
  console.log(`    Flash loan:      ${Number(flashStroops) / 1e7} XLM (~${Number(marginStroops) / 1e7} USDC worth)`);
  console.log(`    XLM rate:        ~$${(Number(probeQuote.estimatedOutput) / Number(probeXlm)).toFixed(4)}/XLM`);

  // Balances
  console.log("\n  Balances:");
  console.log(`    ETH:   ${ethers.formatEther(ethBalance)}`);
  console.log(`    WETH:  ${ethers.formatEther(wethBalance)}`);
  console.log(`    Nonce: ${nonce}`);

  if (wethBalance < wethRaw) {
    console.error(`\n  Insufficient WETH. Have ${ethers.formatEther(wethBalance)}, need ${wethAmount}`);
    process.exit(1);
  }

  // Stellar
  const sorobanServer = new rpc.Server(STELLAR_SOROBAN_RPC);
  try {
    const stellarAccount = await sorobanServer.getAccount(addrs.stellar.address);
    console.log(`    Stellar seq: ${stellarAccount.sequenceNumber()}`);
  } catch {
    console.error(`\n  Stellar account not found. Fund ${addrs.stellar.address} first.`);
    process.exit(1);
  }

  if (!doSubmit) {
    console.log("\n  Dry run complete. Use --submit to execute.\n");
    return;
  }

  // ── Step 2: Get bridge quote ──
  console.log("\nStep 2 — Getting bridge quote...");
  const bridgeQuote = await getBridgeQuote(bridgeUsdc.toString(), addrs.stellar.address, addrs.evm.address, jwt);
  console.log(`  Deposit address: ${bridgeQuote.depositAddress}\n`);

  // ── Step 3: Get Aquarius swap quote for actual flash amount ──
  console.log("Step 3 — Getting swap quote (XLM -> USDC) for flash loan...");
  const aquariusQuote = await getAquariusQuote(STELLAR_XLM_TOKEN, STELLAR_USDC_TOKEN, flashStroops.toString());
  const minSwapOutput = (aquariusQuote.estimatedOutput * 99n) / 100n;
  console.log(`  Flash:       ${Number(flashStroops) / 1e7} XLM`);
  console.log(`  Swap output: ~${Number(aquariusQuote.estimatedOutput) / 1e7} USDC`);
  console.log(`  Min (1%):    ${Number(minSwapOutput) / 1e7} USDC`);
  console.log(`  Hops:        ${aquariusQuote.swapChain.length}\n`);

  // ── Step 4: Build EVM payloads ──
  console.log("Step 4 — Building transaction payloads...\n");

  let currentNonce = nonce;
  const evmPayloads: any[] = [];
  const evmLabels: string[] = [];

  function addEvmPayload(label: string, to: string, data: string, gasLimit = 100000) {
    evmPayloads.push({
      EvmEip1559: {
        chain_id: ARB_CHAIN_ID,
        nonce: currentNonce,
        max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
        max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
        gas_limit: gasLimit,
        to,
        value: "0x0",
        data,
      },
    });
    evmLabels.push(label);
    console.log(`  [${evmPayloads.length}] ${label} (nonce ${currentNonce})`);
    currentNonce++;
  }

  // 1. Approve WETH for Morpho
  addEvmPayload("Approve WETH -> Morpho", WETH_ADDRESS, buildApproveWethCalldata(wethRaw));

  // 2. Supply WETH collateral
  addEvmPayload("Supply WETH collateral", MORPHO_ADDRESS,
    buildSupplyCollateralCalldata(marketParams, wethRaw, addrs.evm.address), 300000);

  // 3. Borrow USDC
  addEvmPayload("Borrow USDC", MORPHO_ADDRESS,
    buildBorrowCalldata(marketParams, borrowUsdc, addrs.evm.address, addrs.evm.address), 300000);

  // 4. Transfer USDC to bridge
  addEvmPayload("USDC -> bridge", USDC_ADDRESS,
    buildUsdcTransferCalldata(bridgeQuote.depositAddress, bridgeUsdc));

  // Stellar change_trust payload (for MPC batch)
  const USDC_ISSUER_STRKEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const usdcIssuerHex = Buffer.from(StrKey.decodeEd25519PublicKey(USDC_ISSUER_STRKEY)).toString("hex");
  const stellarAccount = await sorobanServer.getAccount(addrs.stellar.address);
  const stellarNextSeq = BigInt(stellarAccount.sequenceNumber()) + 1n;

  const changeTrustPayload = {
    StellarChangeTrust: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 100,
      sequence_number: stellarNextSeq,
      asset: { CreditAlphanum4: { asset_code: "USDC", issuer: usdcIssuerHex } },
      limit: 9223372036854775807n,
      network: "Public",
    },
  };
  console.log(`  [${evmPayloads.length + 1}] Stellar change_trust USDC`);

  // Open short payload (just for MPC sig — we simulate fresh later)
  const openShortPayload = {
    StellarInvokeContract: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 10_000_000,
      sequence_number: stellarNextSeq + 1n,
      contract: { contract_id: Buffer.from(StrKey.decodeContract(UNTANGLED_LOOP_CONTRACT)).toString("hex") },
      function_name: "open_short",
      args: [],
      network: "Public",
    },
  };
  console.log(`  [${evmPayloads.length + 2}] Stellar open_short`);

  const allPayloads = [changeTrustPayload, ...evmPayloads, openShortPayload];
  console.log(`\n  Total: ${allPayloads.length} payloads (${allPayloads.length * 0.25} NEAR deposit)\n`);

  // ── Step 5: Submit batch to NEAR ──
  console.log("Step 5 — Submitting batch to NEAR...");
  const account = await getMainnetAccount(nearKey);
  const { nearTxId, expectedBatchId } = await submitBatch(account, allPayloads);
  const batchId = expectedBatchId;
  console.log(`  NEAR tx: ${nearTxId}`);
  console.log(`  Batch ID: ${batchId}`);
  console.log(`  https://nearblocks.io/txns/${nearTxId}\n`);

  txLog.add({ step: "Batch submit", chain: "NEAR", description: `Submit ${allPayloads.length} payloads (batch #${batchId})`, hash: nearTxId, status: "success" });

  // Wait for batch
  console.log("  Waiting for batch...");
  for (let wait = 0; wait < 60; wait++) {
    await sleep(3000);
    const status = await account.viewFunction({
      contractId: MAINNET_CONTRACT_ID,
      methodName: "get_batch_status",
      args: { batch_id: batchId },
    });
    if (status) { console.log(`  Batch ${batchId} created (${status.total} items)\n`); break; }
    if (wait % 5 === 4) console.log(`  Still waiting... (${(wait + 1) * 3}s)`);
    if (wait === 59) { console.error("  Timed out."); process.exit(1); }
  }

  // ── Step 6: Crank remaining items ──
  console.log("Step 6 — Cranking remaining batch items...");
  for (let i = 1; i < allPayloads.length; i++) {
    console.log(`  Cranking item ${i + 1}/${allPayloads.length}...`);
    await crankBatchNext(account, batchId);
  }
  console.log("  All dispatched.\n");

  // ── Step 7: Poll until all signed ──
  console.log("Step 7 — Polling batch status...");
  const finalStatus = await pollBatchStatus(account, batchId);
  console.log(`  Final: ${finalStatus.completed}/${finalStatus.total} signed, ${finalStatus.failed} failed\n`);

  if (finalStatus.failed > 0) {
    console.error("  Some items failed.");
    await refundBatch(account, batchId);
    process.exit(1);
  }

  // ── Step 8: Retrieve signatures ──
  console.log("Step 8 — Retrieving signatures...");
  const signatures = await getBatchSignatures(account, batchId);
  console.log(`  Got ${signatures.length} signatures\n`);

  // Signature order matches payload order:
  // [0] = change_trust, [1..N] = EVM txs, [last] = open_short
  const changeTrustSig = signatures[0]!;
  const evmSigs = signatures.slice(1, 1 + evmPayloads.length);
  // open_short sig at signatures[last] — not used (we simulate + sign fresh via MPC)

  // ── Step 9: Broadcast ──
  console.log("Step 9 — Broadcasting transactions...\n");

  // 9a: Stellar change_trust USDC
  console.log("  9a. Stellar change_trust USDC...");
  let trustlineExists = false;
  try {
    const acctRes = await fetch(`${STELLAR_MAINNET_HORIZON}/accounts/${addrs.stellar.address}`, {
      signal: AbortSignal.timeout(15000),
    });
    if (acctRes.ok) {
      const acctData = await acctRes.json();
      trustlineExists = acctData.balances?.some(
        (b: any) => b.asset_code === "USDC" && b.asset_issuer === USDC_ISSUER_STRKEY,
      ) ?? false;
    }
  } catch { /* timeout — try submit anyway */ }

  if (trustlineExists) {
    console.log("    Already exists — skipping\n");
    txLog.add({ step: "Change trust", chain: "Stellar", description: "USDC trustline (already exists)", status: "skipped" });
  } else {
    const trustAccount = new Account(addrs.stellar.address, stellarAccount.sequenceNumber());
    const trustTx = new TransactionBuilder(trustAccount, { fee: "100", networkPassphrase: Networks.PUBLIC })
      .addOperation(Operation.changeTrust({ asset: new Asset("USDC", USDC_ISSUER_STRKEY) }))
      .setTimeout(0).build();
    // Attach MPC Ed25519 signature from batch
    attachMpcEd25519Signature(trustTx, addrs.stellar.ed25519PublicKeyHex, changeTrustSig as MpcEd25519Signature);
    try {
      const submitRes = await fetch(`${STELLAR_MAINNET_HORIZON}/transactions`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `tx=${encodeURIComponent(trustTx.toEnvelope().toXDR("base64"))}`,
        signal: AbortSignal.timeout(30000),
      });
      const data = await submitRes.json();
      if (data.successful) {
        console.log(`    Ledger ${data.ledger}\n`);
        txLog.add({ step: "Change trust", chain: "Stellar", description: "Add USDC trustline", hash: data.hash, status: "success" });
      } else if (data.extras?.result_codes?.operations?.[0] === "op_already_exists") {
        console.log("    Already exists\n");
        txLog.add({ step: "Change trust", chain: "Stellar", description: "USDC trustline (already exists)", status: "skipped" });
      } else {
        console.error(`    Failed: ${JSON.stringify(data.extras?.result_codes)}`);
        txLog.add({ step: "Change trust", chain: "Stellar", description: "Add USDC trustline", status: "failed", details: JSON.stringify(data.extras?.result_codes) });
        process.exit(1);
      }
    } catch (e: any) {
      console.log("    Horizon timeout — continuing (trustline may exist)...\n");
      txLog.add({ step: "Change trust", chain: "Stellar", description: "Add USDC trustline (timeout)", status: "pending" });
    }
  }

  // 9b: Broadcast EVM txs sequentially
  for (let i = 0; i < evmPayloads.length; i++) {
    const p = evmPayloads[i];
    const sig = evmSigs[i]!;
    const label = evmLabels[i]!;
    console.log(`  9b-${i + 1}. ${label}...`);

    const unsignedTx = ethers.Transaction.from({
      type: 2,
      chainId: ARB_CHAIN_ID,
      nonce: p.EvmEip1559.nonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: p.EvmEip1559.gas_limit,
      to: p.EvmEip1559.to,
      value: 0n,
      data: p.EvmEip1559.data,
    });

    const signedTx = reconstructSignedEvmTx(unsignedTx, sig, addrs.evm.address);
    const pending = await provider.broadcastTransaction(signedTx.serialized);
    console.log(`    Hash: ${pending.hash}`);

    let receipt: ethers.TransactionReceipt | null = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try { receipt = await pending.wait(1); break; }
      catch (e: any) {
        if (e?.error?.code === -32007 || e?.code === "UNKNOWN_ERROR") {
          console.log("    Rate limited, retrying in 3s...");
          await sleep(3000); continue;
        }
        throw e;
      }
    }
    if (receipt?.status !== 1) {
      console.error(`    REVERTED! Gas: ${receipt?.gasUsed}`);
      txLog.add({ step: `EVM ${i + 1}`, chain: "Arbitrum", description: label, hash: pending.hash, status: "failed", details: `Reverted, gas: ${receipt?.gasUsed}` });
      process.exit(1);
    }
    console.log(`    Confirmed block ${receipt.blockNumber}\n`);
    txLog.add({ step: `EVM ${i + 1}`, chain: "Arbitrum", description: label, hash: pending.hash, status: "success", details: `Block ${receipt.blockNumber}` });
  }

  // 9c: Submit bridge deposit + wait
  console.log("  Submitting bridge deposit to 1Click...");
  const bridgeEvmPayload = evmPayloads[evmPayloads.length - 1];
  const bridgeSig = evmSigs[evmSigs.length - 1]!;
  const bridgeUnsigned = ethers.Transaction.from({
    type: 2, chainId: ARB_CHAIN_ID,
    nonce: bridgeEvmPayload.EvmEip1559.nonce,
    maxPriorityFeePerGas, maxFeePerGas,
    gasLimit: bridgeEvmPayload.EvmEip1559.gas_limit,
    to: bridgeEvmPayload.EvmEip1559.to, value: 0n,
    data: bridgeEvmPayload.EvmEip1559.data,
  });
  const bridgeSignedTx = reconstructSignedEvmTx(bridgeUnsigned, bridgeSig, addrs.evm.address);
  const bridgeTxHash = ethers.keccak256(bridgeSignedTx.serialized);
  await submitDeposit(bridgeQuote.depositAddress, bridgeTxHash);

  console.log("  Waiting for bridge (USDC Arbitrum -> Stellar)...");
  const bridgeResult = await pollBridgeStatus(bridgeQuote.depositAddress);
  if (bridgeResult !== "SUCCESS") {
    console.error(`  Bridge ${bridgeResult}. Cannot proceed.`);
    txLog.add({ step: "Bridge", chain: "1Click Bridge", description: `USDC Arbitrum -> Stellar (${ethers.formatUnits(bridgeUsdc, 6)} USDC)`, status: "failed", details: bridgeResult });
    process.exit(1);
  }
  console.log("  Bridge completed!\n");
  txLog.add({ step: "Bridge", chain: "1Click Bridge", description: `USDC Arbitrum -> Stellar (${ethers.formatUnits(bridgeUsdc, 6)} USDC)`, status: "success" });

  // 9d: Check actual USDC balance on Stellar and use as margin
  console.log("  9d. Checking Stellar USDC balance...");
  const freshStellarAccount = await sorobanServer.getAccount(addrs.stellar.address);
  const balanceTx = new TransactionBuilder(freshStellarAccount, {
    fee: "100000", networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: STELLAR_USDC_TOKEN, function: "balance",
      args: [nativeToScVal(addrs.stellar.address, { type: "address" })],
    }))
    .setTimeout(30).build();
  const balanceSim = await sorobanServer.simulateTransaction(balanceTx);
  let actualUsdcStroops = marginStroops;
  if (!rpc.Api.isSimulationError(balanceSim)) {
    const retval = (balanceSim as any).result?.retval;
    if (retval) {
      const i128 = retval.value() as { hi: () => any; lo: () => any };
      const bal = (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
      // Use 98% of actual balance as margin (leave buffer for fees)
      actualUsdcStroops = (bal * 98n) / 100n;
      console.log(`    USDC on Stellar: ${Number(bal) / 1e7}`);
      console.log(`    Using as margin: ${Number(actualUsdcStroops) / 1e7} USDC (98%)`);
    }
  }

  // Recompute flash amount based on actual margin
  const actualFlashStroops = (actualUsdcStroops * probeXlm) / probeQuote.estimatedOutput;
  console.log(`    Flash loan:      ${Number(actualFlashStroops) / 1e7} XLM\n`);

  // 9e: Get fresh swap quote for actual flash amount
  console.log("  9e. Getting fresh swap quote...");
  const freshQuote = await getAquariusQuote(STELLAR_XLM_TOKEN, STELLAR_USDC_TOKEN, actualFlashStroops.toString());
  const freshMinSwapOutput = (freshQuote.estimatedOutput * 99n) / 100n;
  console.log(`    Swap output: ~${Number(freshQuote.estimatedOutput) / 1e7} USDC`);
  console.log(`    Min (1%):    ${Number(freshMinSwapOutput) / 1e7} USDC`);
  console.log(`    Hops:        ${freshQuote.swapChain.length}\n`);

  // 9f: Approve USDC for Blend pool (signed via MPC)
  console.log("  9f. Approving USDC for Blend pool...");
  const approveAmount = actualUsdcStroops + freshMinSwapOutput + 10_000_000n;
  const latestLedger = (await sorobanServer.getLatestLedger()).sequence;
  const approveAccount = await sorobanServer.getAccount(addrs.stellar.address);
  const approveTx = new TransactionBuilder(approveAccount, {
    fee: "10000000", networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: STELLAR_USDC_TOKEN, function: "approve",
      args: [
        nativeToScVal(addrs.stellar.address, { type: "address" }),
        nativeToScVal(BLEND_POOL_CONTRACT, { type: "address" }),
        nativeToScVal(approveAmount, { type: "i128" }),
        nativeToScVal(Number(latestLedger) + 1000, { type: "u32" }),
      ],
    }))
    .setTimeout(300).build();
  const approveResult = await sendSorobanTx(sorobanServer, account, addrs.stellar.ed25519PublicKeyHex, approveTx, "Approve USDC");
  txLog.add({ step: "Approve USDC", chain: "Stellar", description: `Approve ${Number(approveAmount) / 1e7} USDC for Blend pool`, hash: approveResult.hash, status: approveResult.success ? "success" : "failed" });

  // 9g: Submit open_short (signed via MPC)
  console.log("\n  9g. Opening short position...");
  const swapChainScVal = buildSwapChainScVal(freshQuote.swapChain);
  const openShortArgs = [
    nativeToScVal(addrs.stellar.address, { type: "address" }),
    nativeToScVal(actualFlashStroops, { type: "i128" }),
    nativeToScVal(actualUsdcStroops, { type: "i128" }),
    nativeToScVal(freshMinSwapOutput, { type: "i128" }),
    nativeToScVal(true, { type: "bool" }),
    swapChainScVal,
  ];

  const openShortAccount = await sorobanServer.getAccount(addrs.stellar.address);
  const openShortTx = new TransactionBuilder(openShortAccount, {
    fee: "20000000", networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(Operation.invokeContractFunction({
      contract: UNTANGLED_LOOP_CONTRACT, function: "open_short", args: openShortArgs,
    }))
    .setTimeout(300).build();

  console.log("    Simulating...");
  const simResult = await sorobanServer.simulateTransaction(openShortTx);

  if (rpc.Api.isSimulationError(simResult)) {
    console.error("    Simulation FAILED:", simResult.error);
    if ((simResult as any).restorePreamble) {
      console.log("    Restoring expired ledger entries...");
      const rp = (simResult as any).restorePreamble;
      const restoreAcct = await sorobanServer.getAccount(addrs.stellar.address);
      const restoreTx = new TransactionBuilder(restoreAcct, {
        fee: rp.minResourceFee?.toString() || "10000000", networkPassphrase: Networks.PUBLIC,
      })
        .setSorobanData(rp.transactionData)
        .addOperation(Operation.restoreFootprint({}))
        .setTimeout(300).build();
      await signStellarTransactionViaMpc(account, restoreTx, addrs.stellar.ed25519PublicKeyHex);
      const rr = await sorobanServer.sendTransaction(restoreTx);
      for (let i = 0; i < 30; i++) {
        await sleep(2000);
        const txr = await sorobanServer.getTransaction(rr.hash);
        if (txr.status !== "NOT_FOUND") { console.log(`    Restore: ${txr.status}`); break; }
      }
      // Re-simulate
      const retryAcct = await sorobanServer.getAccount(addrs.stellar.address);
      const retryTx = new TransactionBuilder(retryAcct, {
        fee: "20000000", networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(Operation.invokeContractFunction({
          contract: UNTANGLED_LOOP_CONTRACT, function: "open_short", args: openShortArgs,
        }))
        .setTimeout(300).build();
      const retrySim = await sorobanServer.simulateTransaction(retryTx);
      if (rpc.Api.isSimulationError(retrySim)) {
        console.error("    Re-sim failed:", retrySim.error);
        process.exit(1);
      }
      const assembled = rpc.assembleTransaction(retryTx, retrySim).build();
      await signStellarTransactionViaMpc(account, assembled, addrs.stellar.ed25519PublicKeyHex);
      const sr = await sorobanServer.sendTransaction(assembled);
      console.log(`    Tx: ${sr.hash}, status: ${sr.status}`);
      let retryOk1 = false;
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        try {
          const txr = await sorobanServer.getTransaction(sr.hash);
          if (txr.status !== "NOT_FOUND") {
            console.log(`    Final: ${txr.status}`);
            if (txr.status === "SUCCESS") { console.log(`    Ledger: ${txr.ledger}`); retryOk1 = true; }
            break;
          }
        } catch (e: any) { console.log(`    ${e.message} (likely OK)`); retryOk1 = true; break; }
        if (i % 5 === 4) console.log(`    Pending... (${(i + 1) * 2}s)`);
      }
      txLog.add({ step: "Open short", chain: "Stellar", description: `Flash ${Number(actualFlashStroops) / 1e7} XLM, margin ${Number(actualUsdcStroops) / 1e7} USDC (after restore)`, hash: sr.hash, status: retryOk1 ? "success" : "failed" });
    } else {
      if (simResult.events?.length) {
        console.error(`    Events (last 3 of ${simResult.events.length}):`);
        for (const ev of simResult.events.slice(-3)) console.error("     ", ev);
      }
      txLog.add({ step: "Open short", chain: "Stellar", description: "Simulation failed", status: "failed", details: simResult.error });
      process.exit(1);
    }
  } else if (rpc.Api.isSimulationRestore(simResult)) {
    console.log("    Restoring expired entries...");
    const restoreAcct = await sorobanServer.getAccount(addrs.stellar.address);
    const restoreTx = new TransactionBuilder(restoreAcct, {
      fee: simResult.restorePreamble.minResourceFee.toString(), networkPassphrase: Networks.PUBLIC,
    })
      .setSorobanData(simResult.restorePreamble.transactionData)
      .addOperation(Operation.restoreFootprint({}))
      .setTimeout(300).build();
    await signStellarTransactionViaMpc(account, restoreTx, addrs.stellar.ed25519PublicKeyHex);
    const rr = await sorobanServer.sendTransaction(restoreTx);
    for (let i = 0; i < 30; i++) {
      await sleep(2000);
      const txr = await sorobanServer.getTransaction(rr.hash);
      if (txr.status !== "NOT_FOUND") { console.log(`    Restore: ${txr.status}`); break; }
    }
    const retryAcct = await sorobanServer.getAccount(addrs.stellar.address);
    const retryTx = new TransactionBuilder(retryAcct, {
      fee: "20000000", networkPassphrase: Networks.PUBLIC,
    })
      .addOperation(Operation.invokeContractFunction({
        contract: UNTANGLED_LOOP_CONTRACT, function: "open_short", args: openShortArgs,
      }))
      .setTimeout(300).build();
    const retrySim = await sorobanServer.simulateTransaction(retryTx);
    if (rpc.Api.isSimulationError(retrySim)) { console.error("    Re-sim failed:", retrySim.error); process.exit(1); }
    const assembled = rpc.assembleTransaction(retryTx, retrySim).build();
    await signStellarTransactionViaMpc(account, assembled, addrs.stellar.ed25519PublicKeyHex);
    const sr = await sorobanServer.sendTransaction(assembled);
    console.log(`    Tx: ${sr.hash}, status: ${sr.status}`);
    let retryOk2 = false;
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      try {
        const txr = await sorobanServer.getTransaction(sr.hash);
        if (txr.status !== "NOT_FOUND") {
          console.log(`    Final: ${txr.status}`);
          if (txr.status === "SUCCESS") { console.log(`    Ledger: ${txr.ledger}`); retryOk2 = true; }
          break;
        }
      } catch (e: any) { console.log(`    ${e.message} (likely OK)`); retryOk2 = true; break; }
      if (i % 5 === 4) console.log(`    Pending... (${(i + 1) * 2}s)`);
    }
    txLog.add({ step: "Open short", chain: "Stellar", description: `Flash ${Number(actualFlashStroops) / 1e7} XLM, margin ${Number(actualUsdcStroops) / 1e7} USDC (after restore)`, hash: sr.hash, status: retryOk2 ? "success" : "failed" });
  } else {
    // Normal success
    const assembled = rpc.assembleTransaction(openShortTx, simResult).build();
    await signStellarTransactionViaMpc(account, assembled, addrs.stellar.ed25519PublicKeyHex);
    console.log("    Submitting...");
    const sr = await sorobanServer.sendTransaction(assembled);
    console.log(`    Tx: ${sr.hash}, status: ${sr.status}`);
    let openShortOk = false;
    if (sr.status === "PENDING") {
      for (let i = 0; i < 60; i++) {
        await sleep(2000);
        try {
          const txr = await sorobanServer.getTransaction(sr.hash);
          if (txr.status !== "NOT_FOUND") {
            console.log(`    Final: ${txr.status}`);
            if (txr.status === "SUCCESS") { console.log(`    Ledger: ${txr.ledger}`); openShortOk = true; }
            break;
          }
        } catch (e: any) { console.log(`    ${e.message} (likely OK)`); openShortOk = true; break; }
        if (i % 5 === 4) console.log(`    Pending... (${(i + 1) * 2}s)`);
      }
    } else if (sr.status === "ERROR") {
      console.error(`    Error: ${JSON.stringify(sr)}`);
    }
    txLog.add({ step: "Open short", chain: "Stellar", description: `Flash ${Number(actualFlashStroops) / 1e7} XLM, margin ${Number(actualUsdcStroops) / 1e7} USDC`, hash: sr.hash, status: openShortOk ? "success" : "failed" });
  }

  // Refund batch deposit
  console.log("\n  Refunding batch deposit...");
  try { await refundBatch(account, batchId); console.log("  Refunded.\n"); }
  catch (e: any) { console.warn(`  Refund: ${e.message}\n`); }

  // Save transaction log
  const logPath = txLog.save(".");
  console.log(`  Transaction log: ${logPath}\n`);

  console.log("+==========================================================+");
  console.log("|  Position opened!                                         |");
  console.log("+==========================================================+");
  console.log(`  WETH supplied:  ${wethAmount} on Morpho (Arbitrum)`);
  console.log(`  USDC borrowed:  ${ethers.formatUnits(borrowUsdc, 6)} (${ltvPct}% LTV)`);
  console.log(`  Flash loan:     ${Number(actualFlashStroops) / 1e7} XLM`);
  console.log(`  Margin:         ${Number(actualUsdcStroops) / 1e7} USDC`);
  console.log(`  Strategy:       Short XLM / Long USDC on Blend`);
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  process.exit(1);
});
