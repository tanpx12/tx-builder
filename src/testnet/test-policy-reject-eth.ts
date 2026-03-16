// ──────────────────────────────────────────────────────────────
// E2E Test: Policy Rejection — ETH transfer to unauthorized address
//
// This test validates that the asset-manager contract's policy engine
// correctly REJECTS a native ETH transfer to an address that has NOT
// been whitelisted in the policy registry.
//
// The existing policy only allows transfers to:
//   0x46788b60dAf46448668C7ABaeeA4Ac8745451c25
//
// This test attempts to send ETH to an unauthorized address:
//   0x3B7C83Ae7C254f04fe3ac3912CA913C03BBCd85B
//
// Expected result: The contract's request_signature() call should FAIL
// because no policy exists for the unauthorized recipient address.
//
// Usage:
//   npx tsx src/test-policy-reject-eth.ts
//
// Requirements:
//   - KEY="ed25519:..." in .env  (NEAR account private key)
//   - NEAR account funded with >= 0.25 NEAR
// ──────────────────────────────────────────────────────────────

import "dotenv/config";
import { ethers } from "ethers";
import { transactions, utils } from "near-api-js";
import { deriveUniversalAccountAddresses } from "../core/derive.js";
import { getNearAccount } from "../core/near.js";
import { ETH_RPC, ETH_CHAIN_ID, NEAR_ACCOUNT_ID } from "../core/config.js";

// ── Constants ─────────────────────────────────────────────────

/** Unauthorized recipient — NOT in the policy registry */
const UNAUTHORIZED_RECIPIENT = "0x3B7C83Ae7C254f04fe3ac3912CA913C03BBCd85B";

const TRANSFER_AMOUNT_ETH = "0.001"; // small amount, doesn't matter — should be rejected
const GAS_LIMIT = 21_000;

/** 0.25 NEAR — covers MPC signing fee; excess is refunded */
const SIGN_DEPOSIT = BigInt("250000000000000000000000");

/** 300 Tgas */
const SIGN_GAS = BigInt("300000000000000");

// ── Helpers ───────────────────────────────────────────────────

/** Normalize EVM address: lowercase, no 0x prefix */
function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

async function getNextRequestId(account: Awaited<ReturnType<typeof getNearAccount>>): Promise<number> {
  const total: number = await account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_total_requests",
    args: {},
  });
  return total + 1;
}

/** View a registered policy. Returns null if not set. */
async function getPolicy(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  chain: string,
  targetContract: string,
  selector: number[]
): Promise<{ mask: number[]; condition: number[]; value_limit: string | null; expires_at: number | null } | null> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_policy",
    args: { chain, target_contract: targetContract, selector },
  });
}

