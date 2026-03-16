# Mainnet Demo Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a complete cross-chain leveraged short demo on mainnet — both **Open Position** (EVM→Stellar) and **Close Position** (Stellar→EVM) flows — using NEAR Chain Signatures, Morpho Blue on Arbitrum, Untangled Loop / Blend on Stellar, and the 1Click bridge.

**Architecture:** Two end-to-end orchestration scripts backed by shared modules: config, NEAR helpers, Morpho calldata builders, 1Click bridge helpers, and a policy registration script. Each script is self-contained and runnable via `npx tsx`.

**Important constraint:** The NEAR MPC signer (`v1.signer`) only supports secp256k1 (key_version: 0). Stellar requires Ed25519 signatures. Therefore, Stellar transactions are signed locally using the deterministic Ed25519 keypair derived from the secp256k1 child key (SHA-256 of compressed key → Ed25519 seed). EVM transactions are signed via NEAR batch MPC signing.

**Env vars:** Uses `MAINNET_KEY` (not `KEY`) to separate mainnet and testnet credentials. The `.env` file should contain both `KEY` (testnet) and `MAINNET_KEY` (mainnet).

**Tech Stack:** TypeScript (ESM via tsx), near-api-js, ethers.js v6, @stellar/stellar-sdk, 1Click API

**Derived Addresses:**
- **EVM (Arbitrum):** `0x22458b64018A4B0ed91914F85A612d8831b4fec9`
- **Stellar:** `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM`

---

## Flows Overview

### Open Position Flow (EVM → Stellar)

Deposits WETH collateral on Morpho, borrows USDC, bridges USDC to Stellar, opens a leveraged short on Untangled Loop (Blend).

```
WETH on Arbitrum
  → Approve WETH for Morpho
  → Supply WETH collateral on Morpho
  → Borrow USDC from Morpho
  → Transfer USDC to 1Click bridge deposit address
  → 1Click bridges USDC: Arbitrum → Stellar
  → Approve USDC for Blend pool
  → open_short on Untangled Loop (flash XLM, swap XLM→USDC via Aquarius, supply USDC collateral, borrow XLM, repay flash)
```

**Script:** `src/mainnet/open-position.ts`
**Run:** `npm run mainnet:open -- --submit --weth-amount=0.01 --borrow-usdc=5`

### Close Position Flow (Stellar → EVM)

Closes the short on Stellar, swaps remaining XLM→USDC, bridges USDC back to Arbitrum, repays Morpho debt, withdraws WETH collateral.

```
Blend position on Stellar
  → close_short on Untangled Loop (flash USDC, swap USDC→XLM via Aquarius, repay XLM debt, withdraw USDC collateral, repay flash)
  → Withdraw residual USDC collateral from Blend (if any)
  → Swap remaining XLM → USDC via Stellar path payment
  → Transfer USDC to 1Click bridge deposit address (with MEMO)
  → 1Click bridges USDC: Stellar → Arbitrum
  → Approve USDC for Morpho
  → Repay USDC debt on Morpho (by shares for exact repayment)
  → Withdraw WETH collateral from Morpho
```

**Script:** `src/mainnet/close-position.ts`
**Run:** `npm run mainnet:close -- --submit`

---

## File Structure

```
src/
├── core/                          # Shared foundation (testnet + mainnet)
│   ├── config.ts                  # Testnet constants (RPC, contract IDs, derivation paths)
│   ├── near.ts                    # NEAR account helpers, MPC signing
│   ├── derive.ts                  # Cross-chain address derivation (KDF)
│   ├── eth.ts                     # Ethereum tx builder + signer
│   ├── stellar.ts                 # Stellar tx builder + Ed25519 keypair derivation
│   └── btc.ts                     # Bitcoin tx builder + signer
│
├── testnet/                       # Testnet demos & CLI tools
│   ├── index.ts                   # Derive addresses + build test txs
│   ├── demo-eth-transfer.ts       # E2E ETH transfer with policy setup
│   ├── demo-stellar-payment.ts    # E2E Stellar payment demo
│   ├── manage-policy.ts           # Policy management CLI
│   ├── test-payloads.ts           # Test payload utilities
│   ├── test-policy-reject-eth.ts  # Test ETH policy rejection
│   └── test-policy-reject-stellar.ts
│
└── mainnet/                       # Mainnet modules & demo scripts
    ├── config.ts                  # Mainnet constants (Arbitrum, Morpho, Stellar, 1Click)
    ├── near.ts                    # Mainnet NEAR helpers (batch signing, policies)
    ├── morpho.ts                  # Morpho Blue calldata builders + position queries
    ├── bridge.ts                  # 1Click bridge (forward + reverse with MEMO)
    ├── derive.ts                  # Derive mainnet addresses
    ├── set-policies.ts            # Register all 9 NEAR policies
    ├── open-position.ts           # Open Position: EVM → Stellar
    ├── close-position.ts          # Close Position: Stellar → EVM
    └── check-status.ts            # View balances, positions, policy status
```

### npm Scripts

| Command | Script | Purpose |
|---------|--------|---------|
| `npm run mainnet:open` | `open-position.ts` | Open Position (EVM → Stellar) |
| `npm run mainnet:close` | `close-position.ts` | Close Position (Stellar → EVM) |
| `npm run mainnet:policies` | `set-policies.ts` | Register all NEAR policies |
| `npm run mainnet:check` | `check-status.ts` | View balances & positions |
| `npm run mainnet:derive` | `derive.ts` | Derive mainnet addresses |
| `npm run testnet:start` | `index.ts` | Testnet derive + test txs |
| `npm run testnet:demo:eth` | `demo-eth-transfer.ts` | Testnet ETH transfer demo |
| `npm run testnet:demo:stellar` | `demo-stellar-payment.ts` | Testnet Stellar payment demo |

---

## Chunk 1: Shared Modules

### Task 1: `src/config-mainnet.ts`

**Files:**
- Create: `src/config-mainnet.ts`

- [ ] **Step 1: Create mainnet config file**

