// src/mainnet/set-policies.ts
// CLI: Register all 5 policies for the mainnet leveraged short demo
//
// Usage:
//   npx tsx src/mainnet/set-policies.ts              # register all policies
//   npx tsx src/mainnet/set-policies.ts --dry-run    # show what would be registered
//
// Requires: MAINNET_KEY="ed25519:..." in .env

import "dotenv/config";
import { StrKey } from "@stellar/stellar-sdk";
import {
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  UNTANGLED_LOOP_CONTRACT,
} from "./config.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  setPolicy,
  getPolicy,
  hexToBytes,
  normalizeAddress,
} from "./near.js";
import {
  APPROVE_SELECTOR,
  SUPPLY_COLLATERAL_SELECTOR,
  BORROW_SELECTOR,
  TRANSFER_SELECTOR,
  REPAY_SELECTOR,
  WITHDRAW_COLLATERAL_SELECTOR,
} from "./morpho.js";

// ── Policy Builders ──

/**
 * Policy 1: approve(address,uint256) on WETH — spender = Morpho
 * 100 bytes: value(32) + selector(4) + pad(12) + spender(20) + amount(32)
 */
function buildApprovePolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector = 095ea7b3
  mask[32] = 0xff; condition[32] = 0x09;
  mask[33] = 0xff; condition[33] = 0x5e;
  mask[34] = 0xff; condition[34] = 0xa7;
  mask[35] = 0xff; condition[35] = 0xb3;

  // Enforce spender = Morpho address at [48..68]
  const morphoBytes = hexToBytes(normalizeAddress(MORPHO_ADDRESS));
  for (let i = 0; i < 20; i++) {
    mask[48 + i] = 0xff;
    condition[48 + i] = morphoBytes[i]!;
  }

  return { selector: APPROVE_SELECTOR, mask, condition };
}

/**
 * Policy 2: supplyCollateral on Morpho
 * Enforce value == 0 + selector only. Allow any collateral amount and onBehalf.
 */
function buildSupplyCollateralPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  // supplyCollateral calldata is 292 bytes. Policy bytes = 32 (value) + 292 (calldata) = 324.
  // Mask length must EXACTLY match policy_bytes length for apply_mask_policy to pass.
  // We enforce: value(32) == 0 + selector(4) match. Rest = 0x00 (allow any).
  const totalLen = 324;
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector
  const sel = SUPPLY_COLLATERAL_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: SUPPLY_COLLATERAL_SELECTOR, mask, condition };
}

/**
 * Policy 3: borrow on Morpho
 * Enforce value == 0 + selector only.
 */
function buildBorrowPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  // borrow calldata is 292 bytes. Policy bytes = 32 (value) + 292 (calldata) = 324.
  const totalLen = 324;
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  const sel = BORROW_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: BORROW_SELECTOR, mask, condition };
}

/**
 * Policy 4: transfer(address,uint256) on USDC — permissive (any recipient)
 * Using Option A from the plan: mask[48..68] = 0x00 to allow any recipient.
 */
function buildUsdcTransferPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector = a9059cbb
  mask[32] = 0xff; condition[32] = 0xa9;
  mask[33] = 0xff; condition[33] = 0x05;
  mask[34] = 0xff; condition[34] = 0x9c;
  mask[35] = 0xff; condition[35] = 0xbb;

  // recipient [48..68] = 0x00 mask -> allow any
  // amount [68..100] = 0x00 mask -> allow any

  return { selector: TRANSFER_SELECTOR, mask, condition };
}

/**
 * Policy 5: invoke open_short on Untangled Loop
 * Enforce contract_id = Untangled Loop entrypoint at [0..32]. Allow any args.
 */
function buildOpenShortPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  // Decode the Soroban contract ID from StrKey to raw 32 bytes
  const contractIdBytes = Array.from(StrKey.decodeContract(UNTANGLED_LOOP_CONTRACT));
  const functionNameBytes = Array.from(Buffer.from("open_short"));

  // Policy bytes layout: contract_id(32) + function_name(10) + XDR-encoded args(0 if empty)
  // Total = 42 bytes. Mask must exactly match this length.
  const totalLen = 32 + functionNameBytes.length; // 42
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  // Enforce contract_id at [0..32]
  for (let i = 0; i < 32; i++) {
    mask[i] = 0xff;
    condition[i] = contractIdBytes[i]!;
  }

  // Bytes [32..42] are function name — mask 0x00 (allow any, already validated by selector match)

  const selector = Array.from(Buffer.from("open_short"));
  return { selector, mask, condition };
}

/**
 * Policy 6: approve(address,uint256) on USDC — spender = Morpho (for repay)
 * Same structure as WETH approve but on USDC contract.
 */
function buildApproveUsdcPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  mask[32] = 0xff; condition[32] = 0x09;
  mask[33] = 0xff; condition[33] = 0x5e;
  mask[34] = 0xff; condition[34] = 0xa7;
  mask[35] = 0xff; condition[35] = 0xb3;

  const morphoBytes = hexToBytes(normalizeAddress(MORPHO_ADDRESS));
  for (let i = 0; i < 20; i++) {
    mask[48 + i] = 0xff;
    condition[48 + i] = morphoBytes[i]!;
  }

  return { selector: APPROVE_SELECTOR, mask, condition };
}

