// ──────────────────────────────────────────────
// Bitcoin (Testnet) – build & sign test transaction
// ──────────────────────────────────────────────

import * as bitcoin from "bitcoinjs-lib";
import { sha256 } from "js-sha256";
import { requestSignature } from "./near.js";
import elliptic from "elliptic";

const { ec: EC } = elliptic;

const secp256k1 = new EC("secp256k1");

// Bitcoin testnet network params
const testnet: bitcoin.Network = {
  messagePrefix: "\x18Bitcoin Signed Message:\n",
  bech32: "tb",
  bip32: { public: 0x043587cf, private: 0x04358394 },
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
};

/**
 * Compress a secp256k1 uncompressed public key (hex with 04 prefix)
 * to 33-byte compressed form.
 */
function compressPublicKey(uncompressedHex: string): Buffer {
  const point = secp256k1.keyFromPublic(uncompressedHex, "hex").getPublic();
  return Buffer.from(point.encodeCompressed("hex"), "hex");
}

/**
 * Build a minimal Bitcoin testnet transaction.
 * Uses a dummy UTXO (since we don't have real funds).
 * This demonstrates the transaction structure and payload construction
 * that would be sent to the MPC signer.
 */
export function buildBtcTestTx(fromAddress: string, publicKeyHex: string) {
  const compressed = compressPublicKey(publicKeyHex);

  // Create a P2WPKH (native SegWit) payment
  const payment = bitcoin.payments.p2wpkh({
    pubkey: compressed,
    network: testnet,
  });

  const psbt = new bitcoin.Psbt({ network: testnet });

  // Dummy UTXO – in production you'd fetch real UTXOs from a block explorer
  const dummyTxId = "0000000000000000000000000000000000000000000000000000000000000001";
  const dummyValue = 10_000; // 10,000 sats
  const sendAmount = 5_000; // send 5,000 sats
  const fee = 1_000; // 1,000 sats fee
  const changeAmount = dummyValue - sendAmount - fee;

  psbt.addInput({
    hash: dummyTxId,
    index: 0,
    witnessUtxo: {
      script: payment.output!,
      value: BigInt(dummyValue),
    },
  });

  // Send to self (test)
  psbt.addOutput({
    address: fromAddress,
    value: BigInt(sendAmount),
  });

  // Change back to self
  if (changeAmount > 0) {
    psbt.addOutput({
      address: fromAddress,
      value: BigInt(changeAmount),
    });
  }

  // Get the sighash for input 0
  const sighashType = bitcoin.Transaction.SIGHASH_ALL;
  const tx = (psbt as any).__CACHE.__TX as bitcoin.Transaction;

  // For SegWit, compute BIP143 sighash
  const prevoutScript = payment.output!;
  const sighash = tx.hashForWitnessV0(
    0,
    prevoutScript,
    BigInt(dummyValue),
    sighashType
  );

  const payload = Array.from(sighash);

  console.log("\n── Bitcoin Test Transaction ──");
  console.log("  From:", fromAddress);
  console.log("  To:  ", fromAddress, "(self-transfer)");
  console.log("  Amount: 5,000 sats");
  console.log("  Fee: 1,000 sats");
  console.log("  Network: Testnet");
  console.log("  Sighash:", Buffer.from(sighash).toString("hex"));

  return { psbt, sighash, payload, compressed, sighashType };
}

/**
 * Request a signature from the MPC contract and finalize the Bitcoin PSBT.
 */
export async function signBtcTx(
  fromAddress: string,
  publicKeyHex: string,
  nearPrivateKey: string
): Promise<string> {
  const { psbt, payload, compressed, sighashType } = buildBtcTestTx(
    fromAddress,
    publicKeyHex
  );

  console.log("\n  Requesting signature via testnet-deployer.testnet contract...");
  const sig = await requestSignature(payload, "Bitcoin", nearPrivateKey);

  console.log("  MPC signature received:");
  console.log("    big_r:", JSON.stringify(sig.big_r));
  console.log("    s:", sig.s);
  console.log("    recovery_id:", sig.recovery_id);

  // Convert MPC signature to DER format for Bitcoin
  const rHex = sig.big_r.affine_point.slice(2); // Remove prefix byte
  const sHex = sig.s.scalar;

  const rBN = BigInt("0x" + rHex);
  const sBN = BigInt("0x" + sHex);

  // Encode r and s as DER
  const rBytes = Buffer.from(rHex, "hex");
  const sBytes = Buffer.from(sHex, "hex");

  // Build the witness signature (DER-encoded + sighash type)
  // The PSBT expects the partial signature to include the sighash byte
  const derSig = encodeDER(rBytes, sBytes);
  const fullSig = Buffer.concat([derSig, Buffer.from([sighashType])]);

  // Manually set the witness
  psbt.updateInput(0, {
    partialSig: [
      {
        pubkey: compressed,
        signature: fullSig,
      },
    ],
  });

  psbt.finalizeAllInputs();
  const rawTx = psbt.extractTransaction().toHex();
  console.log("  Signed raw transaction:", rawTx);
  return rawTx;
}

/** Encode two integer buffers as DER signature */
function encodeDER(r: Buffer, s: Buffer): Buffer {
  function integerEncode(value: Buffer): Buffer {
    // Ensure positive (prepend 0x00 if high bit set)
    let v = value;
    if (v[0]! & 0x80) {
      v = Buffer.concat([Buffer.from([0x00]), v]);
    }
    // Remove leading zeros (but keep at least one byte)
    while (v.length > 1 && v[0] === 0x00 && !(v[1]! & 0x80)) {
      v = v.slice(1);
    }
    return Buffer.concat([Buffer.from([0x02, v.length]), v]);
  }

  const rEnc = integerEncode(r);
  const sEnc = integerEncode(s);
  const totalLen = rEnc.length + sEnc.length;
  return Buffer.concat([Buffer.from([0x30, totalLen]), rEnc, sEnc]);
}