/** Get the contract's default policy behavior */
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

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  E2E Test: Policy Rejection — ETH to unauthorized addr  ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  // ── Step 1: Derive from-address ──────────────────────────────
  console.log("Step 1 — Deriving ETH address from MPC key...");
  const { evm } = await deriveUniversalAccountAddresses();
  const fromAddress = evm.address;
  console.log(`  From:   ${fromAddress}`);
  console.log(`  To:     ${UNAUTHORIZED_RECIPIENT}  (UNAUTHORIZED — not in policy)`);
  console.log(`  Amount: ${TRANSFER_AMOUNT_ETH} ETH\n`);

  // ── Step 2: Fetch chain state from Sepolia ────────────────────
  console.log("Step 2 — Fetching chain state from Sepolia...");
  const provider = new ethers.JsonRpcProvider(ETH_RPC);

  const [nonce, feeData, balance] = await Promise.all([
    provider.getTransactionCount(fromAddress, "pending"),
    provider.getFeeData(),
    provider.getBalance(fromAddress),
  ]);

  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("20", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
  const valueWei = ethers.parseEther(TRANSFER_AMOUNT_ETH);

  console.log(`  Nonce:    ${nonce}`);
  console.log(`  Balance:  ${ethers.formatEther(balance)} ETH\n`);

  // ── Step 3: Connect to NEAR ───────────────────────────────────
  console.log("Step 3 — Connecting to NEAR testnet...");
  const account = await getNearAccount(nearKey);
  const requestId = await getNextRequestId(account);
  console.log(`  Contract:        ${NEAR_ACCOUNT_ID}`);
  console.log(`  Next request_id: ${requestId}\n`);

  // ── Step 4: Verify NO policy exists for unauthorized address ──
  console.log("Step 4 — Confirming no policy exists for unauthorized recipient...");

  const recipientNormalized = normalizeAddress(UNAUTHORIZED_RECIPIENT);
  const selector: number[] = []; // native ETH transfer — no calldata

  const existingPolicy = await getPolicy(account, "Evm", recipientNormalized, selector);
  if (existingPolicy) {
    console.error(`❌  A policy ALREADY EXISTS for ${recipientNormalized} — test is invalid.`);
    console.error(`    Remove it first with: npx tsx src/manage-policy.ts remove-evm ${recipientNormalized} ""`);
    process.exit(1);
  }
  console.log(`  ✓ No policy found for evm:${recipientNormalized}:[] (native transfer)`);

  // Ensure default behavior is DenyAll so the contract rejects unknown addresses
  const originalBehavior = await getDefaultBehavior(account);
  console.log(`  Current default behavior: ${originalBehavior}`);
  if (originalBehavior !== "DenyAll") {
    console.log("  Setting default behavior to DenyAll for this test...");
    await setDefaultBehavior(account, "DenyAll");
    const verified = await getDefaultBehavior(account);
    console.log(`  Default behavior now: ${verified}`);
  }
  console.log();

  // ── Step 5: Attempt to propose tx (SHOULD FAIL) ───────────────
  console.log("Step 5 — Proposing EIP-1559 tx to UNAUTHORIZED recipient...");
  console.log("         (expecting policy rejection)\n");

  const contractPayload = {
    EvmEip1559: {
      chain_id: ETH_CHAIN_ID,
      nonce,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: GAS_LIMIT,
      to: UNAUTHORIZED_RECIPIENT,
      value: "0x" + valueWei.toString(16),
      data: "0x",
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

    // If we got here with no failure — the tx succeeded, which means the test failed
    if (!testPassed) {
      // Check if a signature request was actually created
      try {
        const req: any = await account.viewFunction({
          contractId: NEAR_ACCOUNT_ID,
          methodName: "get_signature_request",
          args: { request_id: requestId },
        });

        if (req?.status === "Completed" || req?.status === "Pending") {
          console.log("\n  ❌ TEST FAILED — Transaction was ACCEPTED by the contract.");
          console.log(`  Signature request ${requestId} status: ${req.status}`);
          console.log("  The policy engine did not block the unauthorized transfer.");
          console.log("  Check if default_behavior is AllowAll or a policy exists.");
          process.exit(1);
        }

        if (typeof req?.status === "object" && req?.status?.Failed) {
          console.log("\n  ✅ TEST PASSED — Signature request was marked as Failed.");
          console.log(`  Failure reason: ${req.status.Failed}`);
          testPassed = true;
        }
      } catch {
        // If the request doesn't exist, that's also a pass — the contract rejected early
        console.log("\n  ✅ TEST PASSED — No signature request was created (rejected early).");
        testPassed = true;
      }
    }
  } catch (e: any) {
    // RPC call failed — try to determine if it's "tx not found" vs a legitimate failure
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
  if (originalBehavior !== "DenyAll") {
    console.log(`\n  Restoring default behavior to ${originalBehavior}...`);
    await setDefaultBehavior(account, originalBehavior as "AllowAll" | "DenyAll");
    console.log(`  Default behavior restored.`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log("\n" + "═".repeat(60));
  if (testPassed) {
    console.log("  RESULT: ✅ PASS — Policy enforcement correctly blocked");
    console.log(`  the ETH transfer to unauthorized address:`);
    console.log(`  ${UNAUTHORIZED_RECIPIENT}`);
  } else {
    console.log("  RESULT: ❌ FAIL — Policy enforcement did NOT block");
    console.log(`  the ETH transfer to unauthorized address.`);
    console.log(`  Review default_behavior and registered policies.`);
    process.exit(1);
  }
  console.log("═".repeat(60));
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  console.error("Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  process.exit(1);
});