/**
 * Policy 7: repay on Morpho
 * repay calldata is 324 bytes (same struct as supplyCollateral + extra fields).
 * Enforce value == 0 + selector only.
 */
function buildRepayPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const totalLen = 356; // 32 (value) + 324 (calldata: marketParams tuple + assets + shares + onBehalf + data offset + data length)
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  const sel = REPAY_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: REPAY_SELECTOR, mask, condition };
}

/**
 * Policy 8: withdrawCollateral on Morpho
 * Enforce value == 0 + selector only.
 */
function buildWithdrawCollateralPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const totalLen = 292; // 32 (value) + 260 (calldata)
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  const sel = WITHDRAW_COLLATERAL_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: WITHDRAW_COLLATERAL_SELECTOR, mask, condition };
}

/**
 * Policy 9: close_short on Untangled Loop (Stellar)
 */
function buildCloseShortPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const contractIdBytes = Array.from(StrKey.decodeContract(UNTANGLED_LOOP_CONTRACT));
  const functionNameBytes = Array.from(Buffer.from("close_short"));
  const totalLen = 32 + functionNameBytes.length;
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  for (let i = 0; i < 32; i++) {
    mask[i] = 0xff;
    condition[i] = contractIdBytes[i]!;
  }

  const selector = Array.from(Buffer.from("close_short"));
  return { selector, mask, condition };
}

// ── Main ──

interface PolicyDef {
  label: string;
  chain: string;
  contract: string;
  selector: number[];
  mask: number[];
  condition: number[];
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey && !dryRun) {
    console.error('MAINNET_KEY not set. Add MAINNET_KEY="ed25519:..." to .env');
    process.exit(1);
  }

  console.log("Deriving mainnet addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM:     ${addrs.evm.address}`);
  console.log(`  Stellar: ${addrs.stellar.address}`);
  console.log(`  Ed25519: ${addrs.stellar.ed25519PublicKeyHex}\n`);

  // Build all policy definitions
  const p1 = buildApprovePolicy();
  const p2 = buildSupplyCollateralPolicy();
  const p3 = buildBorrowPolicy();
  const p4 = buildUsdcTransferPolicy();
  const p5 = buildOpenShortPolicy();
  const p6 = buildApproveUsdcPolicy();
  const p7 = buildRepayPolicy();
  const p8 = buildWithdrawCollateralPolicy();
  const p9 = buildCloseShortPolicy();

  const policies: PolicyDef[] = [
    {
      label: "1. Approve WETH -> Morpho",
      chain: "Evm",
      contract: normalizeAddress(WETH_ADDRESS),
      ...p1,
    },
    {
      label: "2. Supply Collateral on Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p2,
    },
    {
      label: "3. Borrow USDC from Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p3,
    },
    {
      label: "4. Transfer USDC (bridge)",
      chain: "Evm",
      contract: normalizeAddress(USDC_ADDRESS),
      ...p4,
    },
    {
      label: "5. Open Short on Untangled Loop",
      chain: "Stellar",
      contract: addrs.stellar.ed25519PublicKeyHex,
      ...p5,
    },
    {
      label: "6. Approve USDC -> Morpho (for repay)",
      chain: "Evm",
      contract: normalizeAddress(USDC_ADDRESS),
      ...p6,
    },
    {
      label: "7. Repay on Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p7,
    },
    {
      label: "8. Withdraw Collateral from Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p8,
    },
    {
      label: "9. Close Short on Untangled Loop",
      chain: "Stellar",
      contract: addrs.stellar.ed25519PublicKeyHex,
      ...p9,
    },
  ];

  const account = dryRun
    ? await getMainnetAccount()
    : await getMainnetAccount(nearKey!);

  for (const pol of policies) {
    console.log(`Policy ${pol.label}`);
    console.log(`  chain:     ${pol.chain}`);
    console.log(`  contract:  ${pol.contract.slice(0, 20)}...`);
    console.log(`  selector:  [${pol.selector.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`);
    console.log(`  mask len:  ${pol.mask.length} bytes`);

    // Check if policy already exists with correct mask length
    const existing = await getPolicy(account, pol.chain, pol.contract, pol.selector);
    if (existing && existing.mask.length === pol.mask.length) {
      console.log(`  Status:    ALREADY SET (mask ${existing.mask.length}B) -- skipping\n`);
      continue;
    }
    if (existing) {
      console.log(`  Status:    EXISTS but wrong mask length (${existing.mask.length} != ${pol.mask.length}) -- updating...`);
    }

    if (dryRun) {
      console.log(`  Status:    NOT SET -- would register (dry run)\n`);
      continue;
    }

    console.log(`  Status:    NOT SET -- registering...`);
    await setPolicy(account, {
      chain: pol.chain,
      contract: pol.contract,
      selector: pol.selector,
      mask: pol.mask,
      condition: pol.condition,
      value_limit: null,
      expires_at: null,
    });
    console.log(`  Result:    REGISTERED\n`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
