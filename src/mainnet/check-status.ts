// src/mainnet/check-status.ts
// CLI: Derive mainnet addresses, show balances, policy status, batch progress
//
// Usage:
//   npx tsx src/mainnet/check-status.ts                 # derive + show balances
//   npx tsx src/mainnet/check-status.ts policies        # show registered policies
//   npx tsx src/mainnet/check-status.ts batch <id>      # show batch status

import "dotenv/config";
import { ethers } from "ethers";
import { Horizon } from "@stellar/stellar-sdk";
import {
  ARB_RPC,
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  STELLAR_MAINNET_HORIZON,
  MAINNET_CONTRACT_ID,
} from "../config-mainnet.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  getPolicy,
} from "../near-mainnet.js";
import {
  APPROVE_SELECTOR,
  SUPPLY_COLLATERAL_SELECTOR,
  BORROW_SELECTOR,
  TRANSFER_SELECTOR,
} from "../morpho.js";

// ── Helpers ──

function normalizeAddr(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

function printPolicy(
  label: string,
  policy: { mask: number[]; condition: number[]; value_limit: string | null; expires_at: number | null } | null,
): void {
  if (!policy) {
    console.log(`  ${label}: NOT SET`);
    return;
  }
  console.log(`  ${label}: SET`);
  console.log(`    mask len:     ${policy.mask.length} bytes`);
  console.log(`    value_limit:  ${policy.value_limit ?? "none"}`);
  console.log(
    `    expires_at:   ${policy.expires_at ? new Date(policy.expires_at / 1_000_000).toISOString() : "never"}`,
  );
}

// ── Commands ──

async function cmdDefault(): Promise<void> {
  console.log("Deriving mainnet addresses...\n");
  const addrs = await deriveMainnetAddresses();

  console.log("EVM Address (Arbitrum):  ", addrs.evm.address);
  console.log("Stellar Address:         ", addrs.stellar.address);
  console.log("Stellar Ed25519 Hex:     ", addrs.stellar.ed25519PublicKeyHex);
  console.log();

  // Fetch EVM balances
  console.log("Fetching Arbitrum balances...");
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const [ethBalance, wethBalance, usdcBalance] = await Promise.all([
    provider.getBalance(addrs.evm.address),
    new ethers.Contract(WETH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(
      addrs.evm.address,
    ),
    new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf!(
      addrs.evm.address,
    ),
  ]);
  console.log(`  ETH:   ${ethers.formatEther(ethBalance)}`);
  console.log(`  WETH:  ${ethers.formatEther(wethBalance)}`);
  console.log(`  USDC:  ${ethers.formatUnits(usdcBalance, 6)}`);
  console.log();

  // Fetch Stellar balances
  console.log("Fetching Stellar balances...");
  const server = new Horizon.Server(STELLAR_MAINNET_HORIZON);
  try {
    const accountData = await server.loadAccount(addrs.stellar.address);
    for (const bal of accountData.balances) {
      if ((bal as any).asset_type === "native") {
        console.log(`  XLM:   ${(bal as any).balance}`);
      } else {
        console.log(`  ${(bal as any).asset_code}:  ${(bal as any).balance} (issuer: ${(bal as any).asset_issuer?.slice(0, 10)}...)`);
      }
    }
  } catch {
    console.log("  Account not found or not funded");
  }
}

async function cmdPolicies(): Promise<void> {
  console.log("Checking registered policies...\n");
  const addrs = await deriveMainnetAddresses();
  const account = await getMainnetAccount();

  // Policy 1: approve WETH
  const p1 = await getPolicy(account, "Evm", normalizeAddr(WETH_ADDRESS), APPROVE_SELECTOR);
  printPolicy("EVM: approve WETH -> Morpho", p1);

  // Policy 2: supplyCollateral
  const p2 = await getPolicy(account, "Evm", normalizeAddr(MORPHO_ADDRESS), SUPPLY_COLLATERAL_SELECTOR);
  printPolicy("EVM: supplyCollateral on Morpho", p2);

  // Policy 3: borrow
  const p3 = await getPolicy(account, "Evm", normalizeAddr(MORPHO_ADDRESS), BORROW_SELECTOR);
  printPolicy("EVM: borrow from Morpho", p3);

  // Policy 4: USDC transfer (bridge)
  const p4 = await getPolicy(account, "Evm", normalizeAddr(USDC_ADDRESS), TRANSFER_SELECTOR);
  printPolicy("EVM: transfer USDC (bridge)", p4);

  // Policy 5: open_short on Untangled Loop
  const openShortSelector = Array.from(Buffer.from("open_short"));
  const p5 = await getPolicy(account, "Stellar", addrs.stellar.ed25519PublicKeyHex, openShortSelector);
  printPolicy("Stellar: open_short on Untangled Loop", p5);
}

async function cmdBatch(args: string[]): Promise<void> {
  const batchId = parseInt(args[0] ?? "");
  if (isNaN(batchId)) {
    console.error("Usage: check-status.ts batch <batch-id>");
    process.exit(1);
  }
  const account = await getMainnetAccount();
  const status = await account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_batch_status",
    args: { batch_id: batchId },
  });
  console.log("Batch status:", JSON.stringify(status, null, 2));
}

// ── Main ──

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "policies":
      await cmdPolicies();
      break;
    case "batch":
      await cmdBatch(args);
      break;
    default:
      await cmdDefault();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