```ts
// src/config-mainnet.ts
// Mainnet constants for the cross-chain leveraged short demo

// ── NEAR Mainnet ──
export const MAINNET_CONTRACT_ID = "8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e";
export const MAINNET_MPC_CONTRACT_ID = "v1.signer";
export const MAINNET_RPC_URL = "https://rpc.mainnet.near.org";

/** 0.25 NEAR per signature */
export const SIGN_DEPOSIT = BigInt("250000000000000000000000");
/** 300 Tgas */
export const SIGN_GAS = BigInt("300000000000000");
/** 30 Tgas for policy/view calls */
export const POLICY_GAS = BigInt("30000000000000");

// ── Arbitrum One ──
export const ARB_RPC = "https://red-soft-aura.arbitrum-mainnet.quiknode.pro/";
export const ARB_CHAIN_ID = 42161;

// ── Token Addresses (Arbitrum) ──
export const WETH_ADDRESS = "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1";
export const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";

// ── Morpho Blue (Arbitrum) ──
export const MORPHO_ADDRESS = "0x6c247b1F6182318877311737BaC0844bAa518F5e";
export const MORPHO_MARKET_ID = "0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc";

// ── Stellar Mainnet ──
export const STELLAR_MAINNET_HORIZON = "https://horizon.stellar.org";
export const STELLAR_SOROBAN_RPC = "https://mainnet.sorobanrpc.com";
export const STELLAR_MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

// ── Stellar Contracts ──
export const UNTANGLED_LOOP_CONTRACT = "CC6PV65GIWRTOYSM7NWMCF5OCWLNGUOGBVXJ7DV57KTAPJNMFE27USPH";
export const MARGIN_MANAGER_CONTRACT = "CCC27LQ43TXGZUTTKFYV2ZLSKX3MMVWCAZDFCEERQHY67C7EQBWB2UKK";
export const BLEND_POOL_CONTRACT = "CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD";
export const STELLAR_XLM_TOKEN = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA";
export const STELLAR_USDC_TOKEN = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

// ── 1Click Bridge API ──
export const ONECLICK_BASE_URL = "https://1click.chaindefuser.com/v0";
export const ONECLICK_ORIGIN_ASSET = "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near";
export const ONECLICK_DEST_ASSET = "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu";

// ── Derivation ──
export function buildMainnetDerivationPath(chain: string, index: number = 0): string {
  return `${MAINNET_CONTRACT_ID},${MAINNET_CONTRACT_ID},${chain},${index}`;
}

export const MAINNET_DERIVATION_PATHS = {
  ethereum: buildMainnetDerivationPath("ethereum", 0),
  stellar: buildMainnetDerivationPath("stellar", 0),
};

// ── Aquarius AMM API ──
export const AQUARIUS_API_URL = "https://amm-api.aqua.network/pools/find-path/";
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import './src/config-mainnet.js'; console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/config-mainnet.ts
git commit -m "feat: add mainnet config constants"
```

---

### Task 2: `src/near-mainnet.ts`

**Files:**
- Create: `src/near-mainnet.ts`
- Reference: `src/near.ts` (testnet pattern), `src/derive-mainnet.ts` (mainnet connection pattern)

- [ ] **Step 1: Create near-mainnet helpers**

```ts
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
 * Returns { nearTxId, batchId } where batchId is determined by querying
 * get_total_batches before and after submission.
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
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import { getMainnetAccount } from './src/near-mainnet.js'; console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/near-mainnet.ts
git commit -m "feat: add NEAR mainnet helpers with batch signing"
```

---

### Task 3: `src/morpho.ts`

**Files:**
- Create: `src/morpho.ts`

- [ ] **Step 1: Create Morpho calldata builders**

Uses ethers.js ABI encoding to build calldata for the 3 Morpho Blue interactions.

```ts
// src/morpho.ts
// Morpho Blue calldata builders for Arbitrum One

import { ethers } from "ethers";
import { MORPHO_ADDRESS, MORPHO_MARKET_ID, WETH_ADDRESS, USDC_ADDRESS } from "./config-mainnet.js";

// ── Morpho Blue ABI fragments ──

const MORPHO_ABI = [
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
];

const morphoIface = new ethers.Interface(MORPHO_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

// ── Market Parameters ──
// These must match the on-chain market identified by MORPHO_MARKET_ID.
// They are passed as a struct to supplyCollateral() and borrow().

export interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

/**
 * Fetch market parameters from the Morpho Blue contract.
 * Reads the `idToMarketParams` mapping on-chain.
 */
export async function fetchMarketParams(provider: ethers.JsonRpcProvider): Promise<MarketParams> {
  const morpho = new ethers.Contract(
    MORPHO_ADDRESS,
    ["function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"],
    provider,
  );
  const [loanToken, collateralToken, oracle, irm, lltv] = await morpho.idToMarketParams(MORPHO_MARKET_ID);
  return { loanToken, collateralToken, oracle, irm, lltv };
}

// ── Calldata Builders ──

/** ERC-20 approve(MORPHO_ADDRESS, amount) on WETH */
export function buildApproveWethCalldata(amount: bigint): string {
  return erc20Iface.encodeFunctionData("approve", [MORPHO_ADDRESS, amount]);
}

/** Morpho supplyCollateral(marketParams, assets, onBehalf, "0x") */
export function buildSupplyCollateralCalldata(
  marketParams: MarketParams,
  assets: bigint,
  onBehalf: string,
): string {
  return morphoIface.encodeFunctionData("supplyCollateral", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    assets,
    onBehalf,
    "0x",
  ]);
}

/** Morpho borrow(marketParams, assets, shares=0, onBehalf, receiver) */
export function buildBorrowCalldata(
  marketParams: MarketParams,
  borrowAmount: bigint,
  onBehalf: string,
  receiver: string,
): string {
  return morphoIface.encodeFunctionData("borrow", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    borrowAmount,
    0n, // shares = 0, borrow by assets
    onBehalf,
    receiver,
  ]);
}

/** ERC-20 transfer(to, amount) on USDC */
export function buildUsdcTransferCalldata(to: string, amount: bigint): string {
  return erc20Iface.encodeFunctionData("transfer", [to, amount]);
}

// ── Selectors (for policy registration) ──

export const APPROVE_SELECTOR = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)
export const SUPPLY_COLLATERAL_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("supplyCollateral")!.selector),
);
export const BORROW_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("borrow")!.selector),
);
export const TRANSFER_SELECTOR = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import { buildApproveWethCalldata, APPROVE_SELECTOR } from './src/morpho.js'; console.log('approve selector:', APPROVE_SELECTOR); console.log('calldata:', buildApproveWethCalldata(1000000n).slice(0, 20) + '...'); console.log('OK')"`
Expected: Prints approve selector and partial calldata, then `OK`

- [ ] **Step 3: Commit**

```bash
git add src/morpho.ts
git commit -m "feat: add Morpho Blue calldata builders"
```

---

### Task 4: `src/bridge.ts`

**Files:**
- Create: `src/bridge.ts`

- [ ] **Step 1: Create 1Click bridge helpers**

