// src/near-mainnet.ts
// NEAR mainnet helpers — account connection, batch signing, polling, MPC Ed25519 signing

import { connect, keyStores, KeyPair, transactions, utils } from "near-api-js";
import type { ConnectConfig } from "near-api-js";
import type { Transaction } from "@stellar/stellar-sdk";
import {
  MAINNET_CONTRACT_ID,
  MAINNET_MPC_CONTRACT_ID,
  MAINNET_RPC_URL,
  SIGN_GAS,
  SIGN_DEPOSIT,
  POLICY_GAS,
  MAINNET_DERIVATION_PATHS,
} from "./config.js";
import { publicKeyToEvmAddress, ed25519PublicKeyToStellarAddress, parseMpcPublicKey } from "../core/derive.js";
import { attachMpcEd25519Signature, type MpcEd25519Signature } from "../core/stellar.js";

// ── Base58 decode (no checksum) ──

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

function parseLocalMpcPublicKey(raw: string): string {
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  if (keyBytes.length === 64 && raw.startsWith("secp256k1:")) {
    return "04" + Buffer.from(keyBytes).toString("hex");
  }
  return Buffer.from(keyBytes).toString("hex");
}

// ── Account Connection ──

export async function getMainnetAccount(privateKey?: string) {
  const keyStore = new keyStores.InMemoryKeyStore();
  if (privateKey) {
    const keyPair = KeyPair.fromString(privateKey);
    await keyStore.setKey("mainnet", MAINNET_CONTRACT_ID, keyPair);
  }
  const near = await connect({
    networkId: "mainnet",
    nodeUrl: MAINNET_RPC_URL,
    keyStore,
  } as ConnectConfig);
  return near.account(MAINNET_CONTRACT_ID);
}

// ── Address Derivation ──

export interface MainnetDerivedAddresses {
  evm: { address: string; publicKeyHex: string };
  stellar: { address: string; ed25519PublicKeyHex: string };
}

export async function deriveMainnetAddresses(): Promise<MainnetDerivedAddresses> {
  const account = await getMainnetAccount();

  // EVM: key_version 0 (secp256k1)
  const evmDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path: MAINNET_DERIVATION_PATHS.ethereum, predecessor: MAINNET_CONTRACT_ID },
  });
  const evmChildHex = parseLocalMpcPublicKey(evmDerivedRaw);

  // Stellar: key_version 1 (Ed25519) — MPC natively derives Ed25519 public key
  const stellarDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: {
      path: MAINNET_DERIVATION_PATHS.stellar,
      predecessor: MAINNET_CONTRACT_ID,
      key_version: 1,
    },
  });
  const stellarEd25519Hex = parseMpcPublicKey(stellarDerivedRaw);

  const evmAddress = publicKeyToEvmAddress(evmChildHex);
  const stellar = ed25519PublicKeyToStellarAddress(stellarEd25519Hex);

  return {
    evm: { address: evmAddress, publicKeyHex: evmChildHex },
    stellar: {
      address: stellar.address,
      ed25519PublicKeyHex: stellar.ed25519PublicKeyHex,
    },
  };
}

// ── MPC Ed25519 Signing (Mainnet) ──

/**
 * Request an Ed25519 signature from the MPC signer on mainnet.
 *
 * Calls v1.signer directly with key_version: 1 for Ed25519.
 * The payload must be a 32-byte hash (e.g., Stellar transaction hash).
 *
 * Returns the MPC signature in { big_r, s, recovery_id } format.
 */
export async function requestMainnetMpcSignature(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  payload: number[],
  derivationIndex: number = 0,
): Promise<MpcSignature> {
  const path = MAINNET_DERIVATION_PATHS.stellar;

  const result = await account.functionCall({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "sign",
    args: {
      request: {
        payload,
        path: `${path}`,
        key_version: 1, // Ed25519
      },
    },
    gas: SIGN_GAS,
    attachedDeposit: SIGN_DEPOSIT,
  });

  const successValue = (result.status as any).SuccessValue;
  if (!successValue) {
    throw new Error("MPC signature request failed: " + JSON.stringify(result.status));
  }
  return JSON.parse(Buffer.from(successValue, "base64").toString());
}

/**
 * Sign a Stellar transaction via MPC Ed25519 on mainnet.
 *
 * Hashes the transaction, requests an Ed25519 signature from the MPC signer,
 * and attaches the signature to the transaction envelope.
 *
 * This replaces the insecure local keypair signing pattern.
 */
export async function signStellarTransactionViaMpc(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  tx: Transaction,
  ed25519PublicKeyHex: string,
  derivationIndex: number = 0,
): Promise<void> {
  const txHash = tx.hash();
  const payload = Array.from(txHash);

  const sig = await requestMainnetMpcSignature(account, payload, derivationIndex);
  attachMpcEd25519Signature(tx, ed25519PublicKeyHex, sig as MpcEd25519Signature);
}

// ── Policy Helpers ──

export async function setPolicy(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  registration: {
    chain: string;
    contract: string;
    selector: number[];
    mask: number[];
    condition: number[];
    value_limit: string | null;
    expires_at: number | null;
  },
): Promise<void> {
  const result = await account.functionCall({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "set_policy",
    args: { registration },
    gas: POLICY_GAS,
    attachedDeposit: BigInt("0"),
  });
  if ((result.status as any).Failure) {
    throw new Error(JSON.stringify((result.status as any).Failure));
  }
}

