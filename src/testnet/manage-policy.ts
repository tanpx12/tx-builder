// ─────────────────────────────────────────────────────────────────────────────
// Policy Management Script for asset-manager contract
//
// Manages bitwise mask policies that gate request_signature() calls.
// Validation rule: payload_bytes & mask == condition
//
// COMMANDS:
//   npx tsx src/manage-policy.ts status
//   npx tsx src/manage-policy.ts set-default <allow|deny>
//   npx tsx src/manage-policy.ts set-evm <contract> <selector-hex> <mask-hex> <condition-hex> [--value-limit=<wei>] [--expires-in=<seconds>]
//     selector-hex: 4-byte calldata selector (e.g. a9059cbb), OR empty string "" for native ETH transfers
//   npx tsx src/manage-policy.ts get-evm <contract> <selector-hex>
//   npx tsx src/manage-policy.ts remove-evm <contract> <selector-hex>
//   npx tsx src/manage-policy.ts set-stellar-payment <source-account-hex> <mask-hex> <condition-hex>
//   npx tsx src/manage-policy.ts get-stellar-payment <source-account-hex>
//   npx tsx src/manage-policy.ts remove-stellar-payment <source-account-hex>
//   npx tsx src/manage-policy.ts set-stellar-invoke <source-account-hex> <function-name> <mask-hex> <condition-hex>
//   npx tsx src/manage-policy.ts get-stellar-invoke <source-account-hex> <function-name>
//   npx tsx src/manage-policy.ts remove-stellar-invoke <source-account-hex> <function-name>
//   npx tsx src/manage-policy.ts simulate <payload-hex> <mask-hex> <condition-hex>
//   npx tsx src/manage-policy.ts example-erc20 <token-contract> [recipient-address]
//
// REQUIRES: KEY="ed25519:..." in .env for write operations
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { getNearAccount } from "../core/near.js";
import { NEAR_ACCOUNT_ID } from "../core/config.js";

// ── Types ─────────────────────────────────────────────────────────────────────

type PolicyChain = "Evm" | "Stellar";
type DefaultBehavior = "AllowAll" | "DenyAll";

interface PolicyRegistration {
  chain: PolicyChain;
  contract: string;
  selector: number[];
  mask: number[];
  condition: number[];
  value_limit: string | null; // U128 as decimal string, e.g. "1000000000000000000"
  expires_at: number | null;  // NEAR block timestamp nanoseconds
}

interface MaskPolicy {
  mask: number[];
  condition: number[];
  value_limit: string | null;
  expires_at: number | null;
}

interface SimulateResult {
  valid: boolean;
  reason: string;
  masked_bytes: string | null;
}

// ── Hex/Byte Helpers ──────────────────────────────────────────────────────────