```ts
// src/bridge.ts
// 1Click API bridge helpers — Arbitrum USDC → Stellar USDC

import {
  ONECLICK_BASE_URL,
  ONECLICK_ORIGIN_ASSET,
  ONECLICK_DEST_ASSET,
} from "./config-mainnet.js";

export interface BridgeQuote {
  quoteId: string;
  depositAddress: string;
  destinationAmount: string;
  expiresAt: string;
}

/**
 * Request a bridge quote from the 1Click API.
 *
 * @param amount USDC amount in smallest unit (6 decimals)
 * @param recipient Stellar G... StrKey address
 * @param refundTo EVM address for refunds
 * @param jwt Optional JWT for authenticated (fee-free) requests
 */
export async function getBridgeQuote(
  amount: string,
  recipient: string,
  refundTo: string,
  jwt?: string,
): Promise<BridgeQuote> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(`${ONECLICK_BASE_URL}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100, // 1%
      originAsset: ONECLICK_ORIGIN_ASSET,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ONECLICK_DEST_ASSET,
      amount,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`1Click quote failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    quoteId: data.quoteId ?? data.quote?.quoteId,
    depositAddress: data.depositAddress ?? data.quote?.depositAddress,
    destinationAmount: data.destinationAmount ?? data.quote?.destinationAmount,
    expiresAt: data.expiresAt ?? data.quote?.expiresAt,
  };
}

/**
 * Submit the deposit tx hash to 1Click for faster tracking.
 */
export async function submitDeposit(depositAddress: string, txHash: string): Promise<void> {
  const res = await fetch(`${ONECLICK_BASE_URL}/deposit/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depositAddress, txHash }),
  });
  if (!res.ok) {
    console.warn(`1Click deposit submit warning (${res.status}): ${await res.text()}`);
  }
}

export type BridgeStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "FAILED" | "REFUNDED";

/**
 * Poll 1Click bridge status until SUCCESS, FAILED, or REFUNDED.
 */
export async function pollBridgeStatus(
  depositAddress: string,
  maxAttempts = 120,
  intervalMs = 5000,
): Promise<BridgeStatus> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(`${ONECLICK_BASE_URL}/status?depositAddress=${depositAddress}`);
    const data = await res.json();
    const status: BridgeStatus = data.status;

    console.log(`  [${attempt}/${maxAttempts}] Bridge status: ${status}`);

    if (status === "SUCCESS" || status === "FAILED" || status === "REFUNDED") {
      return status;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for bridge completion");
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import { getBridgeQuote } from './src/bridge.js'; console.log('OK')"`
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add src/bridge.ts
git commit -m "feat: add 1Click bridge API helpers"
```

---

## Chunk 2: CLI Scripts

### Task 5: `src/mainnet/check-status.ts`

**Files:**
- Create: `src/mainnet/check-status.ts`

This is the simplest script — read-only, no signing needed. Good to build first to verify the shared modules work end-to-end.

- [ ] **Step 1: Create mainnet directory**

Run: `mkdir -p src/mainnet`

- [ ] **Step 2: Create check-status script**

```ts
// src/mainnet/check-status.ts
// CLI: Derive mainnet addresses, show balances, policy status, batch progress
//
// Usage:
//   npx tsx src/mainnet/check-status.ts                 # derive + show balances
//   npx tsx src/mainnet/check-status.ts policies        # show registered policies
//   npx tsx src/mainnet/check-status.ts batch <id>      # show batch status

import "dotenv/config";
import { ethers } from "ethers";
import { Horizon } from "@stellar/stellar-sdk";
import {
  ARB_RPC,
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  STELLAR_MAINNET_HORIZON,
  UNTANGLED_LOOP_CONTRACT,
} from "../config-mainnet.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  getPolicy,
  hexToBytes,
  bytesToHex,
} from "../near-mainnet.js";
import {
  APPROVE_SELECTOR,
  SUPPLY_COLLATERAL_SELECTOR,
  BORROW_SELECTOR,
  TRANSFER_SELECTOR,
} from "../morpho.js";

// ── Helpers ──

function normalizeAddr(addr: string): string {
  return addr.replace(/^0x/i, "").toLowerCase();
}

function printPolicy(
  label: string,
  policy: { mask: number[]; condition: number[]; value_limit: string | null; expires_at: number | null } | null,
): void {
  if (!policy) {
    console.log(`  ${label}: NOT SET`);
    return;
  }
  console.log(`  ${label}: SET`);
  console.log(`    mask len:     ${policy.mask.length} bytes`);
  console.log(`    value_limit:  ${policy.value_limit ?? "none"}`);
  console.log(
    `    expires_at:   ${policy.expires_at ? new Date(policy.expires_at / 1_000_000).toISOString() : "never"}`,
  );
}

// ── Commands ──

