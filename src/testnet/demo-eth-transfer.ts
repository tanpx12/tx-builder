// ──────────────────────────────────────────────────────────────
// F.1 — E2E Demo: Send 0.1 ETH via Universal Account Contract
//
// Flow:
//   1. Derive ETH address from MPC key
//   2. Fetch nonce + gas fees from Sepolia
//   3. Connect to NEAR + get next request_id
//   4. Build and register policy (native ETH transfer to RECIPIENT)
//   5. Verify policy is active
//   6. Propose EIP-1559 tx to the asset-manager contract
//      via request_signature()
//   7. Poll get_signature_request() until MPC signature is ready
//   8. Reconstruct signed transaction
//   9. Broadcast to Sepolia + wait for confirmation
//
// Policy step (4-5) ensures the contract's policy engine gates this
// tx before forwarding to the MPC signer. Policy key:
//   chain=Evm, contract=RECIPIENT (lowercase), selector=[] (no calldata)
// Policy bytes: 32-byte big-endian value field only (native transfer).
// Mask = all zeros = allow any ETH amount to this specific recipient.
//
// Usage:
//   npx tsx src/demo-eth-transfer.ts
//
// Requirements:
//   - KEY="ed25519:..." in .env  (NEAR account private key, must be contract owner)
//   - From address funded with >= 0.1 ETH + gas on Sepolia
//   - NEAR account funded with >= 0.25 NEAR (MPC signing fee)
// ──────────────────────────────────────────────────────────────

import "dotenv/config";
import { ethers } from "ethers";
import { transactions, utils } from "near-api-js";
import { deriveUniversalAccountAddresses } from "../core/derive.js";
import { getNearAccount } from "../core/near.js";
import { ETH_RPC, ETH_CHAIN_ID, NEAR_ACCOUNT_ID } from "../core/config.js";

// ── Constants ─────────────────────────────────────────────────

const RECIPIENT = "0x46788b60dAf46448668C7ABaeeA4Ac8745451c25";
const TRANSFER_AMOUNT_ETH = "0.1";
const GAS_LIMIT = 21_000;

/** 0.25 NEAR — covers MPC signing fee; excess is refunded */
const SIGN_DEPOSIT = BigInt("250000000000000000000000");

/** 300 Tgas — contract (50) + MPC sign (220) + callback (30) */
const SIGN_GAS = BigInt("300000000000000");

// ── Policy Helpers ─────────────────────────────────────────────

/** Normalize EVM address: lowercase, no 0x prefix */
function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

/**
 * Build mask + condition for a native ETH transfer (no calldata).
 *
 * Policy bytes layout = 32 bytes (value field only):
 *   [0..32]  tx.value as big-endian uint256, zero-padded
 *
 * mask = all zeros = allow any ETH value to this recipient.
 * Restriction is the recipient itself, captured by the policy key.
 */
function buildNativeEthTransferPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  return {
    selector: [],                             // empty calldata — no 4-byte selector
    mask: new Array<number>(32).fill(0),      // allow any value amount
    condition: new Array<number>(32).fill(0),
  };
}

// ── Contract Helpers ───────────────────────────────────────────

/**
 * Returns the request_id that will be assigned to the NEXT request_signature call.
 * The contract tracks `next_request_id` internally; `get_total_requests()` returns
 * `next_request_id - 1`.  So the next ID = total + 1.
 */
async function getNextRequestId(account: Awaited<ReturnType<typeof getNearAccount>>): Promise<number> {
  const total: number = await account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_total_requests",
    args: {},
  });
  return total + 1;
}

/** Register a policy on the contract (owner-only). */
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

