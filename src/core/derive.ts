// ──────────────────────────────────────────────
// Address derivation from MPC root public key + derivation path
// Uses NEAR Chain Signatures key derivation (KDF)
//
// Both EVM and Stellar use key_version: 0 (secp256k1) in the asset-manager
// contract's request_signature() — this is hard-coded in signing.rs.
// The NEAR chain-sig KDF produces a child secp256k1 key for both chains.
//
// Stellar address: SHA-256 of the compressed secp256k1 child key → 32-byte
// Ed25519 seed → Stellar keypair. This gives a deterministic, reproducible
// Stellar G... address tied to the derivation path.
// ──────────────────────────────────────────────

import elliptic from "elliptic";
const { ec: EC } = elliptic;
import { sha256 } from "js-sha256";
import { ethers } from "ethers";
import { Keypair as StellarKeypair } from "@stellar/stellar-sdk";
import { NEAR_ACCOUNT_ID, MPC_CONTRACT_ID, DERIVATION_PATHS } from "./config.js";
import { fetchMpcPublicKey, getNearAccount } from "./near.js";

const secp256k1 = new EC("secp256k1");

// ── helpers ──────────────────────────────────

/**
 * Parse the MPC contract public key string ("secp256k1:BASE58...")
 * into an uncompressed hex public key (04 + x + y, 130 hex chars).
 */
function parseMpcPublicKey(raw: string): string {
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  // keyBytes is 64 bytes (x || y) — prepend 04 for uncompressed form
  if (keyBytes.length === 64) {
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
 * Stellar address from an uncompressed secp256k1 public key.
 *
 * NOTE: v1.signer-prod.testnet only supports secp256k1 (key_version: 0). There is no
 * Ed25519 MPC signing available. This function derives a deterministic Stellar Ed25519
 * address from the secp256k1 child key via SHA-256 of the compressed key as the Ed25519
 * seed. The MPC cannot sign transactions from this Stellar account — this address is
 * display-only until the MPC adds Ed25519 support.
 *
 * Returns the standard Stellar StrKey public key (G...).
 * Also returns the raw 32-byte Ed25519 public key as hex — needed as the
 * source_account field in build_stellar_payment_payload / build_stellar_invoke_contract_payload.
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
    // Raw 32-byte Ed25519 public key (no StrKey encoding) — used as source_account in XDR
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
    /** Underlying secp256k1 child key the Ed25519 seed was derived from */
    secp256k1PublicKeyHex: string;
    derivationPath: string;
  };
  mpcRootPublicKey: string;
}

/**
 * Fetch the authoritative child secp256k1 public key directly from the MPC signer contract.
 * The `derived_public_key` view function applies the same KDF the MPC nodes use
 * internally, so the result is guaranteed to match what actually gets used for signing.
 *
 * Returns the uncompressed secp256k1 public key as a hex string (04 + x + y).
 *
 * NOTE: v1.signer-prod.testnet only supports secp256k1 (key_version: 0). Passing
 * key_version: 1 is silently ignored — the same secp256k1 key is returned.
 */
async function fetchDerivedPublicKey(path: string, predecessor: string): Promise<string> {
  const account = await getNearAccount(); // read-only — no private key needed
  const result: string = await account.viewFunction({
    contractId: MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path, predecessor },
  });
  // result is "secp256k1:<base58(x||y)>"
  return parseMpcPublicKey(result);
}

export async function deriveUniversalAccountAddresses(): Promise<DerivedAddresses> {
  console.log("Fetching MPC root public key (secp256k1, key_version: 0)...");
  const rawMpcKey = await fetchMpcPublicKey();
  console.log("  Raw MPC public key:", rawMpcKey);

  const rootKeyHex = parseMpcPublicKey(rawMpcKey);
  console.log("  Parsed root key (uncompressed hex):", rootKeyHex.slice(0, 20) + "...");

  console.log("\n  Derivation paths (matching contract build_derivation_path):");
  console.log("    EVM:", DERIVATION_PATHS.ethereum);
  console.log("    XLM:", DERIVATION_PATHS.stellar);

  // Use derived_public_key from the MPC contract — this is the ground-truth child key
  // that the MPC nodes actually sign with.  Local KDF re-implementation diverges from
  // the MPC's internal formula, so we always fetch authoritative values here.
  const evmChildHex = await fetchDerivedPublicKey(DERIVATION_PATHS.ethereum, NEAR_ACCOUNT_ID);
  const xlmChildHex = await fetchDerivedPublicKey(DERIVATION_PATHS.stellar, NEAR_ACCOUNT_ID);

  const evmAddress = publicKeyToEvmAddress(evmChildHex);
  const stellar = publicKeyToStellarAddress(xlmChildHex);

  return {
    evm: {
      address: evmAddress,
      publicKeyHex: evmChildHex,
      derivationPath: DERIVATION_PATHS.ethereum,
    },
    stellar: {
      address: stellar.address,
      ed25519PublicKeyHex: stellar.ed25519PublicKeyHex,
      secp256k1PublicKeyHex: xlmChildHex,
      derivationPath: DERIVATION_PATHS.stellar,
    },
    mpcRootPublicKey: rawMpcKey,
  };
}

/** @deprecated Use deriveUniversalAccountAddresses() */
export const deriveAllAddresses = deriveUniversalAccountAddresses;