function hexToBytes(hex: string): number[] {
  const cleaned = hex.replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error(`Odd-length hex string: "${hex}"`);
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function strToBytes(str: string): number[] {
  return Array.from(Buffer.from(str, "utf8"));
}

/** Normalize EVM address: lowercase, no 0x prefix */
function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

// ── EVM Policy Helpers ────────────────────────────────────────────────────────
//
// EVM policy key: ("Evm", to_address_lowercase_no0x, calldata[0..4])
//   For native ETH transfers (no calldata): selector = [] (empty bytes)
//
// Mask/condition applied to: evm_policy_bytes = value(32) ++ calldata
//   [0..32]          tx.value as big-endian uint256 (zero-padded)
//   [32..32+N]       raw calldata (tx.data) — absent for native transfers
//
// Native ETH transfer policy bytes — 32 bytes total:
//   [0..32]  value:     big-endian uint256 (tx.value)
//
// ERC-20 transfer(address,uint256) policy bytes — 100 bytes total:
//   [0..32]  value:     big-endian uint256 (0x00 for standard ERC-20 — no ETH)
//   [32..36] selector:  a9059cbb
//   [36..48] padding:   12 zero bytes (ABI head of 32-byte address slot)
//   [48..68] recipient: 20-byte address
//   [68..100] amount:   32-byte uint256

/**
 * Build mask + condition for ERC-20 transfer(address,uint256).
 *
 * Policy bytes layout (100 bytes): value(32) ++ selector(4) ++ addr_pad(12) ++ recipient(20) ++ amount(32)
 *
 * @param recipientAddress  20-byte hex address to whitelist. undefined = allow any recipient.
 * @param enforceZeroValue  if true, mask enforces tx.value == 0 (recommended for ERC-20)
 */
function buildErc20TransferPolicy(recipientAddress?: string, enforceZeroValue = true): {
  selector: number[];
  mask: number[];
  condition: number[];
} {
  const selector = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)

  // 100 bytes: 32 (value) + 4 (selector) + 32 (padded address) + 32 (amount)
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  // [0..32] enforce value == 0 (no ETH sent alongside ERC-20 call)
  if (enforceZeroValue) {
    for (let i = 0; i < 32; i++) mask[i] = 0xff;
    // condition[0..32] already zeros
  }

  // [32..36] enforce selector exactly
  mask[32] = 0xff; condition[32] = 0xa9;
  mask[33] = 0xff; condition[33] = 0x05;
  mask[34] = 0xff; condition[34] = 0x9c;
  mask[35] = 0xff; condition[35] = 0xbb;

  // [36..48] address padding — mask=0, don't care

  // [48..68] optionally enforce recipient
  if (recipientAddress) {
    const addrBytes = hexToBytes(recipientAddress);
    if (addrBytes.length !== 20) throw new Error("Recipient must be a 20-byte address");
    for (let i = 0; i < 20; i++) {
      mask[48 + i] = 0xff;
      condition[48 + i] = addrBytes[i]!;
    }
  }

  // [68..100] amount — mask=0, allow any amount

  return { selector, mask, condition };
}

/**
 * Build mask + condition for ERC-20 approve(address,uint256) — selector 095ea7b3.
 *
 * Policy bytes layout (100 bytes): value(32) ++ selector(4) ++ addr_pad(12) ++ spender(20) ++ amount(32)
 */
function buildErc20ApprovePolicy(spenderAddress?: string, enforceZeroValue = true): {
  selector: number[];
  mask: number[];
  condition: number[];
} {
  const selector = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)

  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  if (enforceZeroValue) {
    for (let i = 0; i < 32; i++) mask[i] = 0xff;
  }

  mask[32] = 0xff; condition[32] = 0x09;
  mask[33] = 0xff; condition[33] = 0x5e;
  mask[34] = 0xff; condition[34] = 0xa7;
  mask[35] = 0xff; condition[35] = 0xb3;

  if (spenderAddress) {
    const addrBytes = hexToBytes(spenderAddress);
    if (addrBytes.length !== 20) throw new Error("Spender must be a 20-byte address");
    for (let i = 0; i < 20; i++) {
      mask[48 + i] = 0xff;
      condition[48 + i] = addrBytes[i]!;
    }
  }

  return { selector, mask, condition };
}

// ── Stellar Policy Helpers ────────────────────────────────────────────────────
//
// Stellar payment policy key: ("Stellar", source_account_hex, b"payment")
// Mask/condition applied to 88-byte canonical layout:
//   [0..32]  destination Ed25519 key (32 bytes)
//   [32..36] asset type as big-endian u32 (0=native, 1=alphanum4)
//   [36..48] asset code zero-padded to 12 bytes
//   [48..80] asset issuer key (32 bytes, all zeros for native)
//   [80..88] amount as big-endian i64 stroops
//
// Stellar invoke policy key: ("Stellar", source_account_hex, function_name_bytes)
// Mask/condition applied to variable-length bytes:
//   [0..32]  contract ID (32 bytes)
//   [32..32+N] function name UTF-8 bytes
//   [32+N..] each arg serialized via xdr_encode_sc_val

/**
 * Build mask + condition for a Stellar native XLM payment to a specific destination.
 *
 * @param destinationHex  32-byte Ed25519 key hex. null = allow any destination.
 * @param maxAmountStroops  max amount in stroops. null = allow any amount.
 */
