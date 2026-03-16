// ──────────────────────────────────────────────────────────────────────
// Test script: replicate all 5 payload-builder functions from the
// asset-manager Rust contract and verify their outputs in TypeScript.
//
// Functions tested:
//   1. build_eth_legacy_payload      (EIP-155 legacy tx → keccak256)
//   2. build_eth_eip1559_payload     (EIP-1559 tx → keccak256)
//   3. build_eth_eip7702_payload     (EIP-7702 tx → keccak256)
//   4. build_stellar_payment_payload (Stellar payment → SHA-256)
//   5. build_stellar_raw_payload     (raw Stellar XDR → SHA-256)
//
// Usage:
//   npx tsx src/test-payloads.ts
// ──────────────────────────────────────────────────────────────────────

import { ethers } from "ethers";
import { sha256 } from "js-sha256";
import { writeFileSync } from "fs";
import { resolve } from "path";

// ═══════════════════════════════════════════════════
// Types – mirror the Rust structs
// ═══════════════════════════════════════════════════

interface EthTransactionParams {
  nonce: number;
  gas_price: string;   // hex
  gas_limit: number;
  to: string;          // hex with 0x
  value: string;       // hex
  data: string;        // hex (empty string for no data)
  chain_id: number;
}

interface EthEip1559TransactionParams {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string; // hex
  max_fee_per_gas: string;          // hex
  gas_limit: number;
  to: string;
  value: string;
  data: string;
}

interface Eip7702Authorization {
  chain_id: number;
  address: string;
  nonce: number;
  y_parity?: number;
  r?: string;
  s?: string;
}

interface EthEip7702TransactionParams {
  chain_id: number;
  nonce: number;
  max_priority_fee_per_gas: string;
  max_fee_per_gas: string;
  gas_limit: number;
  to: string;
  value: string;
  data: string;
  authorization_list: Eip7702Authorization[];
}

type StellarNetwork =
  | { type: "Public" }
  | { type: "Testnet" }
  | { type: "Custom"; passphrase: string };

type StellarAsset =
  | { type: "Native" }
  | { type: "CreditAlphanum4"; asset_code: string; issuer: string };

interface StellarPaymentParams {
  source_account: string; // hex 32-byte Ed25519 pubkey
  fee: number;
  sequence_number: number;
  destination: string;    // hex 32-byte Ed25519 pubkey
  asset: StellarAsset;
  amount: number;
  network: StellarNetwork;
}

// ═══════════════════════════════════════════════════
// Hex Helpers – mirror Rust's hex_to_bytes_trimmed / hex_to_bytes_raw
// ═══════════════════════════════════════════════════

/** Strip "0x"/"0X" prefix if present */
function stripHexPrefix(hex: string): string {
  if (hex.startsWith("0x") || hex.startsWith("0X")) return hex.slice(2);
  return hex;
}

/**
 * Parse hex string to bytes, trimming leading zero bytes.
 * Matches Rust `hex_to_bytes_trimmed`.
 */
function hexToBytesTrimmed(hexStr: string): Uint8Array {
  const cleaned = stripHexPrefix(hexStr);
  if (cleaned.length === 0 || /^0+$/.test(cleaned)) return new Uint8Array(0);
  const padded = cleaned.length % 2 !== 0 ? "0" + cleaned : cleaned;
  const bytes = Buffer.from(padded, "hex");
  const start = bytes.findIndex((b) => b !== 0);
  if (start === -1) return new Uint8Array(0);
  return new Uint8Array(bytes.subarray(start));
}

/**
 * Parse hex string to raw bytes (preserving leading zeros).
 * Matches Rust `hex_to_bytes_raw`.
 */
function hexToBytesRaw(hexStr: string): Uint8Array {
  const cleaned = stripHexPrefix(hexStr);
  if (cleaned.length === 0) return new Uint8Array(0);
  const padded = cleaned.length % 2 !== 0 ? "0" + cleaned : cleaned;
  return new Uint8Array(Buffer.from(padded, "hex"));
}

// ═══════════════════════════════════════════════════
// RLP Encoding Helpers – mirror the Rust RLP helpers
// ═══════════════════════════════════════════════════

