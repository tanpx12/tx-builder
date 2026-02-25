// ──────────────────────────────────────────────
// Ethereum (Sepolia) – build & sign test transaction
// ──────────────────────────────────────────────

import { ethers } from "ethers";
import { sha256 } from "js-sha256";
import { ETH_RPC, ETH_CHAIN_ID } from "./config.js";
import { requestSignature } from "./near.js";

/**
 * Build a minimal Ethereum test transaction (0 ETH transfer to self).
 * Returns the serialized unsigned transaction and the 32-byte hash to sign.
 */
export function buildEthTestTx(fromAddress: string) {
  const tx: ethers.TransactionLike = {
    to: fromAddress, // send to self
    value: 0n,
    nonce: 0, // will be overridden if we fetch from chain
    gasLimit: 21_000n,
    maxFeePerGas: ethers.parseUnits("2", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
    chainId: ETH_CHAIN_ID,
    type: 2, // EIP-1559
  };

  const unsignedTx = ethers.Transaction.from(tx);
  const unsignedSerialized = unsignedTx.unsignedSerialized;
  const txHash = ethers.keccak256(unsignedSerialized);

  // Convert the 32-byte hash to a number[] for the MPC contract
  const hashBytes = ethers.getBytes(txHash);
  const payload = Array.from(hashBytes);

  console.log("\n── Ethereum Test Transaction ──");
  console.log("  From:", fromAddress);
  console.log("  To:  ", fromAddress, "(self-transfer)");
  console.log("  Value: 0 ETH");
  console.log("  Chain: Sepolia (chainId:", ETH_CHAIN_ID, ")");
  console.log("  Unsigned serialized:", unsignedSerialized);
  console.log("  Hash to sign:", txHash);

  return { tx, unsignedTx, unsignedSerialized, txHash, payload };
}

/**
 * Request a signature from the MPC contract and reconstruct
 * the signed Ethereum transaction.
 */
export async function signEthTx(
  fromAddress: string,
  nearPrivateKey: string
): Promise<string> {
  const { unsignedTx, payload, txHash } = buildEthTestTx(fromAddress);

  console.log("\n  Requesting signature via testnet-deployer.testnet contract...");
  const sig = await requestSignature(payload, "Ethereum", nearPrivateKey);

  console.log("  MPC signature received:");
  console.log("    big_r:", JSON.stringify(sig.big_r));
  console.log("    s:", sig.s);
  console.log("    recovery_id:", sig.recovery_id);

  // Reconstruct r, s, v from the MPC response
  const r = "0x" + sig.big_r.affine_point.slice(2); // remove "03" or "02" prefix
  const s = "0x" + sig.s.scalar;
  const v = sig.recovery_id;

  const signedTx = unsignedTx.clone();
  signedTx.signature = ethers.Signature.from({ r, s, v });

  const signedSerialized = signedTx.serialized;
  console.log("  Signed transaction:", signedSerialized);
  return signedSerialized;
}
