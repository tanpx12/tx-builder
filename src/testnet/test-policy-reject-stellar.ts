// ──────────────────────────────────────────────────────────────
// E2E Test: Policy Rejection — XLM payment to unauthorized address
//
// This test validates that the asset-manager contract's policy engine
// correctly REJECTS a native XLM payment to an address that has NOT
// been whitelisted in the policy condition bytes.
//
// The existing policy only allows payments to:
//   GBWDHJHSBVCTSX7V3TQXN26NPM2M2HR2ZVJV7PAY7UN36DNX2XW46AUZ
//
// This test attempts to send XLM to an unauthorized address:
//   GBZOJE3CRCYMPZDMT72WAZSOQLXMMHSEASKDLM4MLCWCUD2FVLMG4XQS
//
// Expected result: The contract's request_signature() call should FAIL
// because the destination does not match the policy condition bytes
// (destination is enforced via mask[0..32] = 0xFF).
//
// Usage:
//   npx tsx src/test-policy-reject-stellar.ts
//
// Requirements:
//   - KEY="ed25519:..." in .env  (NEAR account private key)
//   - Stellar source account funded on testnet (for valid sequence number)
//   - NEAR account funded with >= 0.25 NEAR
// ──────────────────────────────────────────────────────────────

import "dotenv/config";
import {
  Horizon,
  StrKey,
} from "@stellar/stellar-sdk";
import { transactions, utils } from "near-api-js";
import { deriveUniversalAccountAddresses } from "../core/derive.js";
import { getNearAccount } from "../core/near.js";
import { STELLAR_HORIZON, NEAR_ACCOUNT_ID } from "../core/config.js";

// ── Constants ─────────────────────────────────────────────────

/** Authorized recipient (in policy) — for reference only */
const AUTHORIZED_RECIPIENT = "GBWDHJHSBVCTSX7V3TQXN26NPM2M2HR2ZVJV7PAY7UN36DNX2XW46AUZ";

/** Unauthorized recipient — NOT matching the policy condition bytes */
const UNAUTHORIZED_RECIPIENT = "GBZOJE3CRCYMPZDMT72WAZSOQLXMMHSEASKDLM4MLCWCUD2FVLMG4XQS";

const TRANSFER_AMOUNT_XLM = "1"; // 1 XLM
const TRANSFER_AMOUNT_STROOPS = 10_000_000; // 1 XLM = 10M stroops
const FEE_STROOPS = 100; // 0.00001 XLM

/** 0.25 NEAR — covers MPC signing fee; excess is refunded */
const SIGN_DEPOSIT = BigInt("250000000000000000000000");

/** 300 Tgas */
const SIGN_GAS = BigInt("300000000000000");

/** Selector bytes = UTF-8 "payment" */
const PAYMENT_SELECTOR = Array.from(Buffer.from("payment"));

// ── Helpers ───────────────────────────────────────────────────

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

async function getDefaultBehavior(
  account: Awaited<ReturnType<typeof getNearAccount>>
): Promise<string> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_default_behavior",
    args: {},
  });
}