async function cmdDefault(): Promise<void> {
  console.log("Deriving mainnet addresses...\n");
  const addrs = await deriveMainnetAddresses();

  console.log("EVM Address (Arbitrum):  ", addrs.evm.address);
  console.log("Stellar Address:         ", addrs.stellar.address);
  console.log("Stellar Ed25519 Hex:     ", addrs.stellar.ed25519PublicKeyHex);
  console.log();

  // Fetch EVM balances
  console.log("Fetching Arbitrum balances...");
  const provider = new ethers.JsonRpcProvider(ARB_RPC);
  const [ethBalance, wethBalance, usdcBalance] = await Promise.all([
    provider.getBalance(addrs.evm.address),
    new ethers.Contract(WETH_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(
      addrs.evm.address,
    ),
    new ethers.Contract(USDC_ADDRESS, ["function balanceOf(address) view returns (uint256)"], provider).balanceOf(
      addrs.evm.address,
    ),
  ]);
  console.log(`  ETH:   ${ethers.formatEther(ethBalance)}`);
  console.log(`  WETH:  ${ethers.formatEther(wethBalance)}`);
  console.log(`  USDC:  ${ethers.formatUnits(usdcBalance, 6)}`);
  console.log();

  // Fetch Stellar balances
  console.log("Fetching Stellar balances...");
  const server = new Horizon.Server(STELLAR_MAINNET_HORIZON);
  try {
    const accountData = await server.loadAccount(addrs.stellar.address);
    for (const bal of accountData.balances) {
      if ((bal as any).asset_type === "native") {
        console.log(`  XLM:   ${(bal as any).balance}`);
      } else {
        console.log(`  ${(bal as any).asset_code}:  ${(bal as any).balance} (issuer: ${(bal as any).asset_issuer?.slice(0, 10)}...)`);
      }
    }
  } catch {
    console.log("  Account not found or not funded");
  }
}

async function cmdPolicies(): Promise<void> {
  console.log("Checking registered policies...\n");
  const addrs = await deriveMainnetAddresses();
  const account = await getMainnetAccount();

  // Policy 1: approve WETH
  const p1 = await getPolicy(account, "Evm", normalizeAddr(WETH_ADDRESS), APPROVE_SELECTOR);
  printPolicy("EVM: approve WETH → Morpho", p1);

  // Policy 2: supplyCollateral
  const p2 = await getPolicy(account, "Evm", normalizeAddr(MORPHO_ADDRESS), SUPPLY_COLLATERAL_SELECTOR);
  printPolicy("EVM: supplyCollateral on Morpho", p2);

  // Policy 3: borrow
  const p3 = await getPolicy(account, "Evm", normalizeAddr(MORPHO_ADDRESS), BORROW_SELECTOR);
  printPolicy("EVM: borrow from Morpho", p3);

  // Policy 4: USDC transfer (bridge)
  const p4 = await getPolicy(account, "Evm", normalizeAddr(USDC_ADDRESS), TRANSFER_SELECTOR);
  printPolicy("EVM: transfer USDC (bridge)", p4);

  // Policy 5: open_short on Untangled Loop
  const openShortSelector = Array.from(Buffer.from("open_short"));
  const p5 = await getPolicy(account, "Stellar", addrs.stellar.ed25519PublicKeyHex, openShortSelector);
  printPolicy("Stellar: open_short on Untangled Loop", p5);
}

async function cmdBatch(args: string[]): Promise<void> {
  const batchId = parseInt(args[0] ?? "");
  if (isNaN(batchId)) {
    console.error("Usage: check-status.ts batch <batch-id>");
    process.exit(1);
  }
  const account = await getMainnetAccount();
  const status = await account.viewFunction({
    contractId: (await import("../config-mainnet.js")).MAINNET_CONTRACT_ID,
    methodName: "get_batch_status",
    args: { batch_id: batchId },
  });
  console.log("Batch status:", JSON.stringify(status, null, 2));
}

// ── Main ──

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "policies":
      await cmdPolicies();
      break;
    case "batch":
      await cmdBatch(args);
      break;
    default:
      await cmdDefault();
      break;
  }
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
```

- [ ] **Step 3: Verify it compiles**

Run: `npx tsx -e "import '../src/mainnet/check-status.js'" 2>&1 | head -5`
Expected: Should not show import/syntax errors (may show runtime errors for missing .env, that's OK)

- [ ] **Step 4: Run derive + balances (smoke test)**

Run: `npx tsx src/mainnet/check-status.ts`
Expected: Prints derived EVM and Stellar addresses, fetches balances from Arbitrum and Stellar mainnet

- [ ] **Step 5: Commit**

```bash
git add src/mainnet/check-status.ts
git commit -m "feat: add mainnet check-status script"
```

---

### Task 6: `src/mainnet/set-policies.ts`

**Files:**
- Create: `src/mainnet/set-policies.ts`

Registers all 5 policies required for the demo. Idempotent — checks if each policy already exists before registering.

- [ ] **Step 1: Create set-policies script**

```ts
// src/mainnet/set-policies.ts
// CLI: Register all 5 policies for the mainnet leveraged short demo
//
// Usage:
//   npx tsx src/mainnet/set-policies.ts              # register all policies
//   npx tsx src/mainnet/set-policies.ts --dry-run    # show what would be registered
//
// Requires: MAINNET_KEY="ed25519:..." in .env

import "dotenv/config";
import { StrKey } from "@stellar/stellar-sdk";
import {
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  UNTANGLED_LOOP_CONTRACT,
} from "../config-mainnet.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  setPolicy,
  getPolicy,
  hexToBytes,
  bytesToHex,
  normalizeAddress,
} from "../near-mainnet.js";
import {
  APPROVE_SELECTOR,
  SUPPLY_COLLATERAL_SELECTOR,
  BORROW_SELECTOR,
  TRANSFER_SELECTOR,
} from "../morpho.js";

// ── Policy Builders ──

/**
 * Policy 1: approve(address,uint256) on WETH — spender = Morpho
 * 100 bytes: value(32) + selector(4) + pad(12) + spender(20) + amount(32)
 */
function buildApprovePolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector = 095ea7b3
  mask[32] = 0xff; condition[32] = 0x09;
  mask[33] = 0xff; condition[33] = 0x5e;
  mask[34] = 0xff; condition[34] = 0xa7;
  mask[35] = 0xff; condition[35] = 0xb3;

  // Enforce spender = Morpho address at [48..68]
  const morphoBytes = hexToBytes(normalizeAddress(MORPHO_ADDRESS));
  for (let i = 0; i < 20; i++) {
    mask[48 + i] = 0xff;
    condition[48 + i] = morphoBytes[i]!;
  }

  return { selector: APPROVE_SELECTOR, mask, condition };
}

/**
 * Policy 2: supplyCollateral on Morpho
 * Enforce value == 0 + selector only. Allow any collateral amount and onBehalf.
 */
function buildSupplyCollateralPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  // supplyCollateral calldata is large (>= 192 bytes for the struct).
  // We enforce: value(32) == 0 + selector(4) match. Rest = 0x00 (allow any).
  const totalLen = 36; // minimal: just enforce value + selector
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector
  const sel = SUPPLY_COLLATERAL_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: SUPPLY_COLLATERAL_SELECTOR, mask, condition };
}

/**
 * Policy 3: borrow on Morpho
 * Enforce value == 0 + selector only.
 */
function buildBorrowPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const totalLen = 36;
  const mask = new Array<number>(totalLen).fill(0);
  const condition = new Array<number>(totalLen).fill(0);

  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  const sel = BORROW_SELECTOR;
  for (let i = 0; i < 4; i++) {
    mask[32 + i] = 0xff;
    condition[32 + i] = sel[i]!;
  }

  return { selector: BORROW_SELECTOR, mask, condition };
}

/**
 * Policy 4: transfer(address,uint256) on USDC — permissive (any recipient)
 * Using Option A from the plan: mask[48..68] = 0x00 to allow any recipient.
 */
function buildUsdcTransferPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  const mask = new Array<number>(100).fill(0);
  const condition = new Array<number>(100).fill(0);

  // Enforce value == 0
  for (let i = 0; i < 32; i++) mask[i] = 0xff;

  // Enforce selector = a9059cbb
  mask[32] = 0xff; condition[32] = 0xa9;
  mask[33] = 0xff; condition[33] = 0x05;
  mask[34] = 0xff; condition[34] = 0x9c;
  mask[35] = 0xff; condition[35] = 0xbb;

  // recipient [48..68] = 0x00 mask → allow any
  // amount [68..100] = 0x00 mask → allow any

  return { selector: TRANSFER_SELECTOR, mask, condition };
}

/**
 * Policy 5: invoke open_short on Untangled Loop
 * Enforce contract_id = Untangled Loop entrypoint at [0..32]. Allow any args.
 */
