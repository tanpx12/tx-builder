// ──────────────────────────────────────────────
// Address derivation from MPC root public key + derivation path
// Uses NEAR Chain Signatures key derivation (KDF)
//
// EVM uses key_version: 0 (secp256k1) — the MPC derives a child secp256k1 key.
// Stellar uses key_version: 1 (Ed25519) — the MPC derives a child Ed25519 key
// natively, so the Stellar address is derived directly from the MPC Ed25519
// public key without any local seed workaround.
// ──────────────────────────────────────────────

import elliptic from "elliptic";
const { ec: EC } = elliptic;
import { sha256 } from "js-sha256";
import { ethers } from "ethers";
import { Keypair as StellarKeypair, StrKey } from "@stellar/stellar-sdk";
import { NEAR_ACCOUNT_ID, MPC_CONTRACT_ID, DERIVATION_PATHS } from "./config.js";
import { fetchMpcPublicKey, getNearAccount } from "./near.js";

const secp256k1 = new EC("secp256k1");

// ── helpers ──────────────────────────────────

/**
 * Parse the MPC contract public key string ("secp256k1:BASE58..." or "ed25519:BASE58...")
 * into a hex string. For secp256k1, returns uncompressed (04 + x + y, 130 hex chars).
 * For Ed25519, returns the raw 32-byte public key as hex (64 hex chars).
 */
export function parseMpcPublicKey(raw: string): string {
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  // secp256k1: 64 bytes (x || y) — prepend 04 for uncompressed form
  if (keyBytes.length === 64 && raw.startsWith("secp256k1:")) {
    return "04" + Buffer.from(keyBytes).toString("hex");
  }
  return Buffer.from(keyBytes).toString("hex");
}

/** Base58 decode (no checksum) */
function bs58Decode(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let result = BigInt(0);
  for (const char of str) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`Invalid base58 char: ${char}`);
    result = result * BigInt(58) + BigInt(idx);
  }
  const hex = result.toString(16);
  const bytes = Buffer.from(hex.length % 2 ? "0" + hex : hex, "hex");
  let leadingZeros = 0;
  for (const c of str) {
    if (c === "1") leadingZeros++;
    else break;
  }
  return Uint8Array.from([...new Uint8Array(leadingZeros), ...bytes]);
}

/**
 * NEAR chain-signature KDF: derives a child secp256k1 public key.
 *
 *   epsilon = sha256("near-mpc-recovery v0.1.0 epsilon derivation:<accountId>,<path>")
 *   child   = rootPoint + epsilon * G
 *
 * This mirrors the derivation the MPC nodes perform internally for key_version: 0.
 */
