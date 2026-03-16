// ──────────────────────────────────────────────────────────────
// F.2 — E2E Demo: Send 1 XLM via Universal Account Contract
//
// Flow:
//   1. Derive Stellar address from MPC key (Ed25519 via secp256k1 KDF)
//   2. Fetch sequence number + XLM balance from Stellar Horizon
//   3. Connect to NEAR + get next request_id
//   4. Build and register policy (native XLM payment to RECIPIENT)
//   5. Verify policy is active
//   6. Propose StellarPayment tx to the asset-manager contract
//      via request_signature()
//   7. Poll get_signature_request() until MPC Ed25519 signature is ready
//   8. Reconstruct signed Stellar transaction (attach 64-byte Ed25519 sig)
//   9. Submit to Stellar Horizon testnet + wait for confirmation
//
// Policy step (4-5) ensures the contract's policy engine gates this
// tx before forwarding to the MPC signer. Policy key:
//   chain=Stellar, contract=source_ed25519_hex, selector="payment" bytes
// Policy bytes: 88-byte layout — [0..32] destination key, [32..36] asset type,
//   [36..48] asset code, [48..80] issuer, [80..88] amount.
// Mask enforces: destination (0xFF×32) + native asset type (0xFF×4) + rest=0x00
//
// Usage:
//   npx tsx src/demo-stellar-payment.ts
//
// Requirements:
//   - KEY="ed25519:..." in .env  (NEAR account private key, must be contract owner)
//   - Stellar source account funded with >= 1 XLM + fees on testnet
//   - NEAR account funded with >= 0.25 NEAR (MPC signing fee)
// ──────────────────────────────────────────────────────────────

import "dotenv/config";
import {
  Horizon,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Account,
  StrKey,
} from "@stellar/stellar-sdk";
import { transactions, utils } from "near-api-js";
import { deriveUniversalAccountAddresses } from "../core/derive.js";
import { deriveKeypairFromPublicKey } from "../core/stellar.js";
import { getNearAccount } from "../core/near.js";
import { STELLAR_HORIZON, NEAR_ACCOUNT_ID } from "../core/config.js";

// ── Constants ─────────────────────────────────────────────────

const RECIPIENT = "GBWDHJHSBVCTSX7V3TQXN26NPM2M2HR2ZVJV7PAY7UN36DNX2XW46AUZ";
const TRANSFER_AMOUNT_XLM = "1"; // 1 XLM
const TRANSFER_AMOUNT_STROOPS = 10_000_000; // 1 XLM = 10M stroops
const FEE_STROOPS = 100; // 0.00001 XLM

/** 0.25 NEAR — covers MPC signing fee; excess is refunded */
const SIGN_DEPOSIT = BigInt("250000000000000000000000");

/** 300 Tgas — contract (50) + MPC sign (220) + callback (30) */
const SIGN_GAS = BigInt("300000000000000");

/** Selector bytes = UTF-8 "payment" */
const PAYMENT_SELECTOR = Array.from(Buffer.from("payment"));

// ── Policy Helpers ─────────────────────────────────────────────

/**
 * Build mask + condition for a native XLM payment to a specific destination.
 *
 * Policy bytes layout = 88 bytes:
 *   [0..32]  destination Ed25519 key
 *   [32..36] asset type (4-byte big-endian u32)
 *   [36..48] asset code, zero-padded to 12 bytes
 *   [48..80] asset issuer key (32 bytes, zeros if native)
 *   [80..88] amount as big-endian i64 (8 bytes)
 *
 * Mask strategy:
 *   - Enforce destination: mask[0..32] = 0xFF
 *   - Enforce native (type=0): mask[32..36] = 0xFF
 *   - Allow any amount: mask[80..88] = 0x00
 */
function buildNativeXlmPaymentPolicy(destEd25519Hex: string): {
  selector: number[];
  mask: number[];
  condition: number[];
} {
  const destBytes = Buffer.from(destEd25519Hex, "hex");
  if (destBytes.length !== 32) throw new Error("Destination must be 32 bytes");

  const mask = new Array<number>(88).fill(0);
  const condition = new Array<number>(88).fill(0);

  // Enforce destination (bytes 0–31)
  for (let i = 0; i < 32; i++) {
    mask[i] = 0xff;
    condition[i] = destBytes[i];
  }

  // Enforce native asset type = 0 (bytes 32–35)
  for (let i = 32; i < 36; i++) {
    mask[i] = 0xff;
    // condition[i] = 0 (already zero = native)
  }

  return {
    selector: PAYMENT_SELECTOR,
    mask,
    condition,
  };
}