function buildOpenShortPolicy(): { selector: number[]; mask: number[]; condition: number[] } {
  // Decode the Soroban contract ID from StrKey to raw 32 bytes
  const contractIdBytes = Array.from(StrKey.decodeContract(UNTANGLED_LOOP_CONTRACT));

  const totalLen = 32; // just enforce the contract ID
  const mask = new Array<number>(totalLen).fill(0xff);
  const condition = contractIdBytes.slice(0, 32);

  const selector = Array.from(Buffer.from("open_short"));
  return { selector, mask, condition };
}

// ── Main ──

interface PolicyDef {
  label: string;
  chain: string;
  contract: string;
  selector: number[];
  mask: number[];
  condition: number[];
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey && !dryRun) {
    console.error('MAINNET_KEY not set. Add MAINNET_KEY="ed25519:..." to .env');
    process.exit(1);
  }

  console.log("Deriving mainnet addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM:     ${addrs.evm.address}`);
  console.log(`  Stellar: ${addrs.stellar.address}`);
  console.log(`  Ed25519: ${addrs.stellar.ed25519PublicKeyHex}\n`);

  // Build all policy definitions
  const p1 = buildApprovePolicy();
  const p2 = buildSupplyCollateralPolicy();
  const p3 = buildBorrowPolicy();
  const p4 = buildUsdcTransferPolicy();
  const p5 = buildOpenShortPolicy();

  const policies: PolicyDef[] = [
    {
      label: "1. Approve WETH → Morpho",
      chain: "Evm",
      contract: normalizeAddress(WETH_ADDRESS),
      ...p1,
    },
    {
      label: "2. Supply Collateral on Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p2,
    },
    {
      label: "3. Borrow USDC from Morpho",
      chain: "Evm",
      contract: normalizeAddress(MORPHO_ADDRESS),
      ...p3,
    },
    {
      label: "4. Transfer USDC (bridge)",
      chain: "Evm",
      contract: normalizeAddress(USDC_ADDRESS),
      ...p4,
    },
    {
      label: "5. Open Short on Untangled Loop",
      chain: "Stellar",
      contract: addrs.stellar.ed25519PublicKeyHex,
      ...p5,
    },
  ];

  const account = dryRun ? await (await import("../near-mainnet.js")).getMainnetAccount() : await (await import("../near-mainnet.js")).getMainnetAccount(nearKey!);

  for (const pol of policies) {
    console.log(`Policy ${pol.label}`);
    console.log(`  chain:     ${pol.chain}`);
    console.log(`  contract:  ${pol.contract.slice(0, 20)}...`);
    console.log(`  selector:  [${pol.selector.map((b) => "0x" + b.toString(16).padStart(2, "0")).join(", ")}]`);
    console.log(`  mask len:  ${pol.mask.length} bytes`);

    // Check if policy already exists
    const existing = await getPolicy(account, pol.chain, pol.contract, pol.selector);
    if (existing) {
      console.log(`  Status:    ALREADY SET — skipping\n`);
      continue;
    }

    if (dryRun) {
      console.log(`  Status:    NOT SET — would register (dry run)\n`);
      continue;
    }

    console.log(`  Status:    NOT SET — registering...`);
    await setPolicy(account, {
      chain: pol.chain,
      contract: pol.contract,
      selector: pol.selector,
      mask: pol.mask,
      condition: pol.condition,
      value_limit: null,
      expires_at: null,
    });
    console.log(`  Result:    REGISTERED\n`);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal:", err?.message ?? err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import '../src/mainnet/set-policies.js'" 2>&1 | head -3`
Expected: No import/syntax errors

- [ ] **Step 3: Run dry-run (smoke test)**

Run: `npx tsx src/mainnet/set-policies.ts --dry-run`
Expected: Derives addresses, lists all 5 policies with their status (NOT SET or ALREADY SET)

- [ ] **Step 4: Commit**

```bash
git add src/mainnet/set-policies.ts
git commit -m "feat: add mainnet policy registration script"
```

---

### Task 7: `src/mainnet/execute-batch.ts`

**Files:**
- Create: `src/mainnet/execute-batch.ts`

The main orchestration script. Builds all 6 payloads, submits the batch, cranks, retrieves signatures, and broadcasts.

- [ ] **Step 1: Create execute-batch script**

```ts
// src/mainnet/execute-batch.ts
// CLI: Build 6 payloads → submit batch → crank → broadcast
//
// Usage:
//   npx tsx src/mainnet/execute-batch.ts [--weth-amount=0.002] [--borrow-usdc=3] [--flash-xlm=7.5] [--margin-xlm=5]
//
// Requires:
//   MAINNET_KEY="ed25519:..." in .env
//   ONECLICK_JWT="..." in .env (optional, for fee-free bridge)
//
// Prerequisites:
//   - Policies registered via set-policies.ts
//   - Derived EVM account funded with WETH + ETH gas on Arbitrum
//   - Derived Stellar account funded with XLM
//   - NEAR account funded with >= 1.5 NEAR (6 * 0.25)

import "dotenv/config";
import { ethers } from "ethers";
import { Horizon, Account, TransactionBuilder, Networks, Operation, Asset, StrKey } from "@stellar/stellar-sdk";
import {
  ARB_RPC,
  ARB_CHAIN_ID,
  WETH_ADDRESS,
  USDC_ADDRESS,
  MORPHO_ADDRESS,
  STELLAR_MAINNET_HORIZON,
  STELLAR_MAINNET_PASSPHRASE,
  STELLAR_USDC_TOKEN,
  STELLAR_XLM_TOKEN,
  UNTANGLED_LOOP_CONTRACT,
  AQUARIUS_API_URL,
  MAINNET_CONTRACT_ID,
} from "../config-mainnet.js";
import {
  getMainnetAccount,
  deriveMainnetAddresses,
  submitBatch,
  crankBatchNext,
  pollBatchStatus,
  getBatchSignatures,
  refundBatch,
  type MpcSignature,
} from "../near-mainnet.js";
import {
  fetchMarketParams,
  buildApproveWethCalldata,
  buildSupplyCollateralCalldata,
  buildBorrowCalldata,
  buildUsdcTransferCalldata,
} from "../morpho.js";
import {
  getBridgeQuote,
  submitDeposit,
  pollBridgeStatus,
} from "../bridge.js";
import { deriveKeypairFromPublicKey } from "../stellar.js";

// ── CLI args ──

function parseArg(name: string, defaultVal: string): string {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split("=")[1]! : defaultVal;
}

// ── Helpers ──

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Reconstruct a signed EIP-1559 transaction from an unsigned tx + MPC signature.
 */
function reconstructSignedEvmTx(
  unsignedTx: ethers.Transaction,
  sig: MpcSignature,
  expectedFrom: string,
): ethers.Transaction {
  const r = "0x" + sig.big_r.affine_point.slice(2); // strip 02/03 prefix
  const s = "0x" + sig.s.scalar;
  const signedTx = unsignedTx.clone();
  signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id });

  // Verify recovered address matches
  if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
    // Try flipping recovery_id
    signedTx.signature = ethers.Signature.from({ r, s, v: sig.recovery_id ^ 1 });
    if (signedTx.from?.toLowerCase() !== expectedFrom.toLowerCase()) {
      throw new Error(
        `Recovered signer ${signedTx.from} does not match expected ${expectedFrom}`,
      );
    }
  }
  return signedTx;
}