function buildStellarNativePaymentPolicy(
  destinationHex?: string,
  maxAmountStroops?: bigint
): { mask: number[]; condition: number[] } {
  const mask = new Array<number>(88).fill(0);
  const condition = new Array<number>(88).fill(0);

  // Enforce destination key [0..32]
  if (destinationHex) {
    const destBytes = hexToBytes(destinationHex);
    if (destBytes.length !== 32) throw new Error("Destination must be 32 bytes");
    for (let i = 0; i < 32; i++) {
      mask[i] = 0xff;
      condition[i] = destBytes[i]!;
    }
  }

  // Enforce asset type = native (0) [32..36]
  mask[32] = 0xff; mask[33] = 0xff; mask[34] = 0xff; mask[35] = 0xff;
  // condition[32..36] = 0x00000000 (native) — already zeros

  // Asset code [36..48] and issuer [48..80]: native = all zeros — no mask needed

  // Enforce max amount [80..88] — not a simple mask; use value_limit or leave unconstrained.
  // (For a strict amount check you'd need equality via mask=0xff each byte, but
  //  that would only allow a single exact amount. Leave at 0 = allow any amount.)
  void maxAmountStroops; // handled via value_limit or left unconstrained here

  return { mask, condition };
}

// ── Contract Calls ────────────────────────────────────────────────────────────

async function viewDefaultBehavior(account: any): Promise<DefaultBehavior> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_default_behavior",
    args: {},
  });
}

async function callSetDefaultBehavior(
  account: any,
  behavior: DefaultBehavior
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

async function callSetPolicy(
  account: any,
  registration: PolicyRegistration
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

async function callRemovePolicy(
  account: any,
  chain: PolicyChain,
  targetContract: string,
  selector: number[]
): Promise<void> {
  const result = await account.functionCall({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "remove_policy",
    args: { chain, target_contract: targetContract, selector },
    gas: BigInt("30000000000000"),
    attachedDeposit: BigInt("0"),
  });
  if ((result.status as any).Failure) {
    throw new Error(JSON.stringify((result.status as any).Failure));
  }
}

async function viewGetPolicy(
  account: any,
  chain: PolicyChain,
  targetContract: string,
  selector: number[]
): Promise<MaskPolicy | null> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "get_policy",
    args: { chain, target_contract: targetContract, selector },
  });
}

async function viewSimulatePolicy(
  account: any,
  payloadBytes: number[],
  mask: number[],
  condition: number[]
): Promise<SimulateResult> {
  return account.viewFunction({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "simulate_policy",
    args: { payload_bytes: payloadBytes, mask, condition },
  });
}

// ── Display Helpers ───────────────────────────────────────────────────────────

function printPolicy(policy: MaskPolicy | null, label: string): void {
  if (!policy) {
    console.log(`  ${label}: (not set)`);
    return;
  }
  console.log(`  ${label}:`);
  console.log(`    mask:        0x${bytesToHex(policy.mask)}`);
  console.log(`    condition:   0x${bytesToHex(policy.condition)}`);
  console.log(`    value_limit: ${policy.value_limit ?? "none"}`);
  console.log(
    `    expires_at:  ${
      policy.expires_at
        ? new Date(policy.expires_at / 1_000_000).toISOString()
        : "never"
    }`
  );
}

function parseExpiresIn(args: string[]): number | null {
  const flag = args.find((a) => a.startsWith("--expires-in="));
  if (!flag) return null;
  const seconds = parseInt(flag.split("=")[1]!, 10);
  if (isNaN(seconds)) throw new Error("--expires-in must be a number of seconds");
  return (Date.now() + seconds * 1000) * 1_000_000; // convert to nanoseconds
}

function parseValueLimit(args: string[]): string | null {
  const flag = args.find((a) => a.startsWith("--value-limit="));
  if (!flag) return null;
  return flag.split("=")[1]!;
}

// ── Commands ──────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const account = await getNearAccount();
  const behavior = await viewDefaultBehavior(account);
  console.log(`Contract:         ${NEAR_ACCOUNT_ID}`);
  console.log(`Default behavior: ${behavior}`);
  console.log();
  console.log("Use 'get-evm', 'get-stellar-payment', or 'get-stellar-invoke' to inspect specific policies.");
}

async function cmdSetDefault(args: string[]): Promise<void> {
  const arg = args[0]?.toLowerCase();
  if (arg !== "allow" && arg !== "deny") {
    throw new Error("Usage: set-default <allow|deny>");
  }
  const behavior: DefaultBehavior = arg === "allow" ? "AllowAll" : "DenyAll";
  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  await callSetDefaultBehavior(account, behavior);
  console.log(`Default behavior set to: ${behavior}`);
}