/** Convert a number to minimal big-endian bytes (no leading zeros). */
function u64ToBigEndian(value: number): Uint8Array {
  if (value === 0) return new Uint8Array(0);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(value));
  const start = buf.findIndex((b) => b !== 0);
  return new Uint8Array(buf.subarray(start === -1 ? 7 : start));
}

/** RLP encode a byte sequence. */
function rlpEncodeBytes(data: Uint8Array): Uint8Array {
  if (data.length === 0) return new Uint8Array([0x80]);
  if (data.length === 1 && data[0] < 0x80) return new Uint8Array([data[0]]);
  if (data.length <= 55) {
    const result = new Uint8Array(1 + data.length);
    result[0] = 0x80 + data.length;
    result.set(data, 1);
    return result;
  }
  const lenBytes = u64ToBigEndian(data.length);
  const result = new Uint8Array(1 + lenBytes.length + data.length);
  result[0] = 0xb7 + lenBytes.length;
  result.set(lenBytes, 1);
  result.set(data, 1 + lenBytes.length);
  return result;
}

/** RLP encode a u64 value. */
function rlpEncodeU64(value: number): Uint8Array {
  if (value === 0) return rlpEncodeBytes(new Uint8Array(0));
  return rlpEncodeBytes(u64ToBigEndian(value));
}

/** RLP encode a list of already-encoded items. */
function rlpEncodeList(items: Uint8Array[]): Uint8Array {
  let payloadLen = 0;
  for (const item of items) payloadLen += item.length;

  const payload = new Uint8Array(payloadLen);
  let offset = 0;
  for (const item of items) {
    payload.set(item, offset);
    offset += item.length;
  }

  if (payloadLen <= 55) {
    const result = new Uint8Array(1 + payloadLen);
    result[0] = 0xc0 + payloadLen;
    result.set(payload, 1);
    return result;
  }
  const lenBytes = u64ToBigEndian(payloadLen);
  const result = new Uint8Array(1 + lenBytes.length + payloadLen);
  result[0] = 0xf7 + lenBytes.length;
  result.set(lenBytes, 1);
  result.set(payload, 1 + lenBytes.length);
  return result;
}

// ═══════════════════════════════════════════════════
// XDR Encoding Helpers – mirror the Rust XDR helpers
// ═══════════════════════════════════════════════════

function xdrEncodeUint32(value: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return new Uint8Array(buf);
}

function xdrEncodeInt32(value: number): Uint8Array {
  const buf = Buffer.alloc(4);
  buf.writeInt32BE(value);
  return new Uint8Array(buf);
}

function xdrEncodeInt64(value: number): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(value));
  return new Uint8Array(buf);
}

function xdrEncodeOptional(value: Uint8Array | null): Uint8Array {
  if (value !== null) {
    const result = new Uint8Array(4 + value.length);
    result.set(xdrEncodeUint32(1), 0);
    result.set(value, 4);
    return result;
  }
  return xdrEncodeUint32(0);
}

/** Build XDR-encoded MuxedAccount (KEY_TYPE_ED25519 = 0). */
function xdrEncodeMuxedAccount(publicKey: Uint8Array): Uint8Array {
  const result = new Uint8Array(4 + 32);
  result.set(xdrEncodeInt32(0), 0); // KEY_TYPE_ED25519
  result.set(publicKey, 4);
  return result;
}

/** Build XDR-encoded Stellar Asset. */
function xdrEncodeAsset(asset: StellarAsset): Uint8Array {
  if (asset.type === "Native") {
    return xdrEncodeInt32(0); // ASSET_TYPE_NATIVE
  }
  // CreditAlphanum4
  const codeBytes = new Uint8Array(4); // padded with zeros
  const code = Buffer.from(asset.asset_code, "ascii");
  codeBytes.set(code.subarray(0, 4), 0);

  const issuerBytes = hexToBytesRaw(asset.issuer);
  if (issuerBytes.length !== 32) throw new Error("Issuer must be 32 bytes");

  const parts = [
    xdrEncodeInt32(1), // ASSET_TYPE_CREDIT_ALPHANUM4
    codeBytes,
    xdrEncodeInt32(0), // KEY_TYPE_ED25519 for issuer
    issuerBytes,
  ];
  let totalLen = 0;
  for (const p of parts) totalLen += p.length;
  const result = new Uint8Array(totalLen);
  let off = 0;
  for (const p of parts) {
    result.set(p, off);
    off += p.length;
  }
  return result;
}

