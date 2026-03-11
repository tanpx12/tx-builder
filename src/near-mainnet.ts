// src/near-mainnet.ts
// NEAR mainnet helpers — account connection, batch signing, polling

import { connect, keyStores, KeyPair, transactions, utils } from "near-api-js";
import type { ConnectConfig } from "near-api-js";
import {
  MAINNET_CONTRACT_ID,
  MAINNET_MPC_CONTRACT_ID,
  MAINNET_RPC_URL,
  SIGN_GAS,
  SIGN_DEPOSIT,
  POLICY_GAS,
  MAINNET_DERIVATION_PATHS,
} from "./config-mainnet.js";
import { publicKeyToEvmAddress, publicKeyToStellarAddress } from "./derive.js";

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

function parseMpcPublicKey(raw: string): string {
  const parts = raw.split(":");
  const keyPart = parts[parts.length - 1];
  if (!keyPart) throw new Error("Invalid MPC public key format");
  const keyBytes = bs58Decode(keyPart);
  if (keyBytes.length === 64) {
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
  stellar: { address: string; ed25519PublicKeyHex: string; secp256k1PublicKeyHex: string };
}

export async function deriveMainnetAddresses(): Promise<MainnetDerivedAddresses> {
  const account = await getMainnetAccount();

  const evmDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path: MAINNET_DERIVATION_PATHS.ethereum, predecessor: MAINNET_CONTRACT_ID },
  });
  const evmChildHex = parseMpcPublicKey(evmDerivedRaw);

  const stellarDerivedRaw: string = await account.viewFunction({
    contractId: MAINNET_MPC_CONTRACT_ID,
    methodName: "derived_public_key",
    args: { path: MAINNET_DERIVATION_PATHS.stellar, predecessor: MAINNET_CONTRACT_ID },
  });
  const stellarChildHex = parseMpcPublicKey(stellarDerivedRaw);

  const evmAddress = publicKeyToEvmAddress(evmChildHex);
  const stellar = publicKeyToStellarAddress(stellarChildHex);

  return {
    evm: { address: evmAddress, publicKeyHex: evmChildHex },
    stellar: {
      address: stellar.address,
      ed25519PublicKeyHex: stellar.ed25519PublicKeyHex,
      secp256k1PublicKeyHex: stellarChildHex,
    },
  };
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
  // Snapshot the batch count before submission to derive the batch_id
  const totalBefore: number = await account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_total_batches",
    args: {},
  });
  const expectedBatchId = totalBefore + 1;

  const totalDeposit = BigInt(payloads.length) * SIGN_DEPOSIT;

  const action = transactions.functionCall(
    "request_batch_signature",
    { payloads, derivation_index: derivationIndex, use_balance: false },
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
 */
export async function crankBatchNext(
  account: Awaited<ReturnType<typeof getMainnetAccount>>,
  batchId: number,
): Promise<void> {
  const action = transactions.functionCall(
    "sign_batch_next",
    { batch_id: batchId },
    SIGN_GAS,
    BigInt("0"),
  );
  const [, nearSignedTx] = await account.signTransaction(MAINNET_CONTRACT_ID, [action]);
  const nearProvider = (account as any).connection.provider as any;
  await nearProvider.sendTransactionAsync(nearSignedTx);
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
    const status: BatchStatus = await account.viewFunction({
      contractId: MAINNET_CONTRACT_ID,
      methodName: "get_batch_status",
      args: { batch_id: batchId },
    });

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
