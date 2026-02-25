// ──────────────────────────────────────────────
// Stellar (Testnet) – build & sign test transaction
// ──────────────────────────────────────────────

import {
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Account,
  Memo,
} from "@stellar/stellar-sdk";
import { sha256 } from "js-sha256";
import elliptic from "elliptic";

const { ec: EC } = elliptic;

import { STELLAR_HORIZON, STELLAR_NETWORK_PASSPHRASE } from "./config.js";
import { requestSignature } from "./near.js";

const secp256k1 = new EC("secp256k1");

/**
 * For Stellar, the asset-manager contract uses domain_id=1 (Ed25519).
 * The MPC signer derives an Ed25519 keypair from the derivation path,
 * so the resulting Stellar address is an Ed25519 public key.
 *
 * The address derivation uses the same KDF as secp256k1 but produces
 * an Ed25519 public key. For client-side derivation, we hash the
 * secp256k1 child key to get a deterministic Ed25519 seed.
 */

/**
 * Compress a secp256k1 public key
 */
function compressPublicKey(uncompressedHex: string): Buffer {
  const point = secp256k1.keyFromPublic(uncompressedHex, "hex").getPublic();
  return Buffer.from(point.encodeCompressed("hex"), "hex");
}

/**
 * Derive a Stellar keypair from the secp256k1 public key.
 * Takes SHA-256 of the compressed secp256k1 key as a 32-byte Ed25519 seed.
 */
export function deriveKeypairFromPublicKey(publicKeyHex: string): Keypair {
  const compressed = compressPublicKey(publicKeyHex);
  const seed = Buffer.from(sha256.arrayBuffer(compressed)).slice(0, 32);
  return Keypair.fromRawEd25519Seed(seed);
}

/**
 * Build a minimal Stellar test transaction (self-payment of 0 XLM).
 * Uses a dummy sequence number since we may not have a funded account.
 */
export function buildStellarTestTx(stellarAddress: string) {
  // Create a source account with a dummy sequence number
  const sourceAccount = new Account(stellarAddress, "0");

  const builder = new TransactionBuilder(sourceAccount, {
    fee: "100", // 100 stroops = 0.00001 XLM
    networkPassphrase: Networks.TESTNET,
  });

  // Add a self-payment operation (0.0001 XLM to self)
  builder.addOperation(
    Operation.payment({
      destination: stellarAddress,
      asset: Asset.native(),
      amount: "0.0001",
    })
  );

  builder.addMemo(Memo.text("chain-sig-test"));
  builder.setTimeout(300); // 5 minutes

  const tx = builder.build();
  const txHash = tx.hash();
  const payload = Array.from(txHash);

  console.log("\n── Stellar Test Transaction ──");
  console.log("  Source:", stellarAddress);
  console.log("  Destination:", stellarAddress, "(self-payment)");
  console.log("  Amount: 0.0001 XLM");
  console.log("  Network: Testnet");
  console.log("  Transaction hash:", Buffer.from(txHash).toString("hex"));
  console.log("  XDR (unsigned):", tx.toXDR());

  return { tx, txHash, payload };
}

/**
 * Sign the Stellar test transaction.
 *
 * The asset-manager contract sends domain_id=1 (Ed25519) to the MPC signer.
 * The MPC signer produces an Ed25519 signature directly.
 *
 * For this test we also demonstrate local signing with the derived keypair.
 */
export async function signStellarTx(
  stellarAddress: string,
  publicKeyHex: string,
  nearPrivateKey?: string
): Promise<string> {
  const { tx, payload, txHash } = buildStellarTestTx(stellarAddress);

  // Approach (b): Sign with the derived Ed25519 keypair
  const keypair = deriveKeypairFromPublicKey(publicKeyHex);
  tx.sign(keypair);

  console.log("\n  Signed with derived Ed25519 keypair");
  console.log("  XDR (signed):", tx.toXDR());

  // If a NEAR private key is provided, also demonstrate the MPC signature request
  if (nearPrivateKey) {
    console.log("\n  Additionally requesting signature via testnet-deployer.testnet contract (Ed25519)...");
    try {
      const sig = await requestSignature(payload, "Stellar", nearPrivateKey);
      console.log("  MPC signature received:");
      console.log("    big_r:", JSON.stringify(sig.big_r));
      console.log("    s:", sig.s);
      console.log("    recovery_id:", sig.recovery_id);
    } catch (e: any) {
      console.log("  MPC signature request failed (expected if no NEAR key):", e.message);
    }
  } else {
    console.log("\n  Skipping MPC signature (no NEAR private key provided).");
    console.log("  Payload (tx hash) that would be sent to MPC:");
    console.log("   ", Buffer.from(txHash).toString("hex"));
  }

  return tx.toXDR();
}