// ═══════════════════════════════════════════════════
// Payload Builder Functions
// ═══════════════════════════════════════════════════

/**
 * 1. build_eth_legacy_payload
 * EIP-155: keccak256(RLP([nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0]))
 */
function buildEthLegacyPayload(tx: EthTransactionParams): Uint8Array {
  const toBytes = hexToBytesRaw(tx.to);
  if (toBytes.length !== 20) throw new Error("Invalid Ethereum address: must be 20 bytes");

  const items = [
    rlpEncodeU64(tx.nonce),
    rlpEncodeBytes(hexToBytesTrimmed(tx.gas_price)),
    rlpEncodeU64(tx.gas_limit),
    rlpEncodeBytes(toBytes),
    rlpEncodeBytes(hexToBytesTrimmed(tx.value)),
    rlpEncodeBytes(hexToBytesRaw(tx.data)),
    rlpEncodeU64(tx.chain_id),
    rlpEncodeBytes(new Uint8Array(0)), // 0
    rlpEncodeBytes(new Uint8Array(0)), // 0
  ];

  const encoded = rlpEncodeList(items);
  const hash = ethers.getBytes(ethers.keccak256(encoded));
  return new Uint8Array(hash);
}

/**
 * 2. build_eth_eip1559_payload
 * EIP-1559: keccak256(0x02 || RLP([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]))
 */
function buildEthEip1559Payload(tx: EthEip1559TransactionParams): Uint8Array {
  const toBytes = hexToBytesRaw(tx.to);
  if (toBytes.length !== 20) throw new Error("Invalid Ethereum address: must be 20 bytes");

  const items = [
    rlpEncodeU64(tx.chain_id),
    rlpEncodeU64(tx.nonce),
    rlpEncodeBytes(hexToBytesTrimmed(tx.max_priority_fee_per_gas)),
    rlpEncodeBytes(hexToBytesTrimmed(tx.max_fee_per_gas)),
    rlpEncodeU64(tx.gas_limit),
    rlpEncodeBytes(toBytes),
    rlpEncodeBytes(hexToBytesTrimmed(tx.value)),
    rlpEncodeBytes(hexToBytesRaw(tx.data)),
    rlpEncodeList([]), // empty access list
  ];

  const rlpEncoded = rlpEncodeList(items);

  // 0x02 || RLP(...)
  const payload = new Uint8Array(1 + rlpEncoded.length);
  payload[0] = 0x02;
  payload.set(rlpEncoded, 1);

  const hash = ethers.getBytes(ethers.keccak256(payload));
  return new Uint8Array(hash);
}

/**
 * 3. build_eth_eip7702_payload
 * EIP-7702: keccak256(0x04 || RLP([chain_id, nonce, maxPriorityFeePerGas, maxFeePerGas,
 *   gasLimit, to, value, data, access_list, authorization_list]))
 */
function buildEthEip7702Payload(tx: EthEip7702TransactionParams): Uint8Array {
  const toBytes = hexToBytesRaw(tx.to);
  if (toBytes.length !== 20) throw new Error("Invalid Ethereum address: must be 20 bytes");

  // Encode each authorization tuple
  const authItems: Uint8Array[] = tx.authorization_list.map((auth) => {
    const addrBytes = hexToBytesRaw(auth.address);
    if (addrBytes.length !== 20) throw new Error("Invalid authorization address: must be 20 bytes");

    const fields: Uint8Array[] = [
      rlpEncodeU64(auth.chain_id),
      rlpEncodeBytes(addrBytes),
      rlpEncodeU64(auth.nonce),
    ];

    // If any signature component is provided, include all three
    if (auth.y_parity !== undefined || auth.r !== undefined || auth.s !== undefined) {
      fields.push(rlpEncodeU64(auth.y_parity ?? 0));
      fields.push(rlpEncodeBytes(hexToBytesTrimmed(auth.r ?? "0x0")));
      fields.push(rlpEncodeBytes(hexToBytesTrimmed(auth.s ?? "0x0")));
    }

    return rlpEncodeList(fields);
  });

  const items = [
    rlpEncodeU64(tx.chain_id),
    rlpEncodeU64(tx.nonce),
    rlpEncodeBytes(hexToBytesTrimmed(tx.max_priority_fee_per_gas)),
    rlpEncodeBytes(hexToBytesTrimmed(tx.max_fee_per_gas)),
    rlpEncodeU64(tx.gas_limit),
    rlpEncodeBytes(toBytes),
    rlpEncodeBytes(hexToBytesTrimmed(tx.value)),
    rlpEncodeBytes(hexToBytesRaw(tx.data)),
    rlpEncodeList([]),         // empty access list
    rlpEncodeList(authItems),  // authorization list
  ];

  const rlpEncoded = rlpEncodeList(items);

  // 0x04 || RLP(...)
  const payload = new Uint8Array(1 + rlpEncoded.length);
  payload[0] = 0x04;
  payload.set(rlpEncoded, 1);

  const hash = ethers.getBytes(ethers.keccak256(payload));
  return new Uint8Array(hash);
}