export function deriveChildPublicKey(
  rootPublicKeyHex: string,
  accountId: string,
  path: string
): { publicKeyHex: string; publicKeyBytes: Uint8Array } {
  const preimage = `near-mpc-recovery v0.1.0 epsilon derivation:${accountId},${path}`;
  const epsilonHex = sha256(preimage);
  const epsilonMod = BigInt("0x" + epsilonHex) % BigInt(secp256k1.n!.toString());

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

// ── Chain-specific address converters ────────

/**
 * EVM address from an uncompressed secp256k1 public key.
 * Standard: keccak256(pubkey[1:]) → last 20 bytes, EIP-55 checksummed.
 */
export function publicKeyToEvmAddress(uncompressedHex: string): string {
  return ethers.computeAddress("0x" + uncompressedHex);
}

/** Compress a 65-byte (04-prefixed) uncompressed secp256k1 public key to 33 bytes. */
function compressPublicKey(uncompressedHex: string): Buffer {
  const point = secp256k1.keyFromPublic(uncompressedHex, "hex").getPublic();
  return Buffer.from(point.encodeCompressed("hex"), "hex");
}

/**
 * Stellar address from a raw 32-byte Ed25519 public key (hex).
 *
 * The MPC signer natively supports Ed25519 (key_version/domain_id: 1).
 * The `derived_public_key` view function returns an Ed25519 public key
 * when called with key_version: 1, and the MPC signs with that key directly.
 *
 * Returns the standard Stellar StrKey public key (G...) and the raw
 * 32-byte Ed25519 public key as hex (needed as source_account in XDR builders).
 */
export function ed25519PublicKeyToStellarAddress(ed25519PublicKeyHex: string): {
  address: string;
  ed25519PublicKeyHex: string;
} {
  const pubKeyBytes = Buffer.from(ed25519PublicKeyHex, "hex");
  if (pubKeyBytes.length !== 32) {
    throw new Error(`Expected 32-byte Ed25519 public key, got ${pubKeyBytes.length} bytes`);
  }
  const address = StrKey.encodeEd25519PublicKey(pubKeyBytes);
  return {
    address,
    ed25519PublicKeyHex,
  };
}

/**
 * @deprecated Use ed25519PublicKeyToStellarAddress() with the MPC Ed25519 key instead.
 * This legacy function derived a Stellar address from a secp256k1 key via SHA-256 hash,
 * which was insecure because the Ed25519 "private key" was publicly derivable.
 */
export function publicKeyToStellarAddress(uncompressedHex: string): {
  address: string;
  ed25519PublicKeyHex: string;
} {
  const compressed = compressPublicKey(uncompressedHex);
  const seed = Buffer.from(sha256.arrayBuffer(compressed)).subarray(0, 32);
  const keypair = StellarKeypair.fromRawEd25519Seed(seed);
  return {
    address: keypair.publicKey(),
    ed25519PublicKeyHex: Buffer.from(keypair.rawPublicKey()).toString("hex"),
  };
}

// ── Main derivation function ─────────────────

export interface DerivedAddresses {
  evm: {
    address: string;
    /** Uncompressed secp256k1 public key (04 + x + y) */
    publicKeyHex: string;
    derivationPath: string;
  };
  stellar: {
    /** Stellar StrKey public key (G...) */
    address: string;
    /** Raw 32-byte Ed25519 public key hex — use as source_account in XDR builders */
    ed25519PublicKeyHex: string;
    derivationPath: string;
  };
  mpcRootPublicKey: string;
}

/**
 * Fetch the authoritative child public key directly from the MPC signer contract.
 * The `derived_public_key` view function applies the same KDF the MPC nodes use
 * internally, so the result is guaranteed to match what actually gets used for signing.
 *
 * For key_version 0 (secp256k1): returns uncompressed secp256k1 hex (04 + x + y).
 * For key_version 1 (Ed25519): returns raw 32-byte Ed25519 public key hex.
 */
async function fetchDerivedPublicKey(
  path: string,
  predecessor: string,
  keyVersion: number = 0
): Promise<string> {
  const account = await getNearAccount(); // read-only — no private key needed
  const result: string = await account.viewFunction({
    contractId: MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path, predecessor, key_version: keyVersion },
  });
  // result is "secp256k1:<base58(x||y)>" or "ed25519:<base58(key)>"
  return parseMpcPublicKey(result);
}

export async function deriveUniversalAccountAddresses(): Promise<DerivedAddresses> {
  console.log("Fetching MPC root public key...");
  const rawMpcKey = await fetchMpcPublicKey();
  console.log("  Raw MPC public key:", rawMpcKey);

  const rootKeyHex = parseMpcPublicKey(rawMpcKey);
  console.log("  Parsed root key (uncompressed hex):", rootKeyHex.slice(0, 20) + "...");

  console.log("\n  Derivation paths (matching contract build_derivation_path):");
  console.log("    EVM:", DERIVATION_PATHS.ethereum);
  console.log("    XLM:", DERIVATION_PATHS.stellar);

  // EVM: key_version 0 (secp256k1)
  const evmChildHex = await fetchDerivedPublicKey(DERIVATION_PATHS.ethereum, NEAR_ACCOUNT_ID, 0);

  // Stellar: key_version 1 (Ed25519) — MPC natively derives Ed25519 public key
  const xlmEd25519Hex = await fetchDerivedPublicKey(DERIVATION_PATHS.stellar, NEAR_ACCOUNT_ID, 1);

  const evmAddress = publicKeyToEvmAddress(evmChildHex);
  const stellar = ed25519PublicKeyToStellarAddress(xlmEd25519Hex);

  return {
    evm: {
      address: evmAddress,
      publicKeyHex: evmChildHex,
      derivationPath: DERIVATION_PATHS.ethereum,
    },
    stellar: {
      address: stellar.address,
      ed25519PublicKeyHex: stellar.ed25519PublicKeyHex,
      derivationPath: DERIVATION_PATHS.stellar,
    },
    mpcRootPublicKey: rawMpcKey,
  };
}

/** @deprecated Use deriveUniversalAccountAddresses() */
export const deriveAllAddresses = deriveUniversalAccountAddresses;