export async function getPolicy(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  chain: string,
  targetContract: string,
  selector: number[],
): Promise<{ mask: number[]; condition: number[]; value_limit: string | null; expires_at: number | null } | null> {
  return account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_policy",
    args: { chain, target_contract: targetContract, selector },
  });
}

// ── Batch Signing ──

export interface BatchStatus {
  batch_id: number;
  total: number;
  completed: number;
  failed: number;
  pending: number;
  next_index: number;
}

export interface MpcSignature {
  big_r: { affine_point: string };
  s: { scalar: string };
  recovery_id: number;
}

/**
 * Submit a batch of payloads via request_batch_signature().
 * Uses sendTransactionAsync to avoid RPC timeout on long MPC signing.
 * Returns { nearTxId, expectedBatchId } where expectedBatchId is determined
 * by querying get_total_batches before submission.
 */
export async function submitBatch(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  payloads: any[],
  derivationIndex: number = 0,
): Promise<{ nearTxId: string; expectedBatchId: number }> {
  // Probe for next_batch_id by scanning get_batch_status until we find a gap
  let expectedBatchId = 1;
  for (let probe = 1; probe < 10000; probe++) {
    const status = await account.viewFunction({
      contractId: MAINNET_CONTRACT_ID,
      methodName: "get_batch_status",
      args: { batch_id: probe },
    });
    if (status === null || status === undefined) {
      expectedBatchId = probe;
      break;
    }
    expectedBatchId = probe + 1;
  }

  const totalDeposit = BigInt(payloads.length) * SIGN_DEPOSIT;

  // Custom JSON serialization to handle BigInt i64 fields (sequence_number, limit)
  // that exceed Number.MAX_SAFE_INTEGER. JSON.stringify would lose precision or
  // produce strings; the contract expects bare i64 numbers in JSON.
  const argsJson = JSON.stringify(
    { payloads, derivation_index: derivationIndex, use_balance: false },
    (_key, value) => (typeof value === "bigint" ? `__BIGINT__${value}__` : value),
  ).replace(/"__BIGINT__(-?\d+)__"/g, "$1");
  const argsBytes = Buffer.from(argsJson);

  const action = transactions.functionCall(
    "request_batch_signature",
    argsBytes,
    SIGN_GAS,
    totalDeposit,
  );

  const [txHashBytes, nearSignedTx] = await account.signTransaction(MAINNET_CONTRACT_ID, [action]);
  const nearProvider = (account as any).connection.provider as any;
  await nearProvider.sendTransactionAsync(nearSignedTx);
  const nearTxId = utils.serialize.base_encode(txHashBytes);
  return { nearTxId, expectedBatchId };
}

/**
 * Crank the next pending item in a batch via sign_batch_next().
 * Uses synchronous functionCall so NEAR nonce is properly sequenced.
 * The MPC signing happens asynchronously via callback — this returns
 * once the crank tx is confirmed, not when MPC signing completes.
 */
export async function crankBatchNext(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  batchId: number,
): Promise<void> {
  await account.functionCall({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "sign_batch_next",
    args: { batch_id: batchId },
    gas: SIGN_GAS,
    attachedDeposit: BigInt("0"),
  });
}

/**
 * Poll get_batch_status() until all items are completed or failed.
 */
export async function pollBatchStatus(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  batchId: number,
  maxAttempts = 120,
  intervalMs = 5000,
): Promise<BatchStatus> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const status: BatchStatus | null = await account.viewFunction({
      contractId: MAINNET_CONTRACT_ID,
      methodName: "get_batch_status",
      args: { batch_id: batchId },
    });

    if (!status) {
      console.log(`  [${attempt}/${maxAttempts}] Batch ${batchId}: not found yet...`);
      await new Promise((r) => setTimeout(r, intervalMs));
      continue;
    }

    console.log(
      `  [${attempt}/${maxAttempts}] Batch ${batchId}: ${status.completed}/${status.total} signed, ${status.failed} failed, ${status.pending} pending`,
    );

    if (status.pending === 0) return status;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for batch ${batchId}`);
}

/**
 * Retrieve all signatures from a completed batch.
 */
export async function getBatchSignatures(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  batchId: number,
): Promise<MpcSignature[]> {
  const batch: any = await account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_batch_request",
    args: { batch_id: batchId },
  });
  return batch.items.map((item: any) => {
    if (!item.signature) throw new Error(`Batch item missing signature: ${JSON.stringify(item)}`);
    return item.signature;
  });
}

/**
 * Refund unused deposit from a batch (owner only).
 */
export async function refundBatch(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  batchId: number,
): Promise<void> {
  await account.functionCall({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "refund_batch",
    args: { batch_id: batchId },
    gas: POLICY_GAS,
    attachedDeposit: BigInt("0"),
  });
}

// ── Hex Helpers (re-exported for scripts) ──

export function hexToBytes(hex: string): number[] {
  const cleaned = hex.replace(/^0x/i, "");
  if (cleaned.length % 2 !== 0) throw new Error(`Odd-length hex string: "${hex}"`);
  const out: number[] = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function normalizeAddress(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}