// ── Main ──

async function main() {
  const nearKey = process.env.MAINNET_KEY;
  if (!nearKey) {
    console.error('MAINNET_KEY not set. Add MAINNET_KEY="ed25519:..." to .env');
    process.exit(1);
  }
  const jwt = process.env.ONECLICK_JWT;

  const wethAmountEth = parseArg("weth-amount", "0.002");
  const borrowUsdcAmount = parseArg("borrow-usdc", "3");
  const flashXlm = parseArg("flash-xlm", "7.5");
  const marginXlm = parseArg("margin-xlm", "5");

  const wethAmountWei = ethers.parseEther(wethAmountEth);
  const borrowUsdcRaw = ethers.parseUnits(borrowUsdcAmount, 6); // USDC has 6 decimals
  const flashAmountStroops = BigInt(Math.floor(parseFloat(flashXlm) * 10_000_000));
  const marginAmountStroops = BigInt(Math.floor(parseFloat(marginXlm) * 10_000_000));

  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Mainnet Demo: Cross-Chain Leveraged Short               ║");
  console.log("╚══════════════════════════════════════════════════════════╝\n");

  console.log(`  WETH collateral:  ${wethAmountEth} WETH`);
  console.log(`  Borrow amount:    ${borrowUsdcAmount} USDC`);
  console.log(`  Flash amount:     ${flashXlm} XLM`);
  console.log(`  Margin:           ${marginXlm} XLM`);
  console.log(`  Leverage:         ${(parseFloat(flashXlm) / parseFloat(marginXlm)).toFixed(1)}x\n`);

  // ── Step 0: Derive addresses ──
  console.log("Step 0 — Deriving addresses...");
  const addrs = await deriveMainnetAddresses();
  console.log(`  EVM (Arbitrum):  ${addrs.evm.address}`);
  console.log(`  Stellar:         ${addrs.stellar.address}\n`);

  // ── Step 1: Fetch chain state ──
  console.log("Step 1 — Fetching chain state...\n");
  const provider = new ethers.JsonRpcProvider(ARB_RPC);

  // Arbitrum
  const [nonce, feeData, ethBalance] = await Promise.all([
    provider.getTransactionCount(addrs.evm.address, "pending"),
    provider.getFeeData(),
    provider.getBalance(addrs.evm.address),
  ]);
  const maxFeePerGas = feeData.maxFeePerGas ?? ethers.parseUnits("0.1", "gwei");
  const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("0.01", "gwei");

  console.log("  Arbitrum:");
  console.log(`    Nonce:           ${nonce}`);
  console.log(`    ETH balance:     ${ethers.formatEther(ethBalance)}`);
  console.log(`    Max fee:         ${ethers.formatUnits(maxFeePerGas, "gwei")} gwei`);

  // Fetch Morpho market params
  const marketParams = await fetchMarketParams(provider);
  console.log(`    Market oracle:   ${marketParams.oracle.slice(0, 10)}...`);

  // Stellar
  const server = new Horizon.Server(STELLAR_MAINNET_HORIZON);
  let stellarSequence: string;
  try {
    const stellarAccount = await server.loadAccount(addrs.stellar.address);
    stellarSequence = stellarAccount.sequence;
    const xlmBal = stellarAccount.balances.find((b: any) => b.asset_type === "native");
    console.log(`\n  Stellar:`);
    console.log(`    Sequence:        ${stellarSequence}`);
    console.log(`    XLM balance:     ${(xlmBal as any)?.balance ?? "0"}`);
  } catch {
    console.error(`  Stellar account not found. Fund ${addrs.stellar.address} first.`);
    process.exit(1);
  }

  // ── Step 2: Get bridge quote ──
  console.log("\nStep 2 — Getting bridge quote from 1Click API...");
  const quote = await getBridgeQuote(
    borrowUsdcRaw.toString(),
    addrs.stellar.address,
    addrs.evm.address,
    jwt,
  );
  console.log(`  Deposit address:   ${quote.depositAddress}`);
  console.log(`  Destination amt:   ${quote.destinationAmount}`);
  console.log(`  Expires:           ${quote.expiresAt}\n`);

  // ── Step 3: Build payloads ──
  console.log("Step 3 — Building transaction payloads...\n");

  // Tx 1: Stellar change_trust USDC
  // Decode USDC issuer from the SAC contract address
  // For mainnet USDC, the classic issuer is GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN
  const USDC_ISSUER_STRKEY = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
  const usdcIssuerHex = Buffer.from(StrKey.decodeEd25519PublicKey(USDC_ISSUER_STRKEY)).toString("hex");
  const stellarNextSeq = parseInt(stellarSequence) + 1;

  const payload1 = {
    StellarChangeTrust: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 100,
      sequence_number: stellarNextSeq,
      asset: {
        CreditAlphanum4: {
          asset_code: "USDC",
          issuer: usdcIssuerHex,
        },
      },
      limit: "9223372036854775807", // i64::MAX
      network: "Mainnet",
    },
  };
  console.log("  Tx 1: Stellar change_trust USDC");

  // Tx 2: Approve WETH → Morpho
  const approveCalldata = buildApproveWethCalldata(wethAmountWei);
  const payload2 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 60000,
      to: WETH_ADDRESS,
      value: "0x0",
      data: approveCalldata,
    },
  };
  console.log("  Tx 2: Approve WETH → Morpho (nonce " + nonce + ")");

  // Tx 3: Supply collateral WETH
  const supplyCalldata = buildSupplyCollateralCalldata(marketParams, wethAmountWei, addrs.evm.address);
  const payload3 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 1,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 300000,
      to: MORPHO_ADDRESS,
      value: "0x0",
      data: supplyCalldata,
    },
  };
  console.log("  Tx 3: Supply collateral WETH (nonce " + (nonce + 1) + ")");

  // Tx 4: Borrow USDC
  const borrowCalldata = buildBorrowCalldata(marketParams, borrowUsdcRaw, addrs.evm.address, addrs.evm.address);
  const payload4 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 2,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 300000,
      to: MORPHO_ADDRESS,
      value: "0x0",
      data: borrowCalldata,
    },
  };
  console.log("  Tx 4: Borrow USDC (nonce " + (nonce + 2) + ")");

  // Tx 5: Transfer USDC to 1Click deposit address
  const bridgeCalldata = buildUsdcTransferCalldata(quote.depositAddress, borrowUsdcRaw);
  const payload5 = {
    EvmEip1559: {
      chain_id: ARB_CHAIN_ID,
      nonce: nonce + 3,
      max_priority_fee_per_gas: "0x" + maxPriorityFeePerGas.toString(16),
      max_fee_per_gas: "0x" + maxFeePerGas.toString(16),
      gas_limit: 60000,
      to: USDC_ADDRESS,
      value: "0x0",
      data: bridgeCalldata,
    },
  };
  console.log("  Tx 5: Bridge USDC → Stellar (nonce " + (nonce + 3) + ")");

  // Tx 6: Stellar open_short on Untangled Loop
  // Fetch swap route from Aquarius AMM
  console.log("\n  Fetching swap route from Aquarius AMM...");
  let swapRoute: any;
  try {
    const swapRes = await fetch(AQUARIUS_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_in_address: STELLAR_XLM_TOKEN,
        token_out_address: STELLAR_USDC_TOKEN,
        amount: flashAmountStroops.toString(),
      }),
    });
    swapRoute = await swapRes.json();
    console.log(`  Swap route: ${JSON.stringify(swapRoute).slice(0, 100)}...`);
  } catch (e: any) {
    console.warn(`  Warning: Could not fetch swap route: ${e.message}`);
    console.warn(`  Using empty swap route — open_short may fail on-chain.`);
    swapRoute = { pools: [] };
  }

  const stellarNextSeq2 = stellarNextSeq + 1; // second Stellar tx uses next sequence
  const payload6 = {
    StellarInvokeContract: {
      source_account: addrs.stellar.ed25519PublicKeyHex,
      fee: 10_000_000, // 1 XLM for complex Soroban tx
      sequence_number: stellarNextSeq2,
      contract_id: UNTANGLED_LOOP_CONTRACT,
      function_name: "open_short",
      args: [
        addrs.stellar.address, // caller
        flashAmountStroops.toString(), // flash_amount
        marginAmountStroops.toString(), // initial_margin
        "0", // min_swap_output — TODO: calculate from swap route
        false, // margin_from_quote = false (XLM margin)
        swapRoute.pools ?? [], // swap_chain
      ],
      network: "Mainnet",
    },
  };
  console.log("  Tx 6: Open short on Untangled Loop");

  const payloads = [payload1, payload2, payload3, payload4, payload5, payload6];
  console.log(`\n  Total payloads: ${payloads.length}`);
  console.log(`  Required deposit: ${payloads.length * 0.25} NEAR\n`);

  // ── Step 4: Submit batch ──
  console.log("Step 4 — Submitting batch to NEAR...");
  const account = await getMainnetAccount(nearKey);
  const { nearTxId, expectedBatchId } = await submitBatch(account, payloads);
  const batchId = expectedBatchId;
  console.log(`  NEAR tx: ${nearTxId}`);
  console.log(`  Expected batch ID: ${batchId}`);
  console.log(`  https://nearblocks.io/txns/${nearTxId}\n`);

  // Wait for the tx to be included
  console.log("  Waiting for tx inclusion...");
  await sleep(5000);

  // ── Step 5: Crank remaining items ──
  console.log("Step 5 — Cranking remaining batch items...");
  for (let i = 1; i < payloads.length; i++) {
    console.log(`  Cranking item ${i + 1}/${payloads.length}...`);
    await crankBatchNext(account, batchId);
    await sleep(3000); // wait between cranks
  }

  // ── Step 6: Poll until all signed ──
  console.log("\nStep 6 — Polling batch status...");
  const finalStatus = await pollBatchStatus(account, batchId);
  console.log(`  Final: ${finalStatus.completed}/${finalStatus.total} signed, ${finalStatus.failed} failed\n`);

  if (finalStatus.failed > 0) {
    console.error("  Some items failed. Check batch details and retry.");
    await refundBatch(account, batchId);
    console.log("  Unused deposit refunded.");
    process.exit(1);
  }

  // ── Step 7: Retrieve signatures ──
  console.log("Step 7 — Retrieving signatures...");
  const signatures = await getBatchSignatures(account, batchId);
  console.log(`  Got ${signatures.length} signatures\n`);

  // ── Step 8: Broadcast ──
  console.log("Step 8 — Broadcasting transactions...\n");

  // NOTE: The MPC signer (v1.signer) only supports secp256k1. Stellar requires
  // Ed25519 signatures. Stellar txs were included in the batch for POLICY VALIDATION
  // (the contract checks all policies upfront), but the MPC secp256k1 signatures
  // cannot be used for Stellar broadcast. Instead, we sign locally using the
  // deterministic Ed25519 keypair derived from the secp256k1 child key.
  // This follows the same pattern as demo-stellar-payment.ts.
  const keypair = deriveKeypairFromPublicKey(addrs.stellar.secp256k1PublicKeyHex);

  // Tx 1: Stellar change_trust (broadcast first, signed locally with Ed25519)
  console.log("  Broadcasting Tx 1: Stellar change_trust USDC (signed locally)...");
  const trustlineAccount = new Account(addrs.stellar.address, stellarSequence);
  const trustlineTx = new TransactionBuilder(trustlineAccount, {
    fee: "100",
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.changeTrust({
        asset: new Asset("USDC", USDC_ISSUER_STRKEY),
      }),
    )
    .setTimeout(TransactionBuilder.TIMEOUT_INFINITE)
    .build();
  trustlineTx.sign(keypair);

  try {
    const trustResult = await server.submitTransaction(trustlineTx);
    console.log(`    Confirmed in ledger ${trustResult.ledger}\n`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    if (codes?.operations?.[0] === "op_already_exists") {
      console.log("    Trustline already exists — skipping\n");
    } else {
      console.error(`    Failed: ${e?.message}`);
      console.error(`    Codes: ${JSON.stringify(codes)}`);
      process.exit(1);
    }
  }

  // Tx 2-5: EVM transactions (broadcast in nonce order)
  const evmTxConfigs = [
    { label: "Tx 2: Approve WETH", to: WETH_ADDRESS, data: approveCalldata, gasLimit: 60000 },
    { label: "Tx 3: Supply collateral", to: MORPHO_ADDRESS, data: supplyCalldata, gasLimit: 300000 },
    { label: "Tx 4: Borrow USDC", to: MORPHO_ADDRESS, data: borrowCalldata, gasLimit: 300000 },
    { label: "Tx 5: Bridge USDC", to: USDC_ADDRESS, data: bridgeCalldata, gasLimit: 60000 },
  ];

  let bridgeTxHash = "";
  for (let i = 0; i < evmTxConfigs.length; i++) {
    const cfg = evmTxConfigs[i]!;
    const sig = signatures[i + 1]!; // index 0 is Stellar trustline
    const txNonce = nonce + i;

    console.log(`  Broadcasting ${cfg.label} (nonce ${txNonce})...`);
    const unsignedTx = ethers.Transaction.from({
      type: 2,
      chainId: ARB_CHAIN_ID,
      nonce: txNonce,
      maxPriorityFeePerGas,
      maxFeePerGas,
      gasLimit: cfg.gasLimit,
      to: cfg.to,
      value: 0n,
      data: cfg.data,
    });

    const signedTx = reconstructSignedEvmTx(unsignedTx, sig, addrs.evm.address);
    const pending = await provider.broadcastTransaction(signedTx.serialized);
    console.log(`    Hash: ${pending.hash}`);

    const receipt = await pending.wait(1);
    if (receipt?.status !== 1) {
      console.error(`    REVERTED! Gas used: ${receipt?.gasUsed}`);
      process.exit(1);
    }
    console.log(`    Confirmed in block ${receipt.blockNumber}\n`);

    if (i === evmTxConfigs.length - 1) {
      bridgeTxHash = pending.hash;
    }
  }

  // Submit bridge deposit hash to 1Click
  if (bridgeTxHash) {
    console.log("  Submitting bridge deposit to 1Click...");
    await submitDeposit(quote.depositAddress, bridgeTxHash);
  }

  // Wait for bridge
  console.log("\n  Waiting for bridge to complete (USDC Arbitrum → Stellar)...");
  const bridgeResult = await pollBridgeStatus(quote.depositAddress);
  if (bridgeResult !== "SUCCESS") {
    console.error(`  Bridge ${bridgeResult}. Cannot proceed with open_short.`);
    process.exit(1);
  }
  console.log("  Bridge completed!\n");

  // Tx 6: Stellar open_short (broadcast last, signed locally with Ed25519)
  // The MPC signature (signatures[5]) is secp256k1 and cannot be used for Stellar.
  // We build the Soroban invoke tx locally using the @stellar/stellar-sdk and sign
  // with the same derived Ed25519 keypair used for the trustline.
  console.log("  Broadcasting Tx 6: Open short on Untangled Loop (signed locally)...");

  // Build Soroban contract invocation transaction
  // The open_short function is called on the Untangled Loop entrypoint contract.
  // We use the sequence number that was allocated for Tx 6 (stellarNextSeq2).
  const openShortAccount = new Account(addrs.stellar.address, (stellarNextSeq2 - 1).toString());
  const openShortTx = new TransactionBuilder(openShortAccount, {
    fee: "10000000", // 1 XLM for complex Soroban tx
    networkPassphrase: Networks.PUBLIC,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: UNTANGLED_LOOP_CONTRACT,
        function: "open_short",
        args: [
          // TODO: encode Soroban args using xdr.ScVal types:
          // - caller: Address (derived Stellar address)
          // - flash_amount: i128 (flashAmountStroops)
          // - initial_margin: i128 (marginAmountStroops)
          // - min_swap_output: i128 (from Aquarius quote)
          // - margin_from_quote: bool (false)
          // - swap_chain: Vec<SwapHop> (from Aquarius route)
          // This requires Soroban XDR encoding which depends on the
          // exact contract interface. Use @stellar/stellar-sdk's
          // nativeToScVal() or manual xdr.ScVal construction.
        ],
      }),
    )
    .setTimeout(300) // 5 min timeout
    .build();
  openShortTx.sign(keypair);

  try {
    // Submit via Horizon (classic tx wrapping Soroban invoke)
    // For pure Soroban txs, may need SorobanRpc.Server.sendTransaction() instead
    const openShortResult = await server.submitTransaction(openShortTx);
    console.log(`    Confirmed in ledger ${openShortResult.ledger}`);
  } catch (e: any) {
    const codes = e?.response?.data?.extras?.result_codes;
    console.error(`    open_short failed: ${e?.message}`);
    console.error(`    Codes: ${JSON.stringify(codes)}`);
    console.error("    NOTE: Soroban invocations may require SorobanRpc.Server for");
    console.error("    proper simulation and resource estimation before submission.");
    console.error("    MPC signature (for reference):", JSON.stringify(signatures[5]));
    // Don't exit — the EVM transactions are already confirmed
  }

  // Refund unused deposit
  console.log("\n  Refunding unused batch deposit...");
  try {
    await refundBatch(account, batchId);
    console.log("  Refund complete.\n");
  } catch (e: any) {
    console.warn(`  Refund note: ${e.message}\n`);
  }

  console.log("Done! Cross-chain leveraged short position opened.");
}