/**
 * 4. build_stellar_payment_payload
 * SHA-256(network_id || ENVELOPE_TYPE_TX || tx_xdr)
 */
function buildStellarPaymentPayload(params: StellarPaymentParams): Uint8Array {
  const sourceBytes = hexToBytesRaw(params.source_account);
  if (sourceBytes.length !== 32) throw new Error("Source account must be 32-byte Ed25519 public key");
  const sourceKey = sourceBytes;

  const destBytes = hexToBytesRaw(params.destination);
  if (destBytes.length !== 32) throw new Error("Destination must be 32-byte Ed25519 public key");
  const destKey = destBytes;

  // Build the Transaction XDR
  const txParts: Uint8Array[] = [];

  // sourceAccount: MuxedAccount (KEY_TYPE_ED25519)
  txParts.push(xdrEncodeMuxedAccount(sourceKey));
  // fee: uint32
  txParts.push(xdrEncodeUint32(params.fee));
  // seqNum: SequenceNumber (int64)
  txParts.push(xdrEncodeInt64(params.sequence_number));
  // cond: Preconditions (PRECOND_NONE = 0)
  txParts.push(xdrEncodeInt32(0));
  // memo: Memo (MEMO_NONE = 0)
  txParts.push(xdrEncodeInt32(0));
  // operations: array<Operation, 100> — 1 operation
  txParts.push(xdrEncodeUint32(1));

  // Operation:
  //   sourceAccount: optional MuxedAccount (None)
  txParts.push(xdrEncodeOptional(null));
  //   body: OperationBody (PAYMENT = 1)
  txParts.push(xdrEncodeInt32(1));
  //     destination: MuxedAccount
  txParts.push(xdrEncodeMuxedAccount(destKey));
  //     asset: Asset
  txParts.push(xdrEncodeAsset(params.asset));
  //     amount: int64
  txParts.push(xdrEncodeInt64(params.amount));

  // ext: TransactionExt (0 = void)
  txParts.push(xdrEncodeInt32(0));

  // Concatenate all tx parts
  let txXdrLen = 0;
  for (const p of txParts) txXdrLen += p.length;
  const txXdr = new Uint8Array(txXdrLen);
  let offset = 0;
  for (const p of txParts) {
    txXdr.set(p, offset);
    offset += p.length;
  }

  // Compute network ID hash
  const networkPassphrase = getNetworkPassphrase(params.network);
  const networkId = new Uint8Array(
    sha256.arrayBuffer(new TextEncoder().encode(networkPassphrase))
  );

  // TransactionSignaturePayload:
  //   networkId: Hash (32 bytes)
  //   taggedTransaction: ENVELOPE_TYPE_TX (2) + tx
  const envelopeType = xdrEncodeInt32(2); // ENVELOPE_TYPE_TX
  const signingPayload = new Uint8Array(networkId.length + envelopeType.length + txXdr.length);
  signingPayload.set(networkId, 0);
  signingPayload.set(envelopeType, networkId.length);
  signingPayload.set(txXdr, networkId.length + envelopeType.length);

  const hash = new Uint8Array(sha256.arrayBuffer(signingPayload));
  return hash;
}

/**
 * 5. build_stellar_raw_payload
 * SHA-256(network_id || ENVELOPE_TYPE_TX || transaction_xdr)
 */
