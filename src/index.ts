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
import { deriveAllAddresses } from "./derive.js";
import { buildEthTestTx, signEthTx } from "./eth.js";
import { buildBtcTestTx, signBtcTx } from "./btc.js";
import { buildStellarTestTx, signStellarTx } from "./stellar.js";
import { initContract } from "./near.js";

async function main() {
  const args = process.argv.slice(2);
  const initMode = args.includes("--init");
  const signMode = args.includes("--sign");
  const nearPrivateKey = process.env.KEY;

  console.log("╔═══════════════════════════════════════════════╗");
  console.log("║   NEAR Chain Signature - TX Builder           ║");
  console.log("╚═══════════════════════════════════════════════╝");
  console.log();

  // ── Step 0: Initialize contract (if --init flag) ──
  if (initMode) {
    if (!nearPrivateKey) {
      console.error("❌ KEY not found in .env. Add your NEAR private key:");
      console.error('   KEY="ed25519:<YOUR_KEY>"');
      process.exit(1);
    }
    console.log("🛠️  Initializing contract at", "testnet-deployer.testnet...");
    try {
      await initContract(nearPrivateKey);
      console.log("✅ Contract initialized successfully!\n");
    } catch (e: any) {
      if (e.message?.includes("already been initialized") || e.message?.includes("Cannot deserialize")) {
        console.log("ℹ️  Contract is already initialized.\n");
      } else {
        console.error("❌ Initialization failed:", e.message);
        process.exit(1);
      }
    }
  }

  // ── Step 1: Derive addresses ────────────────
  console.log("🔑 Deriving cross-chain addresses...\n");
  const addresses = await deriveAllAddresses();

  console.log("\n┌─────────────────────────────────────────────────┐");
  console.log("│              DERIVED ADDRESSES                   │");
  console.log("├─────────────────────────────────────────────────┤");
  console.log("│ Ethereum (Sepolia):");
  console.log("│  ", addresses.ethereum.address);
  console.log("│");
  console.log("│ Bitcoin (Testnet):");
  console.log("│  ", addresses.bitcoin.address);
  console.log("│");
  console.log("│ Stellar (Testnet):");
  console.log("│  ", addresses.stellar.address);
  console.log("└─────────────────────────────────────────────────┘");

  // ── Step 2: Build test transactions ─────────
  console.log("\n\n📝 Building test transactions...\n");

  // Ethereum
  buildEthTestTx(addresses.ethereum.address);

  // Bitcoin
  buildBtcTestTx(addresses.bitcoin.address, addresses.bitcoin.publicKeyHex);

  // Stellar
  buildStellarTestTx(addresses.stellar.address);

  // ── Step 3: Sign (if --sign flag provided) ──
  if (signMode) {
    if (!nearPrivateKey) {
      console.error("\n❌ KEY not found in .env. Add your NEAR private key:");
      console.error('   KEY="ed25519:<YOUR_KEY>"');
      process.exit(1);
    }
    console.log("\n\n✍️  Signing transactions via MPC...");
    console.log("  Using KEY from .env\n");

    try {
      console.log("── Signing Ethereum TX ──");
      await signEthTx(addresses.ethereum.address, nearPrivateKey);
    } catch (e: any) {
      console.error("  ETH signing failed:", e.message);
    }

    try {
      console.log("\n── Signing Bitcoin TX ──");
      await signBtcTx(
        addresses.bitcoin.address,
        addresses.bitcoin.publicKeyHex,
        nearPrivateKey
      );
    } catch (e: any) {
      console.error("  BTC signing failed:", e.message);
    }

    try {
      console.log("\n── Signing Stellar TX ──");
      await signStellarTx(
        addresses.stellar.address,
        addresses.stellar.publicKeyHex,
        nearPrivateKey
      );
    } catch (e: any) {
      console.error("  XLM signing failed:", e.message);
    }
  } else {
    console.log("\n\nℹ️  To request MPC signatures, run with:");
    console.log("    npx tsx src/index.ts --sign");
  }

  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