// ── Contract Helpers ───────────────────────────────────────────

async function getNextRequestId(
  account: Awaited<ReturnType<typeof getNearAccount>>
): Promise<number> {
  const total: number = await account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_total_requests",
    args: {},
  });
  return total + 1;
}

async function setPolicy(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  registration: {
    chain: string;
    contract: string;
    selector: number[];
    mask: number[];
    condition: number[];
    value_limit: string | null;
    expires_at: number | null;
  }
): Promise<void> {
  const result = await account.functionCall({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "set_policy",
    args: { registration },
    gas: BigInt("30000000000000"),
    attachedDeposit: BigInt("0"),
  });
  if ((result.status as any).Failure) {
    throw new Error(JSON.stringify((result.status as any).Failure));
  }
}

async function getPolicy(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  chain: string,
  targetContract: string,
  selector: number[]
): Promise<{
  mask: number[];
  condition: number[];
  value_limit: string | null;
  expires_at: number | null;
} | null> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_policy",
    args: { chain, target_contract: targetContract, selector },
  });
}

async function pollSignatureRequest(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  requestId: number,
  maxAttempts = 80,
  intervalMs = 3000
): Promise<{
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const req: any = await account.viewFunction({
      contractId: NEAR_ACCOUNT_ID,
      methodName: "get_signature_request",
      args: { request_id: requestId },
    });

    const status = req?.status;

    if (status === "Completed") {
      if (!req.signature) throw new Error("Status is Completed but signature is missing");
      return req.signature;
    }

    if (typeof status === "object" && status?.Failed) {
      throw new Error(`MPC signing failed: ${status.Failed}`);
    }

    const statusStr = typeof status === "string" ? status : JSON.stringify(status);
    const elapsed = ((attempt * intervalMs) / 1000).toFixed(0);

    if (status === undefined || status === null) {
      console.log(
        `  [${attempt}/${maxAttempts}] Request ${requestId} not found — raw: ${JSON.stringify(req)} — ${elapsed}s elapsed`
      );
    } else {
      console.log(`  [${attempt}/${maxAttempts}] ${statusStr} — ${elapsed}s elapsed`);
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }

  throw new Error("Timed out waiting for MPC signature");
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const nearKey = process.env.KEY;
  if (!nearKey) {
    console.error('❌  KEY not set. Add KEY="ed25519:..." to .env');
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  F.2 — Send 1 XLM via Universal Account         ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Step 1: Derive Stellar address ───────────────────────────
  console.log("Step 1 — Deriving Stellar address from MPC key...");
  const { stellar } = await deriveUniversalAccountAddresses();
  const sourceAddress = stellar.address; // G... StrKey
  const sourceEd25519Hex = stellar.ed25519PublicKeyHex; // raw 32-byte hex
  const sourceSecp256k1Hex = stellar.secp256k1PublicKeyHex; // for local Ed25519 signing

  // Decode recipient StrKey → raw Ed25519 hex
  const destRawBytes = StrKey.decodeEd25519PublicKey(RECIPIENT);
  const destEd25519Hex = Buffer.from(destRawBytes).toString("hex");

  console.log(`  From:   ${sourceAddress}`);
  console.log(`  To:     ${RECIPIENT}`);
  console.log(`  Amount: ${TRANSFER_AMOUNT_XLM} XLM\n`);

  // ── Step 2: Fetch account state from Horizon ──────────────────
  console.log("Step 2 — Fetching account state from Stellar Horizon...");
  const server = new Horizon.Server(STELLAR_HORIZON);

  let accountData: Horizon.AccountResponse;
  try {
    accountData = await server.loadAccount(sourceAddress);
  } catch (e: any) {
    console.error(`❌  Could not load Stellar account: ${e?.message}`);
    console.error(`    Fund ${sourceAddress} on Stellar testnet:`);
    console.error(`    https://friendbot.stellar.org/?addr=${sourceAddress}`);
    process.exit(1);
  }

  const currentSequence = accountData.sequence; // string, e.g. "1234"
  const nextSequenceNumber = parseInt(currentSequence) + 1;
  const xlmBalance =
    accountData.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";

  console.log(`  Account:         ${sourceAddress}`);
  console.log(`  Current seq:     ${currentSequence}`);
  console.log(`  Next seq:        ${nextSequenceNumber}`);
  console.log(`  XLM balance:     ${xlmBalance} XLM`);

  const balanceXlm = parseFloat(xlmBalance);
  const requiredXlm = parseFloat(TRANSFER_AMOUNT_XLM) + 0.01; // transfer + fees + reserve
  if (balanceXlm < requiredXlm) {
    console.error(`❌  Insufficient XLM balance.`);
    console.error(`    Have: ${xlmBalance} XLM`);
    console.error(`    Need: >= ${requiredXlm} XLM`);
    console.error(`    Fund: https://friendbot.stellar.org/?addr=${sourceAddress}`);
    process.exit(1);
  }
  console.log();

  // ── Step 3: Connect to NEAR + get next request_id ─────────────
  console.log("Step 3 — Connecting to NEAR testnet...");
  const account = await getNearAccount(nearKey);
  const requestId = await getNextRequestId(account);
  console.log(`  Contract:        ${NEAR_ACCOUNT_ID}`);
  console.log(`  Next request_id: ${requestId}\n`);

  // ── Step 4: Check + register policy ──────────────────────────
  console.log("Step 4 — Checking policy for native XLM payment...");

  console.log(`  chain:     Stellar`);
  console.log(`  contract:  ${sourceEd25519Hex}  (source Ed25519 key hex)`);
  console.log(`  selector:  ${JSON.stringify(PAYMENT_SELECTOR)}  ("payment" bytes)`);

  const existingPolicy = await getPolicy(
    account,
    "Stellar",
    sourceEd25519Hex,
    PAYMENT_SELECTOR
  );

  if (existingPolicy) {
    console.log("  Policy already exists — skipping registration.");
    console.log(`  expires_at:  ${existingPolicy.expires_at ? new Date(existingPolicy.expires_at / 1_000_000).toISOString() : "never"}\n`);
  } else {
    const { selector, mask, condition } = buildNativeXlmPaymentPolicy(destEd25519Hex);
    console.log(`  mask[0..32]:  0xFF×32  (enforce destination)`);
    console.log(`  mask[32..36]: 0xFF×4   (enforce native asset type = 0)`);
    console.log(`  mask[36..88]: 0x00     (allow any amount)`);
    console.log("  No existing policy — registering...");
    await setPolicy(account, {
      chain: "Stellar",
      contract: sourceEd25519Hex,
      selector,
      mask,
      condition,
      value_limit: null,
      expires_at: null,
    });
    console.log("  Policy registered successfully.\n");
  }

  // ── Step 5: Verify policy is active ──────────────────────────
  console.log("Step 5 — Verifying policy is active...");
  const activePolicy =
    existingPolicy ?? (await getPolicy(account, "Stellar", sourceEd25519Hex, PAYMENT_SELECTOR));
  if (!activePolicy) {
    console.error("❌  Policy not found after registration — cannot proceed.");
    process.exit(1);
  }
  console.log(`  Policy confirmed active for stellar:${sourceEd25519Hex.slice(0, 12)}...:payment`);
  console.log(`  expires_at:  ${activePolicy.expires_at ? new Date(activePolicy.expires_at / 1_000_000).toISOString() : "never"}\n`);

  // ── Step 6: Propose tx to the universal account ───────────────
  console.log("Step 6 — Proposing StellarPayment transaction to universal account...");

  const contractPayload = {
    StellarPayment: {
      source_account: sourceEd25519Hex,
      fee: FEE_STROOPS,
      sequence_number: nextSequenceNumber,
      destination: destEd25519Hex,
      asset: "Native",
      amount: TRANSFER_AMOUNT_STROOPS,
      network: "Testnet",
    },
  };

  console.log("  Payload:", JSON.stringify(contractPayload, null, 4));

  const action = transactions.functionCall(
    "request_signature",
    { payload: contractPayload, derivation_index: 0, use_balance: false },
    SIGN_GAS,
    SIGN_DEPOSIT
  );

  const [txHashBytes, nearSignedTx] = await account.signTransaction(NEAR_ACCOUNT_ID, [action]);
  const nearProvider = (account as any).connection.provider as any;
  await nearProvider.sendTransactionAsync(nearSignedTx);

  const nearTxId = utils.serialize.base_encode(txHashBytes);
  console.log(`\n  NEAR tx submitted: ${nearTxId}`);
  console.log(`  https://testnet.nearblocks.io/txns/${nearTxId}`);

  // Verify the NEAR tx was included and the contract call succeeded before polling.
  // sendTransactionAsync uses wait_until=NONE so failures are silent without this check.
  console.log("  Verifying NEAR tx inclusion...");
  await new Promise((r) => setTimeout(r, 5000));
  try {
    const outcome: any = await nearProvider.txStatus(nearTxId, NEAR_ACCOUNT_ID, "INCLUDED");
    const txFailure = outcome?.transaction_outcome?.outcome?.status?.Failure;
    if (txFailure) {
      throw new Error(`NEAR tx failed at tx level: ${JSON.stringify(txFailure)}`);
    }
    const failedReceipt = outcome?.receipts_outcome?.find(
      (r: any) => r?.outcome?.status?.Failure
    );
    if (failedReceipt) {
      throw new Error(
        `Contract call failed: ${JSON.stringify(failedReceipt.outcome.status.Failure)}`
      );
    }
    console.log("  NEAR tx included — contract call succeeded.\n");
  } catch (e: any) {
    // Re-throw contract/tx failures; warn and continue if it's a transient RPC error.
    if (e.message?.includes("failed")) throw e;
    console.warn(`  Warning: could not verify NEAR tx status: ${e.message}\n`);
  }

  // ── Step 7: Wait for MPC Ed25519 signature ────────────────────
  console.log(`Step 7 — Waiting for MPC Ed25519 signature (request_id: ${requestId})...`);
  const sig = await pollSignatureRequest(account, requestId);

  console.log("  Signature received:");
  console.log(`    big_r (R): ${sig.big_r.affine_point}`);
  console.log(`    s     (S): ${sig.s.scalar}`);
  console.log(`    recovery_id: ${sig.recovery_id}\n`);

  // ── Step 8: Build + sign locally with derived Ed25519 keypair ─────
  console.log("Step 8 — Building signed Stellar transaction...");

  // NOTE: v1.signer-prod.testnet only supports secp256k1 (key_version: 0).
  // The MPC signature above is a secp256k1 ECDSA signature — it CANNOT be used
  // as an Ed25519 signature for Stellar. The contract processed the request and
  // enforced the policy, but the actual Stellar Ed25519 signing must be done
  // locally using the deterministic Ed25519 keypair derived from the secp256k1
  // child key (SHA-256 of compressed key → Ed25519 seed).
  //
  // Once the MPC signer supports Ed25519 (key_version: 1), this local signing
  // step should be replaced with the MPC's native Ed25519 signature.
  console.log("  NOTE: MPC returns secp256k1 sig — signing locally with derived Ed25519 keypair.");

  const stellarKeypair = deriveKeypairFromPublicKey(sourceSecp256k1Hex);

  // Build the Stellar transaction with the same parameters passed to the contract.
  // TransactionBuilder auto-increments the sequence number once, so we pass
  // currentSequence (the builder will use currentSequence + 1 = nextSequenceNumber).
  const sourceAccount = new Account(sourceAddress, currentSequence);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: FEE_STROOPS.toString(),
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: RECIPIENT,
        asset: Asset.native(),
        amount: TRANSFER_AMOUNT_XLM,
      })
    )
    // TIMEOUT_INFINITE = 0 → no time bounds → PRECOND_NONE in XDR,
    // which matches the contract's build_stellar_payment_payload encoding.
    .setTimeout(TransactionBuilder.TIMEOUT_INFINITE)
    .build();

  // Sign with the locally derived Ed25519 keypair
  tx.sign(stellarKeypair);

  const txHash = Buffer.from(tx.hash()).toString("hex");
  console.log(`  Tx hash:  0x${txHash}`);
  console.log(`  Tx XDR:   ${tx.toEnvelope().toXDR("base64").slice(0, 80)}...\n`);

  // ── Step 9: Submit to Stellar Horizon testnet ─────────────────
  console.log("Step 9 — Submitting to Stellar Horizon testnet...");
  let result: Horizon.HorizonApi.SubmitTransactionResponse;
  try {
    result = await server.submitTransaction(tx);
  } catch (e: any) {
    const extras = e?.response?.data?.extras;
    console.error("❌  Stellar transaction submission failed:");
    console.error(`    Message: ${e?.message}`);
    if (extras?.result_codes) {
      console.error(`    Result codes: ${JSON.stringify(extras.result_codes)}`);
    }
    if (extras?.result_xdr) {
      console.error(`    Result XDR: ${extras.result_xdr}`);
    }
    console.error("\nFull error:", JSON.stringify(e, Object.getOwnPropertyNames(e), 2));
    process.exit(1);
  }

  console.log("\n✅ Transaction confirmed!");
  console.log(`  Tx hash:  ${result.hash}`);
  console.log(`  Ledger:   ${result.ledger}`);
  console.log(`  Explorer: https://stellar.expert/explorer/testnet/tx/${result.hash}`);
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  console.error("Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  process.exit(1);
});