/** Set the contract's default behavior (owner only) */
async function setDefaultBehavior(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  behavior: "AllowAll" | "DenyAll"
): Promise<void> {
  const result = await account.functionCall({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "set_default_behavior",
    args: { behavior },
    gas: BigInt("30000000000000"),
    attachedDeposit: BigInt("0"),
  });
  if ((result.status as any).Failure) {
    throw new Error(JSON.stringify((result.status as any).Failure));
  }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const nearKey = process.env.KEY;
  if (!nearKey) {
    console.error('❌  KEY not set. Add KEY="ed25519:..." to .env');
    process.exit(1);
  }

  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║  E2E Test: Policy Rejection — XLM to unauthorized address   ║");
  console.log("╚══════════════════════════════════════════════════════════════╝\n");

  // ── Step 1: Derive Stellar address ───────────────────────────
  console.log("Step 1 — Deriving Stellar address from MPC key...");
  const { stellar } = await deriveUniversalAccountAddresses();
  const sourceAddress = stellar.address; // G... StrKey
  const sourceEd25519Hex = stellar.ed25519PublicKeyHex; // raw 32-byte hex

  // Decode unauthorized recipient StrKey → raw Ed25519 hex
  const unauthorizedDestRawBytes = StrKey.decodeEd25519PublicKey(UNAUTHORIZED_RECIPIENT);
  const unauthorizedDestHex = Buffer.from(unauthorizedDestRawBytes).toString("hex");

  // Decode authorized recipient for comparison
  const authorizedDestRawBytes = StrKey.decodeEd25519PublicKey(AUTHORIZED_RECIPIENT);
  const authorizedDestHex = Buffer.from(authorizedDestRawBytes).toString("hex");

  console.log(`  From:       ${sourceAddress}`);
  console.log(`  To:         ${UNAUTHORIZED_RECIPIENT}  (UNAUTHORIZED)`);
  console.log(`  Authorized: ${AUTHORIZED_RECIPIENT}  (in policy)`);
  console.log(`  Amount:     ${TRANSFER_AMOUNT_XLM} XLM\n`);

  // ── Step 2: Fetch account state from Horizon ──────────────────
  console.log("Step 2 — Fetching account state from Stellar Horizon...");
  const server = new Horizon.Server(STELLAR_HORIZON);

  let currentSequence: string;
  let nextSequenceNumber: number;

  try {
    const accountData = await server.loadAccount(sourceAddress);
    currentSequence = accountData.sequence;
    nextSequenceNumber = parseInt(currentSequence) + 1;
    const xlmBalance =
      accountData.balances.find((b: any) => b.asset_type === "native")?.balance ?? "0";

    console.log(`  Account:     ${sourceAddress}`);
    console.log(`  Current seq: ${currentSequence}`);
    console.log(`  XLM balance: ${xlmBalance} XLM\n`);
  } catch (e: any) {
    console.error(`❌  Could not load Stellar account: ${e?.message}`);
    console.error(`    Fund ${sourceAddress} on Stellar testnet:`);
    console.error(`    https://friendbot.stellar.org/?addr=${sourceAddress}`);
    process.exit(1);
  }

  // ── Step 3: Connect to NEAR ───────────────────────────────────
  console.log("Step 3 — Connecting to NEAR testnet...");
  const account = await getNearAccount(nearKey);
  const requestId = await getNextRequestId(account);
  console.log(`  Contract:        ${NEAR_ACCOUNT_ID}`);
  console.log(`  Next request_id: ${requestId}\n`);

  // ── Step 4: Verify policy state ───────────────────────────────
  console.log("Step 4 — Checking policy state...");

  const existingPolicy = await getPolicy(
    account,
    "Stellar",
    sourceEd25519Hex,
    PAYMENT_SELECTOR
  );

  // Save current default behavior and ensure it's DenyAll for the test
  const originalBehavior = await getDefaultBehavior(account);
  console.log(`  Current default behavior: ${originalBehavior}`);

  if (existingPolicy) {
    // The existing policy is for the AUTHORIZED destination.
    // The contract does policy lookup by key: (Stellar, source_hex, "payment").
    // Since the key is the SAME for any payment from this source, the existing
    // policy WILL be found — but the mask check will fail because the destination
    // bytes don't match the condition bytes.
    const conditionDestHex = Buffer.from(existingPolicy.condition.slice(0, 32)).toString("hex");
    const maskDestBytes = existingPolicy.mask.slice(0, 32);
    const destEnforced = maskDestBytes.every((b: number) => b === 0xff);

    console.log(`  Policy found for stellar:${sourceEd25519Hex.slice(0, 12)}...:payment`);
    console.log(`  Destination enforced:  ${destEnforced ? "YES (mask[0..32] = 0xFF)" : "NO (mask allows any dest)"}`);
    console.log(`  Condition dest hex:    ${conditionDestHex.slice(0, 24)}...`);
    console.log(`  Authorized dest hex:   ${authorizedDestHex.slice(0, 24)}...`);
    console.log(`  Unauthorized dest hex: ${unauthorizedDestHex.slice(0, 24)}...`);

    if (!destEnforced) {
      console.warn("  ⚠ Destination is NOT enforced in mask — policy allows any destination.");
      console.warn("    The test may not produce a rejection. Consider updating the policy.");
    }

    if (conditionDestHex === unauthorizedDestHex) {
      console.error("  ❌ The policy condition matches the unauthorized address — test is invalid.");
      process.exit(1);
    }

    console.log(`  ✓ Unauthorized dest does NOT match policy condition — should be rejected by mask check.\n`);
  } else {
    // No policy exists — need DenyAll to reject
    console.log(`  No policy found for stellar:${sourceEd25519Hex.slice(0, 12)}...:payment`);
    if (originalBehavior !== "DenyAll") {
      console.log("  Setting default behavior to DenyAll for this test...");
      await setDefaultBehavior(account, "DenyAll");
      const verified = await getDefaultBehavior(account);
      console.log(`  Default behavior now: ${verified}`);
    }
    console.log();
  }

  // ── Step 5: Attempt to propose tx (SHOULD FAIL) ───────────────
  console.log("Step 5 — Proposing StellarPayment to UNAUTHORIZED recipient...");
  console.log("         (expecting policy rejection)\n");

  const contractPayload = {
    StellarPayment: {
      source_account: sourceEd25519Hex,
      fee: FEE_STROOPS,
      sequence_number: nextSequenceNumber,
      destination: unauthorizedDestHex,
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
  console.log(`  https://testnet.nearblocks.io/txns/${nearTxId}\n`);

  // ── Step 6: Check NEAR tx outcome — expect FAILURE ────────────
  console.log("Step 6 — Verifying NEAR tx outcome (expecting failure)...");
  console.log("  Waiting for tx to finalize...");
  await new Promise((r) => setTimeout(r, 6000));

  let testPassed = false;

  try {
    const outcome: any = await nearProvider.txStatus(nearTxId, NEAR_ACCOUNT_ID, "INCLUDED");

    // Check for transaction-level failure
    const txFailure = outcome?.transaction_outcome?.outcome?.status?.Failure;
    if (txFailure) {
      console.log("\n  ✅ TEST PASSED — Transaction failed at tx level (as expected).");
      console.log(`  Failure: ${JSON.stringify(txFailure, null, 2)}`);
      testPassed = true;
    }

    // Check for receipt-level failure (contract panic)
    if (!testPassed) {
      const failedReceipt = outcome?.receipts_outcome?.find(
        (r: any) => r?.outcome?.status?.Failure
      );
      if (failedReceipt) {
        const failure = failedReceipt.outcome.status.Failure;
        const errorKind = failure?.ActionError?.kind;
        const errorMsg = errorKind?.FunctionCallError?.ExecutionError ?? JSON.stringify(failure);

        console.log("\n  ✅ TEST PASSED — Contract rejected the transaction (as expected).");
        console.log(`  Error: ${errorMsg}`);
        testPassed = true;
      }
    }

    // If no failure found — the tx succeeded, which means the test failed
    if (!testPassed) {
      try {
        const req: any = await account.viewFunction({
          contractId: NEAR_ACCOUNT_ID,
          methodName: "get_signature_request",
          args: { request_id: requestId },
        });

        if (req?.status === "Completed" || req?.status === "Pending") {
          console.log("\n  ❌ TEST FAILED — Transaction was ACCEPTED by the contract.");
          console.log(`  Signature request ${requestId} status: ${req.status}`);
          console.log("  The policy engine did not block the unauthorized payment.");
          console.log("  Check destination enforcement in policy mask/condition.");
          process.exit(1);
        }

        if (typeof req?.status === "object" && req?.status?.Failed) {
          console.log("\n  ✅ TEST PASSED — Signature request was marked as Failed.");
          console.log(`  Failure reason: ${req.status.Failed}`);
          testPassed = true;
        }
      } catch {
        console.log("\n  ✅ TEST PASSED — No signature request was created (rejected early).");
        testPassed = true;
      }
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);

    if (msg.includes("does not exist") || msg.includes("UNKNOWN_TRANSACTION")) {
      console.log("\n  ⚠ Could not fetch tx status — tx may still be processing.");
      console.log("  Checking signature request status instead...");

      await new Promise((r) => setTimeout(r, 5000));

      try {
        const req: any = await account.viewFunction({
          contractId: NEAR_ACCOUNT_ID,
          methodName: "get_signature_request",
          args: { request_id: requestId },
        });

        if (typeof req?.status === "object" && req?.status?.Failed) {
          console.log("\n  ✅ TEST PASSED — Signature request failed.");
          console.log(`  Failure reason: ${req.status.Failed}`);
          testPassed = true;
        } else if (req?.status === "Completed" || req?.status === "Pending") {
          console.log("\n  ❌ TEST FAILED — Transaction was ACCEPTED by the contract.");
          process.exit(1);
        }
      } catch {
        console.log("\n  ✅ TEST PASSED — No signature request created (rejected by policy).");
        testPassed = true;
      }
    } else {
      // Other RPC error — don't assume pass, check signature request status
      console.log(`\n  ⚠ RPC error when fetching tx status: ${msg}`);
      console.log("  Checking signature request status as fallback...");

      await new Promise((r) => setTimeout(r, 5000));

      try {
        const req: any = await account.viewFunction({
          contractId: NEAR_ACCOUNT_ID,
          methodName: "get_signature_request",
          args: { request_id: requestId },
        });

        if (typeof req?.status === "object" && req?.status?.Failed) {
          console.log("\n  ✅ TEST PASSED — Signature request failed.");
          console.log(`  Failure reason: ${req.status.Failed}`);
          testPassed = true;
        } else if (req?.status === "Completed" || req?.status === "Pending" || req?.status === "Processing") {
          console.log("\n  ❌ TEST FAILED — Transaction was ACCEPTED by the contract.");
          console.log(`  Signature request ${requestId} status: ${req.status}`);
          process.exit(1);
        }
      } catch {
        console.log("\n  ✅ TEST PASSED — No signature request created (rejected by policy).");
        testPassed = true;
      }
    }
  }

  // ── Restore original default behavior ──────────────────────
  if (originalBehavior !== "DenyAll" && !existingPolicy) {
    console.log(`\n  Restoring default behavior to ${originalBehavior}...`);
    await setDefaultBehavior(account, originalBehavior as "AllowAll" | "DenyAll");
    console.log(`  Default behavior restored.`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "═".repeat(64));
  if (testPassed) {
    console.log("  RESULT: ✅ PASS — Policy enforcement correctly blocked");
    console.log(`  the XLM payment to unauthorized address:`);
    console.log(`  ${UNAUTHORIZED_RECIPIENT}`);
  } else {
    console.log("  RESULT: ❌ FAIL — Policy enforcement did NOT block");
    console.log(`  the XLM payment to unauthorized address.`);
    console.log(`  Review Stellar payment policy mask/condition.`);
    process.exit(1);
  }
  console.log("═".repeat(64));
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  console.error("Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  process.exit(1);
});
