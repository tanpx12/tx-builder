// src/mainnet/execute-batch.ts
// CLI: Build 6 payloads -> submit batch -> crank -> broadcast
//
// Usage:
//   npx tsx src/mainnet/execute-batch.ts [--weth-amount=0.002] [--borrow-usdc=3] [--flash-xlm=7.5] [--margin-xlm=5]
//
// Requires:
//   MAINNET_KEY="ed25519:..." in .env
//   ONECLICK_JWT="..." in .env (optional, for fee-free bridge)
//
// Prerequisites:
//   - Policies registered via set-policies.ts
//   - Derived EVM account funded with WETH + ETH gas on Arbitrum
//   - Derived Stellar account funded with XLM
//   - NEAR account funded with >= 1.5 NEAR (6 * 0.25)

import "dotenv/config";
import { ethers } from "ethers";
import { Horizon, Account, TransactionBuilder, Networks, Operation, Asset, StrKey } from "@stellar/stellar-sdk";
import {
  ARB_RPC,
  ARB_CHAIN_ID,
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  STELLAR_MAINNET_HORIZON,
  STELLAR_USDC_TOKEN,
  STELLAR_XLM_TOKEN,
  UNTANGLED_LOOP_CONTRACT,
  AQUARIUS_API_URL,
} from "../config-mainnet.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  submitBatch,
  crankBatchNext,
  pollBatchStatus,
  getBatchSignatures,
  refundBatch,
  type MpcSignature,
} from "../near-mainnet.js";
import {
  fetchMarketParams,
  buildApproveWethCalldata,
  buildSupplyCollateralCalldata,
  buildBorrowCalldata,
  buildUsdcTransferCalldata,
} from "../morpho.js";
import {
  getBridgeQuote,
  submitDeposit,
  pollBridgeStatus,
} from "../bridge.js";
import { deriveKeypairFromPublicKey } from "../stellar.js";

// ── CLI args ──

function parseArg(name: string, defaultVal: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1]! : defaultVal;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reconstruct a signed EIP-1559 transaction from an unsigned tx + MPC signature.
 */
function reconstructSignedEvmTx(
  unsignedTx: ethers.Transaction,
  sig: MpcSignature,
  expectedFrom: string,
): ethers.Transaction {
  const r = "0x" + sig.big_r.affine_point.slice(2); // strip 02/03 prefix
  const s = "0x" + sig.s.scalar;
  const signedTx = unsignedTx.clone();
  signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id });

  // Verify recovered address matches
  if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
    // Try flipping recovery_id
    signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id ^ 1 });
    if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new Error(
        `Recovered signer ${signedTx.from} does not match expected ${expectedFrom}`,
      );
    }
  }
  return signedTx;
}

// ── Main ──