async function cmdSetEvm(args: string[]): Promise<void> {
  const [contract, selectorHex, maskHex, conditionHex, ...rest] = args;
  if (!contract || selectorHex === undefined || !maskHex || !conditionHex) {
    throw new Error('Usage: set-evm <contract> <selector-hex> <mask-hex> <condition-hex> [--value-limit=<wei>] [--expires-in=<seconds>]\n  selector-hex: 4-byte calldata selector, or "" (empty string) for native ETH transfers');
  }
  // Contract allows empty selector (native ETH transfer) or exactly 4 bytes (calldata selector)
  const selector = selectorHex === "" ? [] : hexToBytes(selectorHex);
  if (selector.length !== 0 && selector.length !== 4) {
    throw new Error("EVM selector must be empty (native ETH transfer) or exactly 4 bytes");
  }
  const mask = hexToBytes(maskHex);
  const condition = hexToBytes(conditionHex);
  if (mask.length !== condition.length) throw new Error("mask and condition must be the same length");

  const allArgs = [selectorHex, maskHex, conditionHex, ...rest];
  const value_limit = parseValueLimit(allArgs);
  const expires_at = parseExpiresIn(allArgs);

  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  await callSetPolicy(account, {
    chain: "Evm",
    contract: normalizeAddress(contract),
    selector,
    mask,
    condition,
    value_limit,
    expires_at,
  });
  console.log(`EVM policy set:`);
  console.log(`  contract:  ${normalizeAddress(contract)}`);
  console.log(`  selector:  ${selector.length === 0 ? "(empty — native ETH transfer)" : "0x" + bytesToHex(selector)}`);
  console.log(`  mask:      0x${maskHex}`);
  console.log(`  condition: 0x${conditionHex}`);
  if (value_limit) console.log(`  value_limit: ${value_limit} wei`);
  if (expires_at) console.log(`  expires_at: ${new Date(expires_at / 1_000_000).toISOString()}`);
}

async function cmdGetEvm(args: string[]): Promise<void> {
  const [contract, selectorHex] = args;
  if (!contract || selectorHex === undefined) throw new Error('Usage: get-evm <contract> <selector-hex>  (use "" for native ETH transfer)');
  const selector = selectorHex === "" ? [] : hexToBytes(selectorHex);
  const account = await getNearAccount();
  const policy = await viewGetPolicy(account, "Evm", normalizeAddress(contract), selector);
  const selectorLabel = selector.length === 0 ? "(native)" : `0x${selectorHex}`;
  printPolicy(policy, `evm:${normalizeAddress(contract)}:${selectorLabel}`);
}

async function cmdRemoveEvm(args: string[]): Promise<void> {
  const [contract, selectorHex] = args;
  if (!contract || selectorHex === undefined) throw new Error('Usage: remove-evm <contract> <selector-hex>  (use "" for native ETH transfer)');
  const selector = selectorHex === "" ? [] : hexToBytes(selectorHex);
  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  await callRemovePolicy(account, "Evm", normalizeAddress(contract), selector);
  const selectorLabel = selector.length === 0 ? "(native)" : `0x${selectorHex}`;
  console.log(`Removed EVM policy for ${normalizeAddress(contract)} selector ${selectorLabel}`);
}

async function cmdSetStellarPayment(args: string[]): Promise<void> {
  const [sourceAccount, maskHex, conditionHex, ...rest] = args;
  if (!sourceAccount || !maskHex || !conditionHex) {
    throw new Error("Usage: set-stellar-payment <source-account-hex> <mask-hex> <condition-hex> [--expires-in=<seconds>]");
  }
  const mask = hexToBytes(maskHex);
  const condition = hexToBytes(conditionHex);
  if (mask.length !== 88 || condition.length !== 88) {
    throw new Error("Stellar payment mask and condition must be exactly 88 bytes");
  }

  const allArgs = [maskHex, conditionHex, ...rest];
  const expires_at = parseExpiresIn(allArgs);

  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  // Contract uses selector = b"payment" for Stellar payment policies
  const selector = strToBytes("payment");
  await callSetPolicy(account, {
    chain: "Stellar",
    contract: sourceAccount,
    selector,
    mask,
    condition,
    value_limit: null,
    expires_at,
  });
  console.log(`Stellar payment policy set for source account: ${sourceAccount}`);
}

