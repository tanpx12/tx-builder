// ──────────────────────────────────────────────
// Main entry point
// ──────────────────────────────────────────────
//
// Usage:
//   npx tsx src/index.ts          # derive addresses + build test txs
//   npx tsx src/index.ts --init   # initialize the contract (run once)
//   npx tsx src/index.ts --sign   # derive + sign test txs (uses KEY from .env)
//
// Set KEY in .env to your NEAR ed25519 private key:
//   KEY="ed25519:..."
// ──────────────────────────────────────────────

import "dotenv/config";
import { deriveUniversalAccountAddresses } from "../core/derive.js";
import { buildEthTestTx, signEthTx } from "../core/eth.js";
import { buildStellarTestTx, signStellarTx } from "../core/stellar.js";
import { initContract } from "../core/near.js";

async function main() {
  const args = process.argv.slice(2);
  const initMode = args.includes("--init");
  const signMode = args.includes("--sign");
  const nearPrivateKey = process.env.KEY;

  console.log("+==============================================+");
  console.log("|   NEAR Chain Signature - TX Builder           |");
  console.log("+==============================================+");
  console.log();

  // ── Step 0: Initialize contract (if --init flag) ──
  if (initMode) {
    if (!nearPrivateKey) {
      console.error("ERROR: KEY not found in .env. Add your NEAR private key:");
      console.error('   KEY="ed25519:<YOUR_KEY>"');
      process.exit(1);
    }
    console.log("Initializing contract at testnet-deployer.testnet...");
    try {
      await initContract(nearPrivateKey);
      console.log("Contract initialized successfully!\n");
    } catch (e: any) {
      if (e.message?.includes("already been initialized") || e.message?.includes("Cannot deserialize")) {
        console.log("Contract is already initialized.\n");
      } else {
        console.error("Initialization failed:", e.message);
        process.exit(1);
      }
    }
  }

  // ── Step 1: Derive addresses ────────────────
  console.log("Deriving cross-chain addresses...\n");
  const addresses = await deriveUniversalAccountAddresses();

  console.log("\n+-------------------------------------------------+");
  console.log("|              DERIVED ADDRESSES                   |");
  console.log("+-------------------------------------------------+");
  console.log("| EVM (Sepolia):");
  console.log("|  ", addresses.evm.address);
  console.log("|");
  console.log("| Stellar (Testnet):");
  console.log("|  ", addresses.stellar.address);
  console.log("+-------------------------------------------------+");

  // ── Step 2: Build test transactions ─────────
  console.log("\n\nBuilding test transactions...\n");

  // Ethereum
  buildEthTestTx(addresses.evm.address);

  // Stellar
  buildStellarTestTx(addresses.stellar.address);

  // ── Step 3: Sign (if --sign flag provided) ──
  if (signMode) {
    if (!nearPrivateKey) {
      console.error("\nERROR: KEY not found in .env. Add your NEAR private key:");
      console.error('   KEY="ed25519:<YOUR_KEY>"');
      process.exit(1);
    }
    console.log("\n\nSigning transactions via MPC...");
    console.log("  Using KEY from .env\n");

    try {
      console.log("── Signing Ethereum TX ──");
      await signEthTx(addresses.evm.address, nearPrivateKey);
    } catch (e: any) {
      console.error("  ETH signing failed:", e.message);
    }

    try {
      console.log("\n── Signing Stellar TX ──");
      await signStellarTx(
        addresses.stellar.address,
        addresses.stellar.ed25519PublicKeyHex,
        nearPrivateKey
      );
    } catch (e: any) {
      console.error("  XLM signing failed:", e.message);
    }
  } else {
    console.log("\n\nTo request MPC signatures, run with:");
    console.log("    npx tsx src/index.ts --sign");
  }

  console.log("\nDone!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
