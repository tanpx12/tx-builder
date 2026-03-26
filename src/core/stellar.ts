// ──────────────────────────────────────────────
// Stellar – build & sign transactions via MPC Ed25519
//
// The MPC signer supports Ed25519 natively (domain_id/key_version: 1).
// Stellar transactions are signed by requesting an Ed25519 signature from
// the MPC, then attaching the 64-byte (R || S) signature to the transaction
// envelope. No local keypair is involved.
// ──────────────────────────────────────────────

import {
  TransactionBuilder,
  Networks,
  Operation,
  Asset,
  Account,
  Memo,
  Transaction,
  xdr,
} from "@stellar/stellar-sdk";

import { STELLAR_HORIZON, STELLAR_NETWORK_PASSPHRASE } from "./config.js";
import { requestSignature } from "./near.js";

/**
 * MPC signature response shape for Ed25519.
 * big_r.affine_point contains the R component (may have a prefix byte).
 * s.scalar contains the S component.
 * Together they form the 64-byte Ed25519 signature (R || S).
 */
export interface MpcEd25519Signature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/**
 * Extract a 64-byte Ed25519 signature (R || S) from the MPC response.
 *
 * The MPC returns big_r.affine_point as a hex string that may have a
 * compressed-key prefix byte (02/03). For Ed25519, R is 32 bytes.
 * If the affine_point is 66 hex chars (33 bytes with prefix), strip the
 * first byte. S is always 32 bytes from s.scalar.
 */
export function extractEd25519Signature(sig: MpcEd25519Signature): Buffer {
  let rHex = sig.big_r.affine_point;
  // Strip compressed-key prefix byte if present (33 bytes = 66 hex chars)
  if (rHex.length === 66) {
    rHex = rHex.slice(2);
  }
  const sHex = sig.s.scalar;

  const r = Buffer.from(rHex, "hex");
  const s = Buffer.from(sHex, "hex");

  if (r.length !== 32) {
    throw new Error(`Expected 32-byte R, got ${r.length} bytes (hex: ${rHex})`);
  }
  if (s.length !== 32) {
    throw new Error(`Expected 32-byte S, got ${s.length} bytes (hex: ${sHex})`);
  }

  return Buffer.concat([r, s]);
}

/**
 * Attach an MPC Ed25519 signature to a Stellar transaction.
 *
 * This creates a DecoratedSignature with the last 4 bytes of the Ed25519
 * public key as the hint, and the 64-byte (R || S) signature as the value.
 */
export function attachMpcEd25519Signature(
  tx: Transaction,
  ed25519PublicKeyHex: string,
  mpcSig: MpcEd25519Signature
): void {
  const sigBytes = extractEd25519Signature(mpcSig);
  const pubKeyBytes = Buffer.from(ed25519PublicKeyHex, "hex");

  // Signature hint = last 4 bytes of the Ed25519 public key
  const hint = pubKeyBytes.subarray(pubKeyBytes.length - 4);

  const decoratedSig = new xdr.DecoratedSignature({
    hint: xdr.SignatureHint.fromXDR(hint),
    signature: sigBytes,
  });

  // Access the envelope and append the signature
  const envelope = tx.toEnvelope();
  if (envelope.switch() === xdr.EnvelopeType.envelopeTypeTxV0()) {
    envelope.v0().signatures().push(decoratedSig);
  } else {
    envelope.v1().signatures().push(decoratedSig);
  }
}

/**
 * Build a minimal Stellar test transaction (self-payment of 0.0001 XLM).
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
 * Sign a Stellar test transaction via MPC Ed25519.
 *
 * Requests an Ed25519 signature from the MPC signer (key_version: 1)
 * and attaches it to the Stellar transaction envelope.
 */
export async function signStellarTx(
  stellarAddress: string,
  ed25519PublicKeyHex: string,
  nearPrivateKey?: string
): Promise<string> {
  const { tx, payload, txHash } = buildStellarTestTx(stellarAddress);

  if (nearPrivateKey) {
    console.log("\n  Requesting Ed25519 signature from MPC signer...");
    try {
      const sig = await requestSignature(payload, "Stellar", nearPrivateKey);
      console.log("  MPC Ed25519 signature received:");
      console.log("    big_r:", JSON.stringify(sig.big_r));
      console.log("    s:", sig.s);
      console.log("    recovery_id:", sig.recovery_id);

      // Attach the MPC Ed25519 signature to the transaction
      attachMpcEd25519Signature(tx, ed25519PublicKeyHex, sig);
      console.log("  Signature attached to transaction envelope.");
      console.log("  XDR (signed):", tx.toXDR());
    } catch (e: any) {
      console.log("  MPC signature request failed:", e.message);
    }
  } else {
    console.log("\n  Skipping MPC signature (no NEAR private key provided).");
    console.log("  Payload (tx hash) that would be sent to MPC:");
    console.log("   ", Buffer.from(txHash).toString("hex"));
  }

  return tx.toXDR();
}
