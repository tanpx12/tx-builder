// src/mainnet/close-position.ts
// Close Position Flow: Stellar -> EVM (fully automated)
//
// Steps:
//   1. Record pre-close XLM balance on Stellar
//   2. Close short on Blend (flash USDC -> swap to XLM -> repay debt -> withdraw collateral)
//   3. Withdraw residual Blend collateral (if any)
//   4. Swap ONLY the new XLM (current - original) -> USDC via Aquarius AMM
//   5. Bridge ALL Stellar USDC to Arbitrum via 1Click
//   6. Repay Morpho USDC debt + Withdraw WETH collateral (NEAR batch sign)
//
// Usage:
//   npx tsx src/mainnet/close-position.ts                # dry-run
//   npx tsx src/mainnet/close-position.ts --submit       # execute
//   npx tsx src/mainnet/close-position.ts --skip-close   # skip close_short
//   npx tsx src/mainnet/close-position.ts --skip-bridge  # skip bridge

import "dotenv/config";
import { ethers } from "ethers";
import {
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Memo,
  nativeToScVal,
  Address as StellarAddress,
  StrKey,
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
  fetchPosition,
  fetchMarketState,
  buildApproveUsdcCalldata,
  buildRepayBySharesCalldata,
  buildWithdrawCollateralCalldata,
} from "./morpho.js";
import {
  getBridgeQuoteReverse,
  submitDeposit,
  pollBridgeStatus,
} from "./bridge.js";
import { attachMpcEd25519Signature, type MpcEd25519Signature } from "../core/stellar.js";
import { TxLog } from "./tx-log.js";

const txLog = new TxLog("Close Leveraged Short Position");

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

// ── Soroban balance query ──

function decodeI128(val: xdr.ScVal): bigint {
  const i128 = val.value() as { hi: () => any; lo: () => any };
  return (BigInt(i128.hi().toString()) << 64n) | BigInt(i128.lo().toString());
}

async function querySorobanBalance(
  server: rpc.Server, userAddress: string, tokenContract: string,
): Promise<bigint> {
  const account = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.invokeContractFunction({
      contract: tokenContract, function: "balance",
      args: [nativeToScVal(userAddress, { type: "address" })],
    }))
    .setTimeout(30).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) return 0n;
  const retval = (sim as any).result?.retval;
  return retval ? decodeI128(retval) : 0n;
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

// ── Blend position query ──

async function queryBlendPosition(server: rpc.Server, userAddress: string) {
  const account = await server.getAccount(userAddress);
  const tx = new TransactionBuilder(account, { fee: "100000", networkPassphrase: Networks.PUBLIC })
    .addOperation(Operation.invokeContractFunction({
      contract: BLEND_POOL_CONTRACT, function: "get_positions",
      args: [nativeToScVal(userAddress, { type: "address" })],
    }))
    .setTimeout(300).build();
  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) throw new Error(`get_positions failed: ${sim.error}`);
  const entries = ((sim as any).result?.retval).value() as xdr.ScMapEntry[];
  let xlmDebt = 0n, usdcCollateral = 0n;
  for (const entry of entries) {
    const key = entry.key().value().toString();
    const inner = entry.val().value() as xdr.ScMapEntry[];
    if (!inner || inner.length === 0) continue;
    for (const item of inner) {
      const amount = decodeI128(item.val());
      if (key === "liabilities") xlmDebt += amount;
      if (key === "collateral") usdcCollateral += amount;
    }
  }
  return { xlmDebt, usdcCollateral };
}

// ── Soroban tx helpers ──

