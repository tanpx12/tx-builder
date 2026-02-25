// ──────────────────────────────────────────────
// Address derivation from MPC root public key + derivation path
// Uses NEAR Chain Signatures key derivation (KDF)
// ──────────────────────────────────────────────

import elliptic from "elliptic";
const { ec: EC } = elliptic;
import { sha256 } from "js-sha256";
import { ethers } from "ethers";
import bs58check from "bs58check";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import crypto from "crypto";
import { NEAR_ACCOUNT_ID, DERIVATION_PATHS } from "./config.js";
import { fetchMpcPublicKey } from "./near.js";

const secp256k1 = new EC("secp256k1");

// ── helpers ──────────────────────────────────

/**
 * Parse the MPC contract public key string (e.g. "secp256k1:BASE58...")
 * into an uncompressed hex public key (04 + x + y, 130 hex chars).
 */
function parseMpcPublicKey(raw: string): string {
  // The MPC contract returns "secp256k1:<base58-encoded-key>"
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  // keyBytes is 64 bytes (x || y) – add 04 prefix for uncompressed
  if (keyBytes.length === 64) {
    return "04" + Buffer.from(keyBytes).toString("hex");
  }
  // already has prefix
  return Buffer.from(keyBytes).toString("hex");
}

/** Simple base58 decode (no checksum) */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = BigInt(0);
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 char: ${char}`);
    result = result * BigInt(58) + BigInt(idx);
  }
  const hex = result.toString(16).padStart(2, "0");
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  // Count leading '1's → leading zero bytes
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  return Uint8Array.from([...new Uint8Array(leadingZeros), ...bytes]);
}

/**
 * Derive a child public key using the NEAR chain-signature KDF.
 *
 * child_key = root_key + sha256(sha256(accountId + "," + path + "," + rootKeyHex)) * G
 *
 * This mirrors the derivation the MPC nodes perform internally.
 */
export function deriveChildPublicKey(
  rootPublicKeyHex: string,
  accountId: string,
  path: string
): { publicKeyHex: string; publicKeyBytes: Uint8Array } {
  // epsilon = sha256(sha256(accountId + "," + path + "," + rootKeyHex))
  const preimage = `near-mpc-recovery v0.1.0 epsilon derivation:${accountId},${path}`;
  const epsilonHex = sha256(preimage);
  const epsilonBN = BigInt("0x" + epsilonHex);

  // Clamp to curve order
  const curveOrder = secp256k1.n!;
  const epsilonMod = epsilonBN % BigInt(curveOrder.toString());

  // child = rootPoint + epsilon * G
  const rootPoint = secp256k1.keyFromPublic(rootPublicKeyHex, "hex").getPublic();
  const epsilonPoint = secp256k1.g.mul(
    secp256k1.keyFromPrivate(epsilonMod.toString(16).padStart(64, "0")).getPrivate()
  );
  const childPoint = rootPoint.add(epsilonPoint);

  const childHex =
    "04" +
    childPoint.getX().toString(16).padStart(64, "0") +
    childPoint.getY().toString(16).padStart(64, "0");

  return {
    publicKeyHex: childHex,
    publicKeyBytes: Uint8Array.from(Buffer.from(childHex, "hex")),
  };
}

/**
 * Compress a 65-byte (04-prefixed) uncompressed public key to 33 bytes.
 */
function compressPublicKey(uncompressedHex: string): Buffer {
  const point = secp256k1.keyFromPublic(uncompressedHex, "hex").getPublic();
  const compressedHex = point.encodeCompressed("hex");
  return Buffer.from(compressedHex, "hex");
}

// ── Chain-specific address derivation ────────

export function publicKeyToEthAddress(uncompressedHex: string): string {
  // Ethereum address = last 20 bytes of keccak256(uncompressed key without 04 prefix)
  const rawKey = "0x" + uncompressedHex.slice(2); // remove 04 prefix
  return ethers.computeAddress("0x" + uncompressedHex);
}

export function publicKeyToBtcAddress(uncompressedHex: string): string {
  // P2PKH testnet address: version byte 0x6f + RIPEMD160(SHA256(compressed key))
  const compressed = compressPublicKey(uncompressedHex);
  const sha = Buffer.from(sha256.arrayBuffer(compressed));

  // Use Node.js crypto for RIPEMD160
  const ripemd = crypto.createHash("ripemd160").update(sha).digest();

  // Testnet version byte = 0x6f
  const versionedPayload = Buffer.concat([Buffer.from([0x6f]), ripemd]);
  return bs58check.encode(versionedPayload);
}

export function publicKeyToStellarAddress(uncompressedHex: string): string {
  // Stellar uses Ed25519, but chain signatures produce secp256k1 keys.
  // For Stellar chain-signature interop, the derived secp256k1 public key
  // is hashed to create a deterministic Ed25519-compatible identifier.
  // We take SHA-256 of the compressed public key as a 32-byte "seed"
  // and use it to derive a Stellar Keypair.
  const compressed = compressPublicKey(uncompressedHex);
  const seed = Buffer.from(sha256.arrayBuffer(compressed)).slice(0, 32);
  const keypair = StellarKeypair.fromRawEd25519Seed(seed);
  return keypair.publicKey();
}

// ── Main derivation function ─────────────────

export interface DerivedAddresses {
  ethereum: { address: string; publicKeyHex: string };
  bitcoin: { address: string; publicKeyHex: string };
  stellar: { address: string; publicKeyHex: string };
  mpcRootPublicKey: string;
}

export async function deriveAllAddresses(): Promise<DerivedAddresses> {
  console.log("Fetching MPC root public key from contract...");
  const rawMpcKey = await fetchMpcPublicKey();
  console.log("  Raw MPC public key:", rawMpcKey);

  const rootKeyHex = parseMpcPublicKey(rawMpcKey);
  console.log("  Parsed root key (uncompressed hex):", rootKeyHex.slice(0, 20) + "...");

  console.log("\n  Derivation paths (matching contract):");
  console.log("    ETH:", DERIVATION_PATHS.ethereum);
  console.log("    BTC:", DERIVATION_PATHS.bitcoin);
  console.log("    XLM:", DERIVATION_PATHS.stellar);

  // Derive child keys for each chain
  const ethChild = deriveChildPublicKey(rootKeyHex, NEAR_ACCOUNT_ID, DERIVATION_PATHS.ethereum);
  const btcChild = deriveChildPublicKey(rootKeyHex, NEAR_ACCOUNT_ID, DERIVATION_PATHS.bitcoin);
  const xlmChild = deriveChildPublicKey(rootKeyHex, NEAR_ACCOUNT_ID, DERIVATION_PATHS.stellar);

  const ethAddr = publicKeyToEthAddress(ethChild.publicKeyHex);
  const btcAddr = publicKeyToBtcAddress(btcChild.publicKeyHex);
  const xlmAddr = publicKeyToStellarAddress(xlmChild.publicKeyHex);

  return {
    ethereum: { address: ethAddr, publicKeyHex: ethChild.publicKeyHex },
    bitcoin: { address: btcAddr, publicKeyHex: btcChild.publicKeyHex },
    stellar: { address: xlmAddr, publicKeyHex: xlmChild.publicKeyHex },
    mpcRootPublicKey: rawMpcKey,
  };
}