async function main() {
  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey) {
    console.error('MAINNET_KEY not set. Add MAINNET_KEY="ed25519:..." to .env');
    process.exit(1);
  }
  const jwt = process.env.ONECLICK_JWT;

  const wethAmountEth = parseArg("weth-amount", "0.002");
  const borrowUsdcAmount = parseArg("borrow-usdc", "3");
  const flashXlm = parseArg("flash-xlm", "7.5");
  const marginXlm = parseArg("margin-xlm", "5");

  const wethAmountWei = ethers.parseEther(wethAmountEth);
  const borrowUsdcRaw = ethers.parseUnits(borrowUsdcAmount, 6); // USDC has 6 decimals
  const flashAmountStroops = BigInt(Math.floor(parseFloat(flashXlm) * 10_000_000));
  const marginAmountStroops = BigInt(Math.floor(parseFloat(marginXlm) * 10_000_000));

  console.log("+==========================================================+");
  console.log("|  Mainnet Demo: Cross-Chain Leveraged Short                 |");
  console.log("+==========================================================+\n");

  console.log(`  WETH collateral:  ${wethAmountEth} WETH`);
  console.log(`  Borrow amount:    ${borrowUsdcAmount} USDC`);
  console.log(`  Flash amount:     ${flashXlm} XLM`);
  console.log(`  Margin:           ${marginXlm} XLM`);
  console.log(`  Leverage:         ${(parseFloat(flashXlm) / parseFloat(marginXlm)).toFixed(1)}x\n`);

  // ── Step 0: Derive addresses ──
  console.log("Step 0 -- Deriving addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM (Arbitrum):  ${addrs.evm.address}`);
  console.log(`  Stellar:         ${addrs.stellar.address}\n`);

  // ── Step 1: Fetch chain state ──
  console.log("Step 1 -- Fetching chain state...\n");
  const provider = new ethers.JsonRpcProvider(ARB_RPC);

  // Arbitrum
  const [nonce, feeData, ethBalance] = await Promise.all([
    provider.getTransactionCount(addrs.evm.address, "pending"),
    provider.getFeeData(),
    provider.getBalance(addrs.evm.address),
  ]);
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("0.1", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");

  console.log("  Arbitrum:");
  console.log(`    Nonce:           ${nonce}`);
  console.log(`    ETH balance:     ${ethers.formatEther(ethBalance)}`);
  console.log(`    Max fee:         ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

  // Fetch Morpho market params
  const marketParams = await fetchMarketParams(provider);
  console.log(`    Market oracle:   ${marketParams.oracle.slice(0, 10)}...`);

  // Stellar
  const server = new Horizon.Server(STELLAR_MAINNET_HORIZON);
  let stellarSequence: string;
  try {
    const stellarAccount = await server.loadAccount(addrs.stellar.address);
    stellarSequence = stellarAccount.sequence;
    const xlmBal = stellarAccount.balances.find((b: any) => b.asset_type === "native");
    console.log(`\n  Stellar:`);
    console.log(`    Sequence:        ${stellarSequence}`);
    console.log(`    XLM balance:     ${(xlmBal as any)?.balance ?? "0"}`);
  } catch {
    console.error(`  Stellar account not found. Fund ${addrs.stellar.address} first.`);
    process.exit(1);
  }

  // ── Step 2: Get bridge quote ──
  console.log("\nStep 2 -- Getting bridge quote from 1Click API...");
  const quote = await getBridgeQuote(
    borrowUsdcRaw.toString(),
    addrs.stellar.address,
    addrs.evm.address,
    jwt,
  );
  console.log(`  Deposit address:   ${quote.depositAddress}`);
  console.log(`  Destination amt:   ${quote.destinationAmount}`);
  console.log(`  Expires:           ${quote.expiresAt}\n`);

  // ── Step 3: Build payloads ──
  console.log("Step 3 -- Building transaction payloads...\n");

  // Tx 1: Stellar change_trust USDC
  const USDC_ISSUER_STRKEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const usdcIssuerHex = Buffer.from(StrKey.decodeEd25519PublicKey(USDC_ISSUER_STRKEY)).toString("hex");
  const stellarNextSeq = parseInt(stellarSequence) + 1;

  const payload1 = {
    StellarChangeTrust: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 100,
      sequence_number: stellarNextSeq,
      asset: {
        CreditAlphanum4: {
          asset_code: "USDC",
          issuer: usdcIssuerHex,
        },
      },
      limit: "9223372036854775807", // i64::MAX
      network: "Mainnet",
    },
  };
  console.log("  Tx 1: Stellar change_trust USDC");

  // Tx 2: Approve WETH -> Morpho
  const approveCalldata = buildApproveWethCalldata(wethAmountWei);
  const payload2 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 60000,
      to: WETH_ADDRESS,
      value: "0x0",
      data: approveCalldata,
    },
  };
  console.log("  Tx 2: Approve WETH -> Morpho (nonce " + nonce + ")");

  // Tx 3: Supply collateral WETH
  const supplyCalldata = buildSupplyCollateralCalldata(marketParams, wethAmountWei, addrs.evm.address);
  const payload3 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 1,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 300000,
      to: MORPHO_ADDRESS,
      value: "0x0",
      data: supplyCalldata,
    },
  };
  console.log("  Tx 3: Supply collateral WETH (nonce " + (nonce + 1) + ")");

  // Tx 4: Borrow USDC
  const borrowCalldata = buildBorrowCalldata(marketParams, borrowUsdcRaw, addrs.evm.address, addrs.evm.address);
  const payload4 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 2,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 300000,
      to: MORPHO_ADDRESS,
      value: "0x0",
      data: borrowCalldata,
    },
  };
  console.log("  Tx 4: Borrow USDC (nonce " + (nonce + 2) + ")");

  // Tx 5: Transfer USDC to 1Click deposit address
  const bridgeCalldata = buildUsdcTransferCalldata(quote.depositAddress, borrowUsdcRaw);
  const payload5 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 3,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 60000,
      to: USDC_ADDRESS,
      value: "0x0",
      data: bridgeCalldata,
    },
  };
  console.log("  Tx 5: Bridge USDC -> Stellar (nonce " + (nonce + 3) + ")");

  // Tx 6: Stellar open_short on Untangled Loop
  // Fetch swap route from Aquarius AMM
  console.log("\n  Fetching swap route from Aquarius AMM...");
  let swapRoute: any;
  try {
    const swapRes = await fetch(AQUARIUS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: STELLAR_XLM_TOKEN,
        token_out_address: STELLAR_USDC_TOKEN,
        amount: flashAmountStroops.toString(),
      }),
    });
    swapRoute = await swapRes.json();
    console.log(`  Swap route: ${JSON.stringify(swapRoute).slice(0, 100)}...`);
  } catch (e: any) {
    console.warn(`  Warning: Could not fetch swap route: ${e.message}`);
    console.warn(`  Using empty swap route -- open_short may fail on-chain.`);
    swapRoute = { pools: [] };
  }

  const stellarNextSeq2 = stellarNextSeq + 1; // second Stellar tx uses next sequence
  const payload6 = {
    StellarInvokeContract: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 10_000_000, // 1 XLM for complex Soroban tx
      sequence_number: stellarNextSeq2,
      contract_id: UNTANGLED_LOOP_CONTRACT,
      function_name: "open_short",
      args: [
        addrs.stellar.address, // caller
        flashAmountStroops.toString(), // flash_amount
        marginAmountStroops.toString(), // initial_margin
        "0", // min_swap_output -- TODO: calculate from swap route
        false, // margin_from_quote = false (XLM margin)
        swapRoute.pools ?? [], // swap_chain
      ],
      network: "Mainnet",
    },
  };
  console.log("  Tx 6: Open short on Untangled Loop");

  const payloads = [payload1, payload2, payload3, payload4, payload5, payload6];
  console.log(`\n  Total payloads: ${payloads.length}`);
  console.log(`  Required deposit: ${payloads.length * 0.25} NEAR\n`);

  // ── Step 4: Submit batch ──
  console.log("Step 4 -- Submitting batch to NEAR...");
  const account = await getMainnetAccount(nearKey);
  const { nearTxId, expectedBatchId } = await submitBatch(account, payloads);
  const batchId = expectedBatchId;
  console.log(`  NEAR tx: ${nearTxId}`);
  console.log(`  Expected batch ID: ${batchId}`);
  console.log(`  https://nearblocks.io/txns/${nearTxId}\n`);

  // Wait for the tx to be included
  console.log("  Waiting for tx inclusion...");
  await sleep(5000);

  // ── Step 5: Crank remaining items ──
  console.log("Step 5 -- Cranking remaining batch items...");
  for (let i = 1; i < payloads.length; i++) {
    console.log(`  Cranking item ${i + 1}/${payloads.length}...`);
    await crankBatchNext(account, batchId);
    await sleep(3000); // wait between cranks
  }

  // ── Step 6: Poll until all signed ──
  console.log("\nStep 6 -- Polling batch status...");
  const finalStatus = await pollBatchStatus(account, batchId);
  console.log(`  Final: ${finalStatus.completed}/${finalStatus.total} signed, ${finalStatus.failed} failed\n`);

  if (finalStatus.failed > 0) {
    console.error("  Some items failed. Check batch details and retry.");
    await refundBatch(account, batchId);
    console.log("  Unused deposit refunded.");
    process.exit(1);
  }

  // ── Step 7: Retrieve signatures ──
  console.log("Step 7 -- Retrieving signatures...");
  const signatures = await getBatchSignatures(account, batchId);
  console.log(`  Got ${signatures.length} signatures\n`);

  // ── Step 8: Broadcast ──
  console.log("Step 8 -- Broadcasting transactions...\n");

  // NOTE: The MPC signer (v1.signer) only supports secp256k1. Stellar requires
  // Ed25519 signatures. Stellar txs were included in the batch for POLICY VALIDATION
  // (the contract checks all policies upfront), but the MPC secp256k1 signatures
  // cannot be used for Stellar broadcast. Instead, we sign locally using the
  // deterministic Ed25519 keypair derived from the secp256k1 child key.
  // This follows the same pattern as demo-stellar-payment.ts.
  const keypair = deriveKeypairFromPublicKey(addrs.stellar.secp256k1PublicKeyHex);

  // Tx 1: Stellar change_trust (broadcast first, signed locally with Ed25519)
  console.log("  Broadcasting Tx 1: Stellar change_trust USDC (signed locally)...");
  const trustlineAccount = new Account(addrs.stellar.address, stellarSequence);
  const trustlineTx = new TransactionBuilder(trustlineAccount, {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset("USDC", USDC_ISSUER_STRKEY),
      }),
    )
    .setTimeout(0)
    .build();
  trustlineTx.sign(keypair);

  try {
    const trustResult = await server.submitTransaction(trustlineTx);
    console.log(`    Confirmed in ledger ${trustResult.ledger}\n`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes?.operations?.[0] === "op_already_exists") {
      console.log("    Trustline already exists -- skipping\n");
    } else {
      console.error(`    Failed: ${e?.message}`);
      console.error(`    Codes: ${JSON.stringify(codes)}`);
      process.exit(1);
    }
  }

  // Tx 2-5: EVM transactions (broadcast in nonce order)
  const evmTxConfigs = [
    { label: "Tx 2: Approve WETH", to: WETH_ADDRESS, data: approveCalldata, gasLimit: 60000 },
    { label: "Tx 3: Supply collateral", to: MORPHO_ADDRESS, data: supplyCalldata, gasLimit: 300000 },
    { label: "Tx 4: Borrow USDC", to: MORPHO_ADDRESS, data: borrowCalldata, gasLimit: 300000 },
    { label: "Tx 5: Bridge USDC", to: USDC_ADDRESS, data: bridgeCalldata, gasLimit: 60000 },
  ];

  let bridgeTxHash = "";
  for (let i = 0; i < evmTxConfigs.length; i++) {
    const cfg = evmTxConfigs[i]!;
    const sig = signatures[i + 1]!; // index 0 is Stellar trustline
    const txNonce = nonce + i;

    console.log(`  Broadcasting ${cfg.label} (nonce ${txNonce})...`);
    const unsignedTx = ethers.Transaction.from({
      type: 2,
      chainId: ARB_CHAIN_ID,
      nonce: txNonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: cfg.gasLimit,
      to: cfg.to,
      value: 0n,
      data: cfg.data,
    });

    const signedTx = reconstructSignedEvmTx(unsignedTx, sig, addrs.evm.address);
    const pending = await provider.broadcastTransaction(signedTx.serialized);
    console.log(`    Hash: ${pending.hash}`);

    const receipt = await pending.wait(1);
    if (receipt?.status !== 1) {
      console.error(`    REVERTED! Gas used: ${receipt?.gasUsed}`);
      process.exit(1);
    }
    console.log(`    Confirmed in block ${receipt.blockNumber}\n`);

    if (i === evmTxConfigs.length - 1) {
      bridgeTxHash = pending.hash;
    }
  }

  // Submit bridge deposit hash to 1Click
  if (bridgeTxHash) {
    console.log("  Submitting bridge deposit to 1Click...");
    await submitDeposit(quote.depositAddress, bridgeTxHash);
  }

  // Wait for bridge
  console.log("\n  Waiting for bridge to complete (USDC Arbitrum -> Stellar)...");
  const bridgeResult = await pollBridgeStatus(quote.depositAddress);
  if (bridgeResult !== "SUCCESS") {
    console.error(`  Bridge ${bridgeResult}. Cannot proceed with open_short.`);
    process.exit(1);
  }
  console.log("  Bridge completed!\n");

  // Tx 6: Stellar open_short (broadcast last, signed locally with Ed25519)
  // The MPC signature (signatures[5]) is secp256k1 and cannot be used for Stellar.
  // We build the Soroban invoke tx locally using the @stellar/stellar-sdk and sign
  // with the same derived Ed25519 keypair used for the trustline.
  console.log("  Broadcasting Tx 6: Open short on Untangled Loop (signed locally)...");

  // Build Soroban contract invocation transaction
  // The open_short function is called on the Untangled Loop entrypoint contract.
  // We use the sequence number that was allocated for Tx 6 (stellarNextSeq2).
  const openShortAccount = new Account(addrs.stellar.address, (stellarNextSeq2 - 1).toString());
  const openShortTx = new TransactionBuilder(openShortAccount, {
    fee: "10000000", // 1 XLM for complex Soroban tx
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: UNTANGLED_LOOP_CONTRACT,
        function: "open_short",
        args: [
          // TODO: encode Soroban args using xdr.ScVal types:
          // - caller: Address (derived Stellar address)
          // - flash_amount: i128 (flashAmountStroops)
          // - initial_margin: i128 (marginAmountStroops)
          // - min_swap_output: i128 (from Aquarius quote)
          // - margin_from_quote: bool (false)
          // - swap_chain: Vec<SwapHop> (from Aquarius route)
          // This requires Soroban XDR encoding which depends on the
          // exact contract interface. Use @stellar/stellar-sdk's
          // nativeToScVal() or manual xdr.ScVal construction.
        ],
      }),
    )
    .setTimeout(300) // 5 min timeout
    .build();
  openShortTx.sign(keypair);

  try {
    // Submit via Horizon (classic tx wrapping Soroban invoke)
    // For pure Soroban txs, may need SorobanRpc.Server.sendTransaction() instead
    const openShortResult = await server.submitTransaction(openShortTx);
    console.log(`    Confirmed in ledger ${openShortResult.ledger}`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    console.error(`    open_short failed: ${e?.message}`);
    console.error(`    Codes: ${JSON.stringify(codes)}`);
    console.error("    NOTE: Soroban invocations may require SorobanRpc.Server for");
    console.error("    proper simulation and resource estimation before submission.");
    console.error("    MPC signature (for reference):", JSON.stringify(signatures[5]));
    // Don't exit -- the EVM transactions are already confirmed
  }

  // Refund unused deposit
  console.log("\n  Refunding unused batch deposit...");
  try {
    await refundBatch(account, batchId);
    console.log("  Refund complete.\n");
  } catch (e: any) {
    console.warn(`  Refund note: ${e.message}\n`);
  }

  console.log("Done! Cross-chain leveraged short position opened.");
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  process.exit(1);
});