/** Poll get_signature_request() until status == Completed, then return the ChainSignature */
async function pollSignatureRequest(
  account: Awaited<ReturnType<typeof getNearAccount>>,
  requestId: number,
  maxAttempts = 60,
  intervalMs = 3000
): Promise<{ big_r: { affine_point: string }; s: { scalar: string }; recovery_id: number }> {
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
    console.log(`  [${attempt}/${maxAttempts}] ${statusStr} — ${elapsed}s elapsed`);

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
  console.log("║  F.1 — Send 0.1 ETH via Universal Account       ║");
  console.log("╚══════════════════════════════════════════════════╝\n");

  // ── Step 1: Derive from-address ──────────────────────────────
  console.log("Step 1 — Deriving ETH address from MPC key...");
  const { evm } = await deriveUniversalAccountAddresses();
  const fromAddress = evm.address;
  console.log(`  From:   ${fromAddress}`);
  console.log(`  To:     ${RECIPIENT}`);
  console.log(`  Amount: ${TRANSFER_AMOUNT_ETH} ETH\n`);

  // ── Step 2: Fetch nonce + gas fees from Sepolia ───────────────
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
  const estimatedGasCost = maxFeePerGas * BigInt(GAS_LIMIT);
  const requiredBalance = valueWei + estimatedGasCost;

  console.log(`  Nonce:          ${nonce}`);
  console.log(`  Balance:        ${ethers.formatEther(balance)} ETH`);
  console.log(`  Max fee:        ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);
  console.log(`  Priority fee:   ${ethers.formatUnits(maxPriorityFeePerGas, "gwei")} gwei`);
  console.log(`  Required:       >= ${ethers.formatEther(requiredBalance)} ETH\n`);

  if (balance < requiredBalance) {
    console.error(`❌  Insufficient balance on Sepolia.`);
    console.error(`    Have: ${ethers.formatEther(balance)} ETH`);
    console.error(`    Need: ${ethers.formatEther(requiredBalance)} ETH`);
    console.error(`    Fund address: ${fromAddress}`);
    process.exit(1);
  }

  // ── Step 3: Connect to NEAR + get next request_id ─────────────
  console.log("Step 3 — Connecting to NEAR testnet...");
  const account = await getNearAccount(nearKey);
  const requestId = await getNextRequestId(account);
  console.log(`  Contract:        ${NEAR_ACCOUNT_ID}`);
  console.log(`  Next request_id: ${requestId}\n`);

  // ── Step 4: Check + register policy ─────────────────────────
  console.log("Step 4 — Checking policy for native ETH transfer...");

  const recipientNormalized = normalizeAddress(RECIPIENT);
  const { selector, mask, condition } = buildNativeEthTransferPolicy();

  console.log(`  chain:     Evm`);
  console.log(`  contract:  ${recipientNormalized}`);
  console.log(`  selector:  [] (native transfer — no calldata)`);

  const existingPolicy = await getPolicy(account, "Evm", recipientNormalized, selector);
  if (existingPolicy) {
    console.log("  Policy already exists — skipping registration.");
    console.log(`  value_limit: ${existingPolicy.value_limit ?? "none"}`);
    console.log(`  expires_at:  ${existingPolicy.expires_at ? new Date(existingPolicy.expires_at / 1_000_000).toISOString() : "never"}\n`);
  } else {
    console.log(`  mask:      ${mask.every((b) => b === 0) ? "(all zeros — allow any value)" : "0x" + mask.map((b) => b.toString(16).padStart(2, "0")).join("")}`);
    console.log("  No existing policy — registering...");
    await setPolicy(account, {
      chain: "Evm",
      contract: recipientNormalized,
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
  const activePolicy = existingPolicy ?? await getPolicy(account, "Evm", recipientNormalized, selector);
  if (!activePolicy) {
    console.error("❌  Policy not found after registration — cannot proceed.");
    process.exit(1);
  }
  console.log(`  Policy confirmed active for evm:${recipientNormalized}:[] (native transfer)`);
  console.log(`  value_limit: ${activePolicy.value_limit ?? "none"}`);
  console.log(`  expires_at:  ${activePolicy.expires_at ? new Date(activePolicy.expires_at / 1_000_000).toISOString() : "never"}\n`);

  // ── Step 6: Propose tx to the universal account ───────────────
  console.log("Step 6 — Proposing EIP-1559 transaction to universal account...");

  const contractPayload = {
    EvmEip1559: {
      chain_id: ETH_CHAIN_ID,
      nonce,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: GAS_LIMIT,
      to: RECIPIENT,
      value: "0x" + valueWei.toString(16),
      data: "0x",
    },
  };

  console.log("  Payload:", JSON.stringify(contractPayload, null, 4));

  // Build the function call action manually so we can send it asynchronously.
  // account.functionCall() uses wait_until='EXECUTED_OPTIMISTIC' which waits for ALL
  // receipts including the MPC signing cross-contract call (can take 60-180 s).
  // Many RPC endpoints timeout during that wait and return HTTP 500.
  // sendTransactionAsync uses wait_until='NONE' — returns as soon as the transaction
  // is broadcast, letting us poll get_signature_request separately.
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

  // ── Step 7: Wait for MPC signature ───────────────────────────
  console.log(`Step 7 — Waiting for MPC signature (request_id: ${requestId})...`);
  const sig = await pollSignatureRequest(account, requestId);

  console.log("  Signature received:");
  console.log(`    big_r: ${sig.big_r.affine_point}`);
  console.log(`    s:     ${sig.s.scalar}`);
  console.log(`    v:     ${sig.recovery_id}\n`);

  // ── Step 8: Reconstruct signed transaction ───────────────────
  console.log("Step 8 — Reconstructing signed EIP-1559 transaction...");

  const unsignedTx = ethers.Transaction.from({
    type: 2,
    chainId: ETH_CHAIN_ID,
    nonce,
    maxPriorityFeePerGas,
    maxFeePerGas,
    gasLimit: GAS_LIMIT,
    to: RECIPIENT,
    value: valueWei,
    data: "0x",
  });

  // big_r.affine_point has a compressed-key prefix byte (02 or 03); strip it to get r
  const r = "0x" + sig.big_r.affine_point.slice(2);
  const s = "0x" + sig.s.scalar;

  // Trust recovery_id from the MPC directly.  The MPC nodes know which y-parity
  // corresponds to the child key they used for signing — no guessing needed.
  // (Flipping it gave a wrong address; the original is correct.)
  const signedTx = unsignedTx.clone();
  signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id });

  console.log(`  Signer:   ${signedTx.from}`);

  console.log(`  Tx hash: ${signedTx.hash}\n`);

  // ── Step 9: Broadcast to Sepolia ─────────────────────────────
  console.log("Step 9 — Broadcasting to Sepolia...");
  const pending = await provider.broadcastTransaction(signedTx.serialized);
  console.log(`  Pending: ${pending.hash}`);
  console.log(`  Explorer: https://sepolia.etherscan.io/tx/${pending.hash}\n`);

  console.log("  Waiting for 1 confirmation...");
  const receipt = await pending.wait(1);

  if (receipt?.status === 1) {
    console.log("\n✅ Transaction confirmed!");
    console.log(`  Block:    ${receipt.blockNumber}`);
    console.log(`  Gas used: ${receipt.gasUsed.toLocaleString()}`);
    console.log(`  Explorer: https://sepolia.etherscan.io/tx/${receipt.hash}`);
  } else {
    console.error("\n❌ Transaction reverted!");
    console.error(`  Receipt:  ${JSON.stringify(receipt, null, 2)}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  console.error("Full error:", JSON.stringify(err, Object.getOwnPropertyNames(err), 2));
  process.exit(1);
});