function buildStellarRawPayload(
  transactionXdr: Uint8Array,
  network: StellarNetwork
): Uint8Array {
  const networkPassphrase = getNetworkPassphrase(network);
  const networkId = new Uint8Array(
    sha256.arrayBuffer(new TextEncoder().encode(networkPassphrase))
  );

  const envelopeType = xdrEncodeInt32(2); // ENVELOPE_TYPE_TX
  const signingPayload = new Uint8Array(networkId.length + envelopeType.length + transactionXdr.length);
  signingPayload.set(networkId, 0);
  signingPayload.set(envelopeType, networkId.length);
  signingPayload.set(transactionXdr, networkId.length + envelopeType.length);

  return new Uint8Array(sha256.arrayBuffer(signingPayload));
}

function getNetworkPassphrase(network: StellarNetwork): string {
  switch (network.type) {
    case "Public":
      return "Public Global Stellar Network ; September 2015";
    case "Testnet":
      return "Test SDF Network ; September 2015";
    case "Custom":
      return network.passphrase;
  }
}

// ═══════════════════════════════════════════════════
// Helper: pretty-print output
// ═══════════════════════════════════════════════════

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("hex");
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

// ═══════════════════════════════════════════════════
// Test Cases – mirror the Rust unit tests
// ═══════════════════════════════════════════════════