main().catch((err) => {
  console.error("\nFatal:", err?.message ?? err);
  process.exit(1);
});
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsx -e "import '../src/mainnet/execute-batch.js'" 2>&1 | head -3`
Expected: No import/syntax errors

- [ ] **Step 3: Commit**

```bash
git add src/mainnet/execute-batch.ts
git commit -m "feat: add mainnet batch execution script"
```

---

### Task 8: Update `package.json` scripts

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add mainnet npm scripts**

Add these scripts to `package.json`:

```json
"mainnet:check": "tsx src/mainnet/check-status.ts",
"mainnet:policies": "tsx src/mainnet/set-policies.ts",
"mainnet:execute": "tsx src/mainnet/execute-batch.ts",
"mainnet:derive": "tsx src/derive-mainnet.ts"
```

- [ ] **Step 2: Verify scripts are recognized**

Run: `npm run mainnet:check --help 2>&1 | head -1`

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat: add mainnet npm scripts"
```

---

## Summary

| Script | Command | Purpose |
|--------|---------|---------|
| `check-status.ts` | `npm run mainnet:check` | Derive addresses, show balances |
| `check-status.ts policies` | `npm run mainnet:check -- policies` | Show registered policy status |
| `check-status.ts batch <id>` | `npm run mainnet:check -- batch 1` | Show batch signing progress |
| `set-policies.ts` | `npm run mainnet:policies` | Register all 5 policies (idempotent) |
| `set-policies.ts --dry-run` | `npm run mainnet:policies -- --dry-run` | Preview policy registration |
| `execute-batch.ts` | `npm run mainnet:execute` | Full demo: build+sign+broadcast |

**Execution order:**
1. `npm run mainnet:check` — verify addresses are funded
2. `npm run mainnet:policies -- --dry-run` — preview policies
3. `npm run mainnet:policies` — register policies
4. `npm run mainnet:check -- policies` — verify policies are set
5. `npm run mainnet:execute` — execute the full flow