async function cmdGetStellarPayment(args: string[]): Promise<void> {
  const [sourceAccount] = args;
  if (!sourceAccount) throw new Error("Usage: get-stellar-payment <source-account-hex>");
  const account = await getNearAccount();
  const selector = strToBytes("payment");
  const policy = await viewGetPolicy(account, "Stellar", sourceAccount, selector);
  printPolicy(policy, `stellar:${sourceAccount}:payment`);
}

async function cmdRemoveStellarPayment(args: string[]): Promise<void> {
  const [sourceAccount] = args;
  if (!sourceAccount) throw new Error("Usage: remove-stellar-payment <source-account-hex>");
  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  const selector = strToBytes("payment");
  await callRemovePolicy(account, "Stellar", sourceAccount, selector);
  console.log(`Removed Stellar payment policy for source account: ${sourceAccount}`);
}

async function cmdSetStellarInvoke(args: string[]): Promise<void> {
  const [sourceAccount, functionName, maskHex, conditionHex, ...rest] = args;
  if (!sourceAccount || !functionName || !maskHex || !conditionHex) {
    throw new Error("Usage: set-stellar-invoke <source-account-hex> <function-name> <mask-hex> <condition-hex> [--expires-in=<seconds>]");
  }
  const mask = hexToBytes(maskHex);
  const condition = hexToBytes(conditionHex);
  if (mask.length !== condition.length) throw new Error("mask and condition must be the same length");

  const allArgs = [maskHex, conditionHex, ...rest];
  const expires_at = parseExpiresIn(allArgs);

  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  const selector = strToBytes(functionName);
  await callSetPolicy(account, {
    chain: "Stellar",
    contract: sourceAccount,
    selector,
    mask,
    condition,
    value_limit: null,
    expires_at,
  });
  console.log(`Stellar invoke policy set:`);
  console.log(`  source_account: ${sourceAccount}`);
  console.log(`  function_name:  ${functionName}`);
}

async function cmdGetStellarInvoke(args: string[]): Promise<void> {
  const [sourceAccount, functionName] = args;
  if (!sourceAccount || !functionName) throw new Error("Usage: get-stellar-invoke <source-account-hex> <function-name>");
  const account = await getNearAccount();
  const selector = strToBytes(functionName);
  const policy = await viewGetPolicy(account, "Stellar", sourceAccount, selector);
  printPolicy(policy, `stellar:${sourceAccount}:${functionName}`);
}

async function cmdRemoveStellarInvoke(args: string[]): Promise<void> {
  const [sourceAccount, functionName] = args;
  if (!sourceAccount || !functionName) throw new Error("Usage: remove-stellar-invoke <source-account-hex> <function-name>");
  const nearKey = requireKey();
  const account = await getNearAccount(nearKey);
  const selector = strToBytes(functionName);
  await callRemovePolicy(account, "Stellar", sourceAccount, selector);
  console.log(`Removed Stellar invoke policy for source account: ${sourceAccount} function: ${functionName}`);
}

async function cmdSimulate(args: string[]): Promise<void> {
  const [payloadHex, maskHex, conditionHex] = args;
  if (!payloadHex || !maskHex || !conditionHex) {
    throw new Error("Usage: simulate <payload-hex> <mask-hex> <condition-hex>");
  }
  const payloadBytes = hexToBytes(payloadHex);
  const mask = hexToBytes(maskHex);
  const condition = hexToBytes(conditionHex);

  const account = await getNearAccount();
  const result = await viewSimulatePolicy(account, payloadBytes, mask, condition);

  console.log(`Simulate result:`);
  console.log(`  valid:        ${result.valid}`);
  console.log(`  reason:       ${result.reason}`);
  console.log(`  masked_bytes: ${result.masked_bytes ? "0x" + result.masked_bytes : "n/a"}`);
}