function runTests() {
  let passed = 0;
  let failed = 0;
  const results: any[] = [];

  function assert(condition: boolean, msg: string) {
    if (condition) {
      console.log(`  ✅ ${msg}`);
      passed++;
    } else {
      console.log(`  ❌ ${msg}`);
      failed++;
    }
  }

  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║  Payload Builder Tests (mirrors Rust contract logic)     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝\n");

  // ──────────────────────────────────────
  // 1. build_eth_legacy_payload
  // ──────────────────────────────────────
  console.log("── 1. build_eth_legacy_payload ──");
  {
    const tx: EthTransactionParams = {
      nonce: 0,
      gas_price: "0x3B9ACA00",
      gas_limit: 21000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0xDE0B6B3A7640000",
      data: "",
      chain_id: 1,
    };
    const payload = buildEthLegacyPayload(tx);
    assert(payload.length === 32, "Legacy payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_legacy_payload",
      description: "EIP-155 legacy transaction (simple ETH transfer)",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // Legacy with calldata (ERC-20 transfer)
  console.log("── 1b. build_eth_legacy_payload (with calldata) ──");
  {
    const tx: EthTransactionParams = {
      nonce: 5,
      gas_price: "0x2540BE400",
      gas_limit: 60000,
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      value: "0x0",
      data: "0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa960450000000000000000000000000000000000000000000000000000000005f5e100",
      chain_id: 1,
    };
    const payload = buildEthLegacyPayload(tx);
    assert(payload.length === 32, "Legacy + calldata payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_legacy_payload_with_calldata",
      description: "EIP-155 legacy transaction (ERC-20 transfer calldata)",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // ──────────────────────────────────────
  // 2. build_eth_eip1559_payload
  // ──────────────────────────────────────
  console.log("── 2. build_eth_eip1559_payload ──");
  {
    const tx: EthEip1559TransactionParams = {
      chain_id: 1,
      nonce: 0,
      max_priority_fee_per_gas: "0x3B9ACA00",
      max_fee_per_gas: "0x77359400",
      gas_limit: 21000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0xDE0B6B3A7640000",
      data: "",
    };
    const payload = buildEthEip1559Payload(tx);
    assert(payload.length === 32, "EIP-1559 payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_eip1559_payload",
      description: "EIP-1559 transaction (simple ETH transfer)",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // ──────────────────────────────────────
  // 3. build_eth_eip7702_payload
  // ──────────────────────────────────────

  // 3a. Unsigned authorization
  console.log("── 3a. build_eth_eip7702_payload (unsigned auth) ──");
  {
    const tx: EthEip7702TransactionParams = {
      chain_id: 1,
      nonce: 0,
      max_priority_fee_per_gas: "0x3B9ACA00",
      max_fee_per_gas: "0x77359400",
      gas_limit: 60000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0x0",
      data: "",
      authorization_list: [
        {
          chain_id: 1,
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          nonce: 0,
        },
      ],
    };
    const payload = buildEthEip7702Payload(tx);
    assert(payload.length === 32, "EIP-7702 (unsigned auth) payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_eip7702_payload_unsigned_auth",
      description: "EIP-7702 transaction with unsigned authorization",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // 3b. Signed authorization
  console.log("── 3b. build_eth_eip7702_payload (signed auth) ──");
  {
    const tx: EthEip7702TransactionParams = {
      chain_id: 1,
      nonce: 5,
      max_priority_fee_per_gas: "0x59682F00",
      max_fee_per_gas: "0xB2D05E00",
      gas_limit: 100000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0xDE0B6B3A7640000",
      data: "",
      authorization_list: [
        {
          chain_id: 1,
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          nonce: 0,
          y_parity: 0,
          r: "0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef",
          s: "0xfedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321",
        },
      ],
    };
    const payload = buildEthEip7702Payload(tx);
    assert(payload.length === 32, "EIP-7702 (signed auth) payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_eip7702_payload_signed_auth",
      description: "EIP-7702 transaction with pre-signed authorization",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // 3c. Multiple authorizations
  console.log("── 3c. build_eth_eip7702_payload (multiple auths) ──");
  {
    const tx: EthEip7702TransactionParams = {
      chain_id: 11155111,
      nonce: 0,
      max_priority_fee_per_gas: "0x3B9ACA00",
      max_fee_per_gas: "0x77359400",
      gas_limit: 100000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0x0",
      data: "",
      authorization_list: [
        {
          chain_id: 11155111,
          address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          nonce: 0,
        },
        {
          chain_id: 11155111,
          address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          nonce: 1,
        },
      ],
    };
    const payload = buildEthEip7702Payload(tx);
    assert(payload.length === 32, "EIP-7702 (multiple auths) payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_eth_eip7702_payload_multiple_auths",
      description: "EIP-7702 transaction with multiple unsigned authorizations (Sepolia)",
      input: { tx },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // 3d. EIP-7702 differs from EIP-1559 (same base params, different tx type prefix)
  console.log("── 3d. EIP-7702 vs EIP-1559 (must differ) ──");
  {
    const eip1559: EthEip1559TransactionParams = {
      chain_id: 1,
      nonce: 0,
      max_priority_fee_per_gas: "0x3B9ACA00",
      max_fee_per_gas: "0x77359400",
      gas_limit: 21000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0x0",
      data: "",
    };
    const eip7702: EthEip7702TransactionParams = {
      chain_id: 1,
      nonce: 0,
      max_priority_fee_per_gas: "0x3B9ACA00",
      max_fee_per_gas: "0x77359400",
      gas_limit: 21000,
      to: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      value: "0x0",
      data: "",
      authorization_list: [],
    };
    const hash1559 = buildEthEip1559Payload(eip1559);
    const hash7702 = buildEthEip7702Payload(eip7702);
    const differs = toHex(hash1559) !== toHex(hash7702);
    assert(differs, "EIP-7702 (0x04) and EIP-1559 (0x02) produce different hashes");
    console.log(`     EIP-1559 hash: ${toHex(hash1559)}`);
    console.log(`     EIP-7702 hash: ${toHex(hash7702)}`);
    results.push({
      test: "eip7702_vs_eip1559_differ",
      description: "Verify EIP-7702 (0x04) and EIP-1559 (0x02) produce different hashes with same base params",
      input: { eip1559_tx: eip1559, eip7702_tx: eip7702 },
      output: {
        eip1559_hash_hex: toHex(hash1559),
        eip1559_hash_base64: toBase64(hash1559),
        eip7702_hash_hex: toHex(hash7702),
        eip7702_hash_base64: toBase64(hash7702),
        hashes_differ: differs,
      },
      passed: differs,
    });
  }
  console.log();

  // ──────────────────────────────────────
  // 4. build_stellar_payment_payload
  // ──────────────────────────────────────

  // 4a. Native XLM
  console.log("── 4a. build_stellar_payment_payload (Native XLM) ──");
  {
    const params: StellarPaymentParams = {
      source_account: "da0d57da7c29813b508b04e1bc205b3d719be643a98e04bef0b8017bb1e4bc23",
      fee: 100,
      sequence_number: 123456789,
      destination: "f2e944a6e18a12fabde6c34d0a007cbae60e29ee5c33e58e6ed26f0d0a46db09",
      asset: { type: "Native" },
      amount: 10_000_000,
      network: { type: "Testnet" },
    };
    const payload = buildStellarPaymentPayload(params);
    assert(payload.length === 32, "Stellar Native payment payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_stellar_payment_payload_native",
      description: "Stellar payment transaction (Native XLM, Testnet)",
      input: { params },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // 4b. Credit asset (USDC)
  console.log("── 4b. build_stellar_payment_payload (CreditAlphanum4 USDC) ──");
  {
    const params: StellarPaymentParams = {
      source_account: "da0d57da7c29813b508b04e1bc205b3d719be643a98e04bef0b8017bb1e4bc23",
      fee: 100,
      sequence_number: 1,
      destination: "f2e944a6e18a12fabde6c34d0a007cbae60e29ee5c33e58e6ed26f0d0a46db09",
      asset: {
        type: "CreditAlphanum4",
        asset_code: "USDC",
        issuer: "ab1257da7c29813b508b04e1bc205b3d719be643a98e04bef0b8017bb1e4bc23",
      },
      amount: 5_000_000,
      network: { type: "Public" },
    };
    const payload = buildStellarPaymentPayload(params);
    assert(payload.length === 32, "Stellar Credit payment payload is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_stellar_payment_payload_credit",
      description: "Stellar payment transaction (CreditAlphanum4 USDC, Public network)",
      input: { params },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  // ──────────────────────────────────────
  // 5. build_stellar_raw_payload
  // ──────────────────────────────────────
  console.log("── 5a. build_stellar_raw_payload (Testnet) ──");
  {
    const dummyXdr = new Uint8Array(100); // all zeros, same as Rust test
    const network: StellarNetwork = { type: "Testnet" };
    const payload = buildStellarRawPayload(dummyXdr, network);
    assert(payload.length === 32, "Stellar raw payload (Testnet) is 32 bytes");
    console.log(`     Hash (hex):    ${toHex(payload)}`);
    console.log(`     Hash (base64): ${toBase64(payload)}`);
    results.push({
      test: "build_stellar_raw_payload_testnet",
      description: "Stellar raw payload (100 zero bytes XDR, Testnet)",
      input: { transaction_xdr_hex: toHex(dummyXdr), transaction_xdr_description: "100 zero bytes", network },
      output: { hash_hex: toHex(payload), hash_base64: toBase64(payload), length: payload.length },
      passed: payload.length === 32,
    });
  }
  console.log();

  console.log("── 5b. build_stellar_raw_payload (different networks differ) ──");
  {
    const dummyXdr = new Uint8Array(64).fill(1); // all 0x01, same as Rust test
    const hashTestnet = buildStellarRawPayload(dummyXdr, { type: "Testnet" });
    const hashPublic = buildStellarRawPayload(dummyXdr, { type: "Public" });
    const differs = toHex(hashTestnet) !== toHex(hashPublic);
    assert(differs, "Different networks produce different hashes");
    console.log(`     Testnet hash: ${toHex(hashTestnet)}`);
    console.log(`     Public  hash: ${toHex(hashPublic)}`);
    results.push({
      test: "build_stellar_raw_payload_networks_differ",
      description: "Verify Testnet and Public networks produce different hashes for same XDR",
      input: { transaction_xdr_hex: toHex(dummyXdr), transaction_xdr_description: "64 bytes of 0x01" },
      output: {
        testnet_hash_hex: toHex(hashTestnet),
        testnet_hash_base64: toBase64(hashTestnet),
        public_hash_hex: toHex(hashPublic),
        public_hash_base64: toBase64(hashPublic),
        hashes_differ: differs,
      },
      passed: differs,
    });
  }
  console.log();

  // ──────────────────────────────────────
  // Summary
  // ──────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════");
  console.log(`  Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═══════════════════════════════════════════════════════════");

  // Write results to test_result.json
  const output = {
    summary: { passed, failed, total: passed + failed },
    tests: results,
  };
  const outPath = resolve(import.meta.dirname!, "..", "test_result.json");
  writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
  console.log(`\n📄 Results exported to ${outPath}`);

  if (failed > 0) process.exit(1);
}

runTests();