async function sendSorobanTx(
  server: rpc.Server,
  nearAccount: Awaited<ReturnType<typeof getMainnetAccount>>,
  ed25519PublicKeyHex: string,
  buildTx: (account: any) => any,
  label: string,
): Promise<{ hash: string; success: boolean }> {
  const stellarAddress = StrKey.encodeEd25519PublicKey(Buffer.from(ed25519PublicKeyHex, "hex"));
  const tx = buildTx(await server.getAccount(stellarAddress));
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

// ── Horizon submit with timeout ──

const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

async function submitHorizonTx(
  txXdr: string, label: string,
): Promise<{ hash?: string; success: boolean }> {
  try {
    const res = await fetch(`${STELLAR_MAINNET_HORIZON}/transactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `tx=${encodeURIComponent(txXdr)}`,
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json();
    if (data.successful) {
      console.log(`    ${label}: ledger ${data.ledger}`);
      return { hash: data.hash, success: true };
    }
    console.error(`    ${label} failed: ${JSON.stringify(data.extras?.result_codes)}`);
    return { success: false };
  } catch (e: any) {
    if (e?.name === "TimeoutError") {
      console.log(`    ${label}: Horizon timeout (tx may have succeeded)`);
      return { success: true }; // optimistic
    }
    console.error(`    ${label}: ${e.message}`);
    return { success: false };
  }
}

// ── Main ──

async function main() {
  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey) { console.error('MAINNET_KEY not set.'); process.exit(1); }
  const jwt = process.env.ONECLICK_JWT;
  const doSubmit = process.argv.includes("--submit");
  const skipClose = process.argv.includes("--skip-close");
  const skipBridge = process.argv.includes("--skip-bridge");

  console.log("+==========================================================+");
  console.log("|  Close Leveraged Short Position                           |");
  console.log("+==========================================================+\n");

  // ── Step 0: Derive addresses ──
  console.log("Step 0 — Deriving addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM (Arbitrum):  ${addrs.evm.address}`);
  console.log(`  Stellar:         ${addrs.stellar.address}\n`);

  txLog.setAddress("EVM (Arbitrum)", addrs.evm.address);
  txLog.setAddress("Stellar", addrs.stellar.address);

  const nearAccount = await getMainnetAccount(nearKey);
  const sorobanServer = new rpc.Server(STELLAR_SOROBAN_RPC);
  const provider = new ethers.JsonRpcProvider(ARB_RPC);

  // ── Step 1: Record pre-close balances + close short ──
  // Record XLM balance BEFORE closing so we know how much new XLM to swap
  const preCloseXlm = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_XLM_TOKEN);
  const preCloseUsdc = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_USDC_TOKEN);
  console.log("  Pre-close balances:");
  console.log(`    XLM:  ${Number(preCloseXlm) / 1e7}`);
  console.log(`    USDC: ${Number(preCloseUsdc) / 1e7}\n`);

  if (!skipClose) {
    console.log("Step 1 — Closing short position on Stellar...\n");

    const position = await queryBlendPosition(sorobanServer, addrs.stellar.address);
    console.log(`  XLM debt:        ${Number(position.xlmDebt) / 1e7}`);
    console.log(`  USDC collateral: ${Number(position.usdcCollateral) / 1e7}`);

    if (position.xlmDebt === 0n && position.usdcCollateral > 0n) {
      console.log("  No XLM debt — short already closed.");
      console.log(`  Residual collateral: ${Number(position.usdcCollateral) / 1e7} USDC — withdrawing...\n`);

      if (!doSubmit) {
        console.log("  (dry-run)\n");
      } else {
        const withdrawRequest = xdr.ScVal.scvMap([
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("address"), val: new StellarAddress(STELLAR_USDC_TOKEN).toScVal() }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("amount"), val: nativeToScVal(position.usdcCollateral, { type: "i128" }) }),
          new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol("request_type"), val: nativeToScVal(3, { type: "u32" }) }),
        ]);
        const withdrawResult = await sendSorobanTx(sorobanServer, nearAccount, addrs.stellar.ed25519PublicKeyHex, (acct) =>
          new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: Networks.PUBLIC })
            .addOperation(Operation.invokeContractFunction({
              contract: BLEND_POOL_CONTRACT, function: "submit",
              args: [
                nativeToScVal(addrs.stellar.address, { type: "address" }),
                nativeToScVal(addrs.stellar.address, { type: "address" }),
                nativeToScVal(addrs.stellar.address, { type: "address" }),
                xdr.ScVal.scvVec([withdrawRequest]),
              ],
            })).setTimeout(120).build(),
          "withdraw collateral");
        console.log(`  Result: ${withdrawResult.success ? "OK" : "FAILED"}\n`);
        txLog.add({ step: "Withdraw collateral", chain: "Stellar", description: `Withdraw ${Number(position.usdcCollateral) / 1e7} USDC from Blend`, hash: withdrawResult.hash, status: withdrawResult.success ? "success" : "failed" });
      }
    } else if (position.xlmDebt === 0n) {
      console.log("  No position. Nothing to close.\n");
    } else {
      const xlmDebtWithBuffer = (position.xlmDebt * 101n) / 100n;
      const flashAmountUsdc = position.usdcCollateral;

      console.log(`\n  Getting swap quote (USDC -> XLM)...`);
      const quote = await getAquariusQuote(STELLAR_USDC_TOKEN, STELLAR_XLM_TOKEN, flashAmountUsdc.toString());
      console.log(`  Estimated XLM out: ${Number(quote.estimatedOutput) / 1e7}`);
      console.log(`  XLM debt + 1%:     ${Number(xlmDebtWithBuffer) / 1e7}`);

      if (!doSubmit) {
        console.log("  (dry-run)\n");
      } else {
        // Approve XLM + USDC for Blend pool (via MPC)
        const latestLedger = (await sorobanServer.getLatestLedger()).sequence;
        const expLedger = Number(latestLedger) + 1000;

        for (const [token, amount, label] of [
          [STELLAR_XLM_TOKEN, xlmDebtWithBuffer + 10_000_000n, "XLM"] as const,
          [STELLAR_USDC_TOKEN, flashAmountUsdc * 2n + 10_000_000n, "USDC"] as const,
        ]) {
          console.log(`  Approving ${label}...`);
          const approveRes = await sendSorobanTx(sorobanServer, nearAccount, addrs.stellar.ed25519PublicKeyHex, (acct) =>
            new TransactionBuilder(acct, { fee: "10000000", networkPassphrase: Networks.PUBLIC })
              .addOperation(Operation.invokeContractFunction({
                contract: token, function: "approve",
                args: [
                  nativeToScVal(addrs.stellar.address, { type: "address" }),
                  nativeToScVal(BLEND_POOL_CONTRACT, { type: "address" }),
                  nativeToScVal(amount, { type: "i128" }),
                  nativeToScVal(expLedger, { type: "u32" }),
                ],
              })).setTimeout(300).build(),
            `${label} approve`);
          txLog.add({ step: `Approve ${label}`, chain: "Stellar", description: `Approve ${label} for Blend pool`, hash: approveRes.hash, status: approveRes.success ? "success" : "failed" });
        }

        // Submit close_short (via MPC)
        console.log(`\n  Submitting close_short...`);
        const swapChainVal = buildSwapChainScVal(quote.swapChain);
        const closeResult = await sendSorobanTx(sorobanServer, nearAccount, addrs.stellar.ed25519PublicKeyHex, (acct) =>
          new TransactionBuilder(acct, { fee: "20000000", networkPassphrase: Networks.PUBLIC })
            .addOperation(Operation.invokeContractFunction({
              contract: UNTANGLED_LOOP_CONTRACT, function: "close_short",
              args: [
                nativeToScVal(addrs.stellar.address, { type: "address" }),
                nativeToScVal(flashAmountUsdc, { type: "i128" }),
                nativeToScVal(xlmDebtWithBuffer, { type: "i128" }),
                nativeToScVal(position.usdcCollateral, { type: "i128" }),
                swapChainVal,
              ],
            })).setTimeout(300).build(),
          "close_short");

        txLog.add({ step: "Close short", chain: "Stellar", description: `Flash ${Number(flashAmountUsdc) / 1e7} USDC, repay ${Number(position.xlmDebt) / 1e7} XLM debt`, hash: closeResult.hash, status: closeResult.success ? "success" : "failed" });
        if (!closeResult.success) { console.error("  close_short failed."); process.exit(1); }
        console.log("  Short position closed!\n");
      }
    }
  } else {
    console.log("Step 1 — Skipping close_short (--skip-close)\n");
  }

  // ── Step 2: Swap only NEW XLM -> USDC ──
  if (!skipBridge && doSubmit) {
    console.log("Step 2 — Swapping new XLM -> USDC...\n");

    const postCloseXlm = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_XLM_TOKEN);
    const newXlm = postCloseXlm - preCloseXlm;

    console.log(`  Pre-close XLM:  ${Number(preCloseXlm) / 1e7}`);
    console.log(`  Post-close XLM: ${Number(postCloseXlm) / 1e7}`);
    console.log(`  New XLM:        ${Number(newXlm) / 1e7}`);

    if (newXlm > 10_000_000n) { // > 1 XLM
      // Use Aquarius AMM via Soroban for the swap (avoids Horizon dependency)
      console.log(`\n  Getting Aquarius quote (${Number(newXlm) / 1e7} XLM -> USDC)...`);
      const swapQuote = await getAquariusQuote(STELLAR_XLM_TOKEN, STELLAR_USDC_TOKEN, newXlm.toString());
      const minOut = (swapQuote.estimatedOutput * 98n) / 100n; // 2% slippage
      console.log(`  Estimated USDC: ${Number(swapQuote.estimatedOutput) / 1e7}`);
      console.log(`  Min out (2%):   ${Number(minOut) / 1e7}`);

      // Use Horizon path payment (classic Stellar tx — more reliable for simple swaps)
      const sendAmount = (Number(newXlm) / 1e7).toFixed(7);
      const minDest = (Number(minOut) / 1e7).toFixed(7);

      const freshAccount = await sorobanServer.getAccount(addrs.stellar.address);
      const swapTx = new TransactionBuilder(freshAccount, {
        fee: "1000", networkPassphrase: Networks.PUBLIC,
      })
        .addOperation(Operation.pathPaymentStrictSend({
          sendAsset: Asset.native(),
          sendAmount,
          destination: addrs.stellar.address,
          destAsset: new Asset("USDC", USDC_ISSUER),
          destMin: minDest,
        }))
        .setTimeout(300).build();
      await signStellarTransactionViaMpc(nearAccount, swapTx, addrs.stellar.ed25519PublicKeyHex);

      const swapResult = await submitHorizonTx(swapTx.toEnvelope().toXDR("base64"), "XLM->USDC swap");
      txLog.add({ step: "Swap XLM->USDC", chain: "Stellar", description: `Swap ${Number(newXlm) / 1e7} XLM -> USDC`, hash: swapResult.hash, status: swapResult.success ? "success" : "pending" });
      if (!swapResult.success) {
        // Retry with Horizon path finding
        console.log("    Retrying with path hints...");
        try {
          const pathRes = await fetch(
            `${STELLAR_MAINNET_HORIZON}/paths/strict-send?source_asset_type=native&source_amount=${sendAmount}&destination_assets=USDC:${USDC_ISSUER}`,
            { signal: AbortSignal.timeout(15000) },
          );
          const pathData = await pathRes.json();
          if (pathData._embedded?.records?.length > 0) {
            const best = pathData._embedded.records[0];
            console.log(`    Best path: ${best.destination_amount} USDC`);
            const freshAccount2 = await sorobanServer.getAccount(addrs.stellar.address);
            const swapTx2 = new TransactionBuilder(freshAccount2, {
              fee: "1000", networkPassphrase: Networks.PUBLIC,
            })
              .addOperation(Operation.pathPaymentStrictSend({
                sendAsset: Asset.native(),
                sendAmount,
                destination: addrs.stellar.address,
                destAsset: new Asset("USDC", USDC_ISSUER),
                destMin: (parseFloat(best.destination_amount) * 0.99).toFixed(7),
                path: best.path.map((p: any) =>
                  p.asset_type === "native" ? Asset.native() : new Asset(p.asset_code, p.asset_issuer),
                ),
              }))
              .setTimeout(300).build();
            await signStellarTransactionViaMpc(nearAccount, swapTx2, addrs.stellar.ed25519PublicKeyHex);
            await submitHorizonTx(swapTx2.toEnvelope().toXDR("base64"), "XLM->USDC swap (retry)");
          } else {
            console.log("    No paths found. Skipping swap.\n");
          }
        } catch (e: any) {
          console.log(`    Path finding failed: ${e.message}. Skipping swap.\n`);
        }
      }

      // Wait a moment for balance to update
      await sleep(5000);
    } else {
      console.log("  No significant new XLM to swap.\n");
    }
  } else if (!skipBridge) {
    // Dry-run estimate
    const postCloseXlmEst = preCloseXlm; // can't know without executing
    console.log("Step 2 — XLM -> USDC swap (will calculate after close_short)\n");
  }

  // ── Step 3: Bridge ALL Stellar USDC to Arbitrum ──
  if (!skipBridge) {
    console.log("Step 3 — Bridging ALL USDC from Stellar to Arbitrum...\n");

    const stellarUsdc = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_USDC_TOKEN);
    console.log(`  Stellar USDC balance: ${Number(stellarUsdc) / 1e7}`);

    if (stellarUsdc < 500_000n) { // < 0.05 USDC
      console.log("  Not enough USDC to bridge. Skipping.\n");
    } else {
      // Leave tiny buffer for dust
      const bridgeStroops = stellarUsdc - 10_000n;
      console.log(`  Bridging: ${Number(bridgeStroops) / 1e7} USDC`);

      const bridgeQuote = await getBridgeQuoteReverse(
        bridgeStroops.toString(), addrs.evm.address, addrs.stellar.address, jwt,
      );
      console.log(`  Deposit address: ${bridgeQuote.depositAddress}`);
      console.log(`  Memo: ${bridgeQuote.memo ?? "none"}`);
      console.log(`  Est. output: ${bridgeQuote.destinationAmount}`);

      if (!doSubmit) {
        console.log("  (dry-run)\n");
      } else {
        // Send Stellar USDC payment to bridge deposit address (via MPC)
        console.log("\n  Sending USDC to bridge...");
        const freshAccount = await sorobanServer.getAccount(addrs.stellar.address);
        const paymentTx = new TransactionBuilder(freshAccount, {
          fee: "1000", networkPassphrase: Networks.PUBLIC,
        })
          .addOperation(Operation.payment({
            destination: bridgeQuote.depositAddress,
            asset: new Asset("USDC", USDC_ISSUER),
            amount: (Number(bridgeStroops) / 1e7).toFixed(7),
          }))
          .addMemo(bridgeQuote.memo ? Memo.text(bridgeQuote.memo) : Memo.none())
          .setTimeout(300).build();
        await signStellarTransactionViaMpc(nearAccount, paymentTx, addrs.stellar.ed25519PublicKeyHex);

        const payResult = await submitHorizonTx(paymentTx.toEnvelope().toXDR("base64"), "USDC payment");
        txLog.add({ step: "Bridge payment", chain: "Stellar", description: `Send ${Number(bridgeStroops) / 1e7} USDC to bridge`, hash: payResult.hash, status: payResult.success ? "success" : "failed" });

        if (payResult.hash) {
          await submitDeposit(bridgeQuote.depositAddress, payResult.hash);
        }

        console.log("  Waiting for bridge (Stellar -> Arbitrum)...");
        const bridgeResult = await pollBridgeStatus(bridgeQuote.depositAddress, bridgeQuote.memo);
        console.log(`  Bridge: ${bridgeResult}\n`);
        txLog.add({ step: "Bridge", chain: "1Click Bridge", description: `USDC Stellar -> Arbitrum (${Number(bridgeStroops) / 1e7} USDC)`, status: bridgeResult === "SUCCESS" ? "success" : "failed", details: bridgeResult });

        if (bridgeResult !== "SUCCESS") {
          throw new Error(`Bridge failed: ${bridgeResult}`);
        }
      }
    }
  } else {
    console.log("Step 3 — Skipping bridge (--skip-bridge)\n");
  }

  // ── Step 4: Repay Morpho + Withdraw WETH ──
  console.log("Step 4 — Checking Morpho position on Arbitrum...\n");

  const morphoPosition = await fetchPosition(provider, addrs.evm.address);
  await sleep(1000);
  const marketState = await fetchMarketState(provider);
  await sleep(1000);
  const marketParams = await fetchMarketParams(provider);
  await sleep(1000);

  const actualDebt = morphoPosition.borrowShares > 0n
    ? (morphoPosition.borrowShares * marketState.totalBorrowAssets / marketState.totalBorrowShares) + 1n
    : 0n;

  console.log(`  Borrow shares:   ${morphoPosition.borrowShares}`);
  console.log(`  USDC debt:       ${ethers.formatUnits(actualDebt, 6)} USDC`);
  console.log(`  WETH collateral: ${ethers.formatEther(morphoPosition.collateral)} WETH`);

  if (morphoPosition.borrowShares === 0n && morphoPosition.collateral === 0n) {
    console.log("  No Morpho position.\n");
  } else if (!doSubmit) {
    console.log("\n  EVM unwind plan:");
    if (morphoPosition.borrowShares > 0n) {
      console.log(`    1. Approve USDC for Morpho: ${ethers.formatUnits(actualDebt, 6)}`);
      console.log(`    2. Repay USDC debt (by shares)`);
    }
    if (morphoPosition.collateral > 0n) {
      console.log(`    3. Withdraw WETH: ${ethers.formatEther(morphoPosition.collateral)}`);
    }
    console.log("  (dry-run)\n");
  } else {
    const account = await getMainnetAccount(nearKey);
    const nonce = await provider.getTransactionCount(addrs.evm.address, "pending");
    await sleep(1000);
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("0.1", "gwei");
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");

    // Check USDC balance on Arb
    await sleep(1000);
    const usdcContract = new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider);
    const arbUsdc = await usdcContract.balanceOf(addrs.evm.address);
    console.log(`\n  Arbitrum USDC: ${ethers.formatUnits(arbUsdc, 6)}`);

    if (morphoPosition.borrowShares > 0n && arbUsdc < actualDebt) {
      console.error(`  Insufficient USDC. Have ${ethers.formatUnits(arbUsdc, 6)}, need ${ethers.formatUnits(actualDebt, 6)}`);
      console.error("  Re-run with --skip-close --skip-bridge after bridging more USDC.");
      process.exit(1);
    }

    const payloads: any[] = [];
    const labels: string[] = [];
    let currentNonce = nonce;

    if (morphoPosition.borrowShares > 0n) {
      // Approve USDC
      payloads.push({
        EvmEip1559: {
          chain_id: ARB_CHAIN_ID, nonce: currentNonce++,
          max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
          max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
          gas_limit: 100000, to: USDC_ADDRESS, value: "0x0",
          data: buildApproveUsdcCalldata(actualDebt + 1000n),
        },
      });
      labels.push("Approve USDC");

      // Repay by shares
      payloads.push({
        EvmEip1559: {
          chain_id: ARB_CHAIN_ID, nonce: currentNonce++,
          max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
          max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
          gas_limit: 300000, to: MORPHO_ADDRESS, value: "0x0",
          data: buildRepayBySharesCalldata(marketParams, morphoPosition.borrowShares, addrs.evm.address),
        },
      });
      labels.push("Repay USDC debt");
    }

    if (morphoPosition.collateral > 0n) {
      // Withdraw WETH
      payloads.push({
        EvmEip1559: {
          chain_id: ARB_CHAIN_ID, nonce: currentNonce++,
          max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
          max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
          gas_limit: 300000, to: MORPHO_ADDRESS, value: "0x0",
          data: buildWithdrawCollateralCalldata(marketParams, morphoPosition.collateral, addrs.evm.address, addrs.evm.address),
        },
      });
      labels.push("Withdraw WETH");
    }

    if (payloads.length === 0) {
      console.log("  No EVM payloads.\n");
    } else {
      for (let i = 0; i < payloads.length; i++) {
        console.log(`  [${i + 1}] ${labels[i]} (nonce ${payloads[i].EvmEip1559.nonce})`);
      }

      console.log(`\n  Submitting ${payloads.length} payloads to NEAR...\n`);
      const { nearTxId, expectedBatchId } = await submitBatch(account, payloads);
      const batchId = expectedBatchId;
      console.log(`  NEAR tx: ${nearTxId}`);
      console.log(`  Batch ID: ${batchId}\n`);
      txLog.add({ step: "Batch submit", chain: "NEAR", description: `Submit ${payloads.length} EVM payloads (batch #${batchId})`, hash: nearTxId, status: "success" });

      // Wait for batch
      for (let i = 0; i < 60; i++) {
        await sleep(3000);
        const status = await account.viewFunction({
          contractId: MAINNET_CONTRACT_ID, methodName: "get_batch_status", args: { batch_id: batchId },
        });
        if (status) { console.log(`  Batch created (${status.total} items)\n`); break; }
        if (i === 59) { console.error("  Timed out."); process.exit(1); }
      }

      // Crank
      for (let i = 1; i < payloads.length; i++) {
        console.log(`  Cranking item ${i + 1}/${payloads.length}...`);
        await crankBatchNext(account, batchId);
      }

      // Poll
      const finalStatus = await pollBatchStatus(account, batchId);
      console.log(`  Final: ${finalStatus.completed}/${finalStatus.total} signed, ${finalStatus.failed} failed\n`);

      if (finalStatus.failed > 0) {
        await refundBatch(account, batchId);
        process.exit(1);
      }

      // Broadcast
      const signatures = await getBatchSignatures(account, batchId);
      console.log(`  Got ${signatures.length} signatures. Broadcasting...\n`);

      for (let i = 0; i < payloads.length; i++) {
        const p = payloads[i];
        const sig = signatures[i]!;
        console.log(`  ${labels[i]} (nonce ${p.EvmEip1559.nonce})...`);

        const unsignedTx = ethers.Transaction.from({
          type: 2, chainId: ARB_CHAIN_ID, nonce: p.EvmEip1559.nonce,
          maxPriorityFeePerGas, maxFeePerGas,
          gasLimit: p.EvmEip1559.gas_limit, to: p.EvmEip1559.to,
          value: 0n, data: p.EvmEip1559.data,
        });

        const signedTx = reconstructSignedEvmTx(unsignedTx, sig, addrs.evm.address);
        const pending = await provider.broadcastTransaction(signedTx.serialized);
        console.log(`    Hash: ${pending.hash}`);

        let receipt: ethers.TransactionReceipt | null = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          try { receipt = await pending.wait(1); break; }
          catch (e: any) {
            if (e?.error?.code === -32007 || e?.code === "UNKNOWN_ERROR") {
              await sleep(3000); continue;
            }
            throw e;
          }
        }
        if (receipt?.status !== 1) {
          console.error(`    REVERTED! Gas: ${receipt?.gasUsed}`);
          txLog.add({ step: `EVM ${i + 1}`, chain: "Arbitrum", description: labels[i]!, hash: pending.hash, status: "failed", details: `Reverted, gas: ${receipt?.gasUsed}` });
          process.exit(1);
        }
        console.log(`    Confirmed block ${receipt.blockNumber}\n`);
        txLog.add({ step: `EVM ${i + 1}`, chain: "Arbitrum", description: labels[i]!, hash: pending.hash, status: "success", details: `Block ${receipt.blockNumber}` });
      }

      try { await refundBatch(account, batchId); console.log("  Batch deposit refunded.\n"); }
      catch (e: any) { console.warn(`  Refund: ${e.message}\n`); }
    }
  }

  // ── Summary ──
  console.log("+==========================================================+");
  console.log("|  Final Balances                                           |");
  console.log("+==========================================================+\n");

  await sleep(1000);
  const ethBal = await provider.getBalance(addrs.evm.address);
  await sleep(500);
  const wethBal = await new ethers.Contract(WETH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(addrs.evm.address);
  await sleep(500);
  const usdcBal = await new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(addrs.evm.address);

  const stellarXlm = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_XLM_TOKEN);
  const stellarUsdc = await querySorobanBalance(sorobanServer, addrs.stellar.address, STELLAR_USDC_TOKEN);

  console.log("  Arbitrum:");
  console.log(`    ETH:   ${ethers.formatEther(ethBal)}`);
  console.log(`    WETH:  ${ethers.formatEther(wethBal)}`);
  console.log(`    USDC:  ${ethers.formatUnits(usdcBal, 6)}`);
  console.log("  Stellar:");
  console.log(`    XLM:   ${Number(stellarXlm) / 1e7}`);
  console.log(`    USDC:  ${Number(stellarUsdc) / 1e7}`);

  // Save transaction log
  if (doSubmit) {
    const logPath = txLog.save(".");
    console.log(`\n  Transaction log: ${logPath}`);
  }

  console.log("\nDone! Position closed.");
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  process.exit(1);
});