async function cmdExampleErc20(args: string[]): Promise<void> {
  const [tokenContract, recipientAddress] = args;
  if (!tokenContract) {
    throw new Error("Usage: example-erc20 <token-contract-address> [recipient-address]");
  }

  const { selector, mask, condition } = buildErc20TransferPolicy(recipientAddress);

  console.log("ERC-20 transfer(address,uint256) policy example");
  console.log("────────────────────────────────────────────────");
  console.log(`Token contract:  ${normalizeAddress(tokenContract)}`);
  console.log(`Selector:        0x${bytesToHex(selector)}`);
  if (recipientAddress) {
    console.log(`Recipient:       ${normalizeAddress(recipientAddress)}`);
  } else {
    console.log(`Recipient:       (any)`);
  }
  console.log();
  console.log(`mask:      0x${bytesToHex(mask)}`);
  console.log(`condition: 0x${bytesToHex(condition)}`);
  console.log();
  console.log("To register this policy (add --value-limit / --expires-in as needed):");
  console.log(
    `  npx tsx src/manage-policy.ts set-evm ${normalizeAddress(tokenContract)} ${bytesToHex(selector)} ${bytesToHex(mask)} ${bytesToHex(condition)}`
  );
  console.log();

  // Simulate with sample evm_policy_bytes = value(32) ++ calldata(68) = 100 bytes
  // value = 0 (no ETH), selector = a9059cbb, recipient, amount = 1e18
  const samplePolicyBytes = new Array<number>(100).fill(0);
  // [0..32] value = 0 (already zeros)
  // [32..36] selector
  samplePolicyBytes[32] = 0xa9; samplePolicyBytes[33] = 0x05;
  samplePolicyBytes[34] = 0x9c; samplePolicyBytes[35] = 0xbb;
  // [36..48] address padding (zeros)
  // [48..68] recipient
  if (recipientAddress) {
    const addrBytes = hexToBytes(recipientAddress);
    for (let i = 0; i < 20; i++) samplePolicyBytes[48 + i] = addrBytes[i]!;
  }
  // [68..100] amount = 1e18
  const oneEth = BigInt("1000000000000000000");
  const amountBytes = oneEth.toString(16).padStart(64, "0");
  hexToBytes(amountBytes).forEach((b, i) => (samplePolicyBytes[68 + i] = b));

  const account = await getNearAccount();
  const sim = await viewSimulatePolicy(account, samplePolicyBytes, mask, condition);
  console.log("Simulation against sample evm_policy_bytes (value=0, 1e18 token transfer):");
  console.log(`  payload:  0x${bytesToHex(samplePolicyBytes)}`);
  console.log(`  valid:    ${sim.valid}`);
  console.log(`  reason:   ${sim.reason}`);
}

// ── Key Helper ────────────────────────────────────────────────────────────────

function requireKey(): string {
  const key = process.env.KEY;
  if (!key) throw new Error('KEY not set. Add KEY="ed25519:..." to .env');
  return key;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  try {
    switch (cmd ?? "status") {
      case "status":
        await cmdStatus();
        break;
      case "set-default":
        await cmdSetDefault(args);
        break;
      case "set-evm":
        await cmdSetEvm(args);
        break;
      case "get-evm":
        await cmdGetEvm(args);
        break;
      case "remove-evm":
        await cmdRemoveEvm(args);
        break;
      case "set-stellar-payment":
        await cmdSetStellarPayment(args);
        break;
      case "get-stellar-payment":
        await cmdGetStellarPayment(args);
        break;
      case "remove-stellar-payment":
        await cmdRemoveStellarPayment(args);
        break;
      case "set-stellar-invoke":
        await cmdSetStellarInvoke(args);
        break;
      case "get-stellar-invoke":
        await cmdGetStellarInvoke(args);
        break;
      case "remove-stellar-invoke":
        await cmdRemoveStellarInvoke(args);
        break;
      case "simulate":
        await cmdSimulate(args);
        break;
      case "example-erc20":
        await cmdExampleErc20(args);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error("Commands: status, set-default, set-evm, get-evm, remove-evm,");
        console.error("          set-stellar-payment, get-stellar-payment, remove-stellar-payment,");
        console.error("          set-stellar-invoke, get-stellar-invoke, remove-stellar-invoke,");
        console.error("          simulate, example-erc20");
        process.exit(1);
    }
  } catch (err: any) {
    console.error("Error:", err?.message ?? err);
    process.exit(1);
  }
}

main();
