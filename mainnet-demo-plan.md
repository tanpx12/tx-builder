# Mainnet Demo: Cross-Chain Leveraged Short via Universal Account

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a cross-chain leveraged short strategy — supply WETH collateral on Morpho (Arbitrum), borrow USDC, bridge it to Stellar via NEAR Intent, and open a 1.5x short position on XLM/USDC via the Untangled Loop contract — all orchestrated through a single NEAR universal account using batch signing.

**Architecture:** The NEAR asset-manager contract (mainnet implicit account `8fa7...556e`) derives deterministic addresses on both Arbitrum and Stellar via MPC chain signatures. Policies are registered to whitelist each on-chain interaction before signing. Transactions are submitted as a batch via `request_batch_signature()`, cranked with `sign_batch_next()`, then broadcast to their respective chains.

**Tech Stack:** TypeScript (ESM via tsx), near-api-js, ethers.js v6, @stellar/stellar-sdk, Morpho Blue (Arbitrum), Aquarius AMM (Stellar), 1ClickAPI (NEAR Intent bridge)

---

## Networks & Contracts

| Network | Item | Address / Value |
|---------|------|-----------------|
| **NEAR mainnet** | Asset-manager contract | `8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e` |
| **NEAR mainnet** | MPC signer | `v1.signer` |
| **NEAR mainnet** | RPC | `https://rpc.mainnet.near.org` |
| **Arbitrum One** | Chain ID | `42161` |
| **Arbitrum One** | RPC | `https://red-soft-aura.arbitrum-mainnet.quiknode.pro/` |
| **Arbitrum One** | Morpho Blue | `0x6c247b1F6182318877311737BaC0844bAa518F5e` |
| **Arbitrum One** | WETH/USDC Market ID | `0xb323495f7e4148be5643a4ea4a8221eef163e4bccfdedc2a6f4696baacbc86cc` |
| **Arbitrum One** | WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` |
| **Arbitrum One** | USDC | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| **Stellar mainnet** | Soroban RPC | `https://mainnet.sorobanrpc.com` |
| **Stellar mainnet** | Horizon | `https://horizon.stellar.org` |
| **Stellar mainnet** | Untangled Loop (entrypoint) | `CC6PV65GIWRTOYSM7NWMCF5OCWLNGUOGBVXJ7DV57KTAPJNMFE27USPH` |
| **Stellar mainnet** | Margin Manager | `CCC27LQ43TXGZUTTKFYV2ZLSKX3MMVWCAZDFCEERQHY67C7EQBWB2UKK` |
| **Stellar mainnet** | Blend Pool | `CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD` |
| **Stellar mainnet** | XLM token (wrapped) | `CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA` |
| **Stellar mainnet** | USDC token | `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` |

---

## Prerequisites

Before running the demo, ensure:

1. **Derived EVM account (Arbitrum)** is funded with:
   - ~$5 worth of WETH as Morpho collateral (~0.0023 WETH)
   - ETH for gas on Arbitrum (~0.001 ETH)

2. **Derived Stellar account** is funded with:
   - XLM for Soroban tx fees + initial margin for the short position (e.g., 5 XLM)
   - (USDC trustline is set up automatically as Tx 1 in the batch)

3. **NEAR mainnet account** (`8fa7...556e`) is funded with:
   - `N * 0.25 NEAR` for MPC signing fees (where N = number of transactions in the batch)
   - The asset-manager contract is deployed and initialized with `mpc_signer: "v1.signer"`

4. **`.env` file** contains:
   ```
   KEY="ed25519:<NEAR_MAINNET_PRIVATE_KEY>"
   ONECLICK_JWT="<JWT_FROM_PARTNERS_DASHBOARD>"
   ```

---

## Overall Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                     NEAR Universal Account                          │
│          (8fa7...556e on NEAR mainnet, owns MPC keys)               │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  Step 0: Derive addresses on Arbitrum + Stellar                     │
│                    │                                                │
│  Step 1: Register policies (whitelist allowed operations)           │
│           ├── EVM: approve WETH → Morpho                            │
│           ├── EVM: supplyCollateral on Morpho                       │
│           ├── EVM: borrow USDC from Morpho                          │
│           ├── Stellar: change_trust USDC (trustline setup)          │
│           └── Stellar: invoke open_short on Untangled Loop          │
│                    │                                                │
│  Step 2: Build & sign transaction batch                             │
│           ├── Tx 1: Stellar — change_trust USDC (setup trustline)   │
│           ├── Tx 2: EVM — approve WETH for Morpho                   │
│           ├── Tx 3: EVM — supplyCollateral(WETH) on Morpho          │
│           ├── Tx 4: EVM — borrow(USDC) from Morpho                  │
│           ├── Tx 5: Bridge — USDC Arbitrum → Stellar via 1ClickAPI  │
│           └── Tx 6: Stellar — open_short on Untangled Loop          │
│                    │                                                │
│  Step 3: Broadcast signed transactions to each chain                │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Step 0: Derive & Log Addresses

**Purpose:** Derive the deterministic EVM and Stellar addresses controlled by the mainnet universal account. These are the addresses that hold funds and interact with DeFi protocols.

**Derivation paths** (format: `<contract_id>,<owner>,<chain>,<index>`):
- EVM: `8fa7...556e,8fa7...556e,ethereum,0`
- Stellar: `8fa7...556e,8fa7...556e,stellar,0`

**How it works:**
1. Call `derived_public_key` on `v1.signer` (NEAR mainnet MPC) with each path
2. For EVM: `keccak256(pubkey[1:])` → last 20 bytes → checksummed address
3. For Stellar: `SHA-256(compressed_secp256k1_key)` → 32-byte Ed25519 seed → `G...` StrKey address

**Implementation:** Adapt `src/derive-mainnet.ts` — it already derives both addresses from the mainnet MPC signer. The script logs the derived EVM address (for Arbitrum) and Stellar address (for mainnet).

**Output example:**
```
EVM Address (Arbitrum):  0x1234...abcd
Stellar Address:         GABCD...WXYZ
Stellar Ed25519 Hex:     a1b2c3...
```

---

## Step 1: Register Policies

**Purpose:** The asset-manager contract enforces a `DenyAll` default policy on mainnet. Every on-chain interaction must be explicitly whitelisted before the contract will forward a signing request to the MPC. Policies are registered by the contract owner via `set_policy()`.

### 1A. EVM Policies (Arbitrum)

Three EVM policies are needed to execute the Morpho supply-and-borrow flow:

#### Policy 1: Approve WETH for Morpho

Whitelist `ERC-20 approve(address,uint256)` on the WETH token contract, with `spender = Morpho Blue`.

| Field | Value |
|-------|-------|
| `chain` | `"Evm"` |
| `contract` | WETH token address (lowercase, no 0x) |
| `selector` | `[0x09, 0x5e, 0xa7, 0xb3]` — `approve(address,uint256)` |
| `mask[0..32]` | `0xFF` × 32 — enforce `tx.value == 0` (no ETH sent) |
| `mask[32..36]` | `0xFF` × 4 — enforce selector = `095ea7b3` |
| `mask[48..68]` | `0xFF` × 20 — enforce spender = Morpho address |
| `mask[68..100]` | `0x00` × 32 — allow any approval amount |
| `condition[48..68]` | Morpho Blue address bytes (`6c247b1f...518f5e`) |

#### Policy 2: Supply Collateral to Morpho

Whitelist `supplyCollateral(MarketParams,uint256,address,bytes)` on Morpho Blue.

| Field | Value |
|-------|-------|
| `chain` | `"Evm"` |
| `contract` | `6c247b1f6182318877311737bac0844baa518f5e` (Morpho Blue) |
| `selector` | First 4 bytes of `keccak256("supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)")` |
| `mask` | Enforce `tx.value == 0` + selector. Optionally enforce `onBehalf` = derived address. Allow any collateral amount. |
| `condition` | Matching bytes for enforced positions |

#### Policy 3: Borrow USDC from Morpho

Whitelist `borrow(MarketParams,uint256,uint256,address,address)` on Morpho Blue.

| Field | Value |
|-------|-------|
| `chain` | `"Evm"` |
| `contract` | `6c247b1f6182318877311737bac0844baa518f5e` (Morpho Blue) |
| `selector` | First 4 bytes of `keccak256("borrow((address,address,address,address,uint256),uint256,uint256,address,address)")` |
| `mask` | Enforce `tx.value == 0` + selector. Optionally enforce `onBehalf` and `receiver` = derived address. Allow any borrow amount. |
| `condition` | Matching bytes for enforced positions |

#### Policy 4: Transfer USDC to 1Click Bridge Deposit Address

Whitelist `ERC-20 transfer(address,uint256)` on the USDC token contract, allowing the derived EVM address to send USDC to the 1Click deposit address returned by the quote API.

**Note:** The deposit address is dynamic (returned per-quote by the 1Click API). Two approaches:
- **Option A (permissive):** Register the policy with `mask[48..68] = 0x00` (allow transfer to any recipient). Simpler but less restrictive.
- **Option B (strict):** Fetch the quote first, then register a policy enforcing the exact deposit address before submitting the batch. More secure but requires an extra step.

| Field | Value |
|-------|-------|
| `chain` | `"Evm"` |
| `contract` | `af88d065e77c8cc2239327c5edb3a432268e5831` (USDC on Arbitrum) |
| `selector` | `[0xa9, 0x05, 0x9c, 0xbb]` — `transfer(address,uint256)` |
| `mask[0..32]` | `0xFF` x 32 — enforce `tx.value == 0` (no ETH sent) |
| `mask[32..36]` | `0xFF` x 4 — enforce selector = `a9059cbb` |
| `mask[48..68]` | `0xFF` x 20 (Option B) or `0x00` x 20 (Option A) |
| `mask[68..100]` | `0x00` x 32 — allow any transfer amount |
| `condition[48..68]` | 1Click deposit address bytes (Option B) or zeros (Option A) |

### 1B. Stellar Policies

**Note:** `StellarChangeTrust` is **exempt from policy checks** in the asset-manager contract. No policy registration is needed for the USDC trustline setup (Tx 1). Only `open_short` requires a policy.

#### Policy 5: Invoke `open_short` on Untangled Loop

Whitelist the `open_short` Soroban contract invocation on the entrypoint contract.

| Field | Value |
|-------|-------|
| `chain` | `"Stellar"` |
| `contract` | Derived Stellar Ed25519 public key hex (32 bytes — the source account) |
| `selector` | UTF-8 bytes of `"open_short"` → `[111, 112, 101, 110, 95, 115, 104, 111, 114, 116]` |
| `mask` | Enforce contract ID = Untangled Loop entrypoint. Allow any arguments (flash_amount, initial_margin, min_swap_output, etc.) |
| `condition` | Contract ID bytes of `CAUZ4WS7EGHD7T2ICR4C5XDVLIOLK7QVVBSPFZSOQKVBCQJV4ISBRUMH` at position [0..32] |

**Registration command pattern (for each policy):**
```ts
await account.functionCall({
  contractId: MAINNET_CONTRACT_ID,
  methodName: "set_policy",
  args: {
    registration: {
      chain: "Evm" | "Stellar",
      contract: "<target>",
      selector: [...],
      mask: [...],
      condition: [...],
      value_limit: null,
      expires_at: null,
    }
  },
  gas: BigInt("30000000000000"),
  attachedDeposit: BigInt("0"),
});
```

---

## Step 2: Build & Execute Transaction Batch

**Purpose:** Construct all transaction payloads, then submit them in a **single batch** via `request_batch_signature()`. The contract validates all policies upfront, signs the first item immediately, and queues the rest. Each subsequent item is signed by calling `sign_batch_next()`. Once all signatures are collected, broadcast the signed transactions to their respective chains.

**Deposit:** `N * 0.25 NEAR` where N = number of payloads in the batch.

Sections 2A–2D below describe each **payload** in the batch array. Section 2E shows the batch submission and cranking flow.

### 2A. Stellar Trustline Payload (Tx 1)

The first payload sets up a USDC trustline on the derived Stellar account. This must be broadcast and confirmed **before** the bridge transaction (Tx 5) sends USDC to Stellar. No policy is required — `StellarChangeTrust` is exempt from policy checks.

**USDC on Stellar mainnet:** `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`
- Asset code: `USDC`
- Issuer (Ed25519 hex): decode the StrKey issuer from the USDC token contract

```ts
{
  StellarChangeTrust: {
    source_account: "<derived_ed25519_hex>",
    fee: 100,                    // 0.00001 XLM
    sequence_number: <next_seq>,
    asset: {
      CreditAlphanum4: {
        asset_code: "USDC",
        issuer: "<usdc_issuer_ed25519_hex>",
      }
    },
    limit: 9223372036854775807,  // i64::MAX — unlimited trustline
    network: "Mainnet",
  }
}
```

### 2B. EVM Payloads (Arbitrum One)

Three EVM payloads target Arbitrum One (chain ID `42161`). They must use consecutive nonces.

#### Tx 2: Approve WETH → Morpho

```ts
{
  EvmEip1559: {
    chain_id: 42161,
    nonce: <current_nonce>,
    max_priority_fee_per_gas: "0x...",
    max_fee_per_gas: "0x...",
    gas_limit: 60000,  // ERC-20 approve
    to: "<WETH_TOKEN_ADDRESS>",
    value: "0x0",
    data: "0x095ea7b3" + abi.encode(MORPHO_ADDRESS, supplyAmount),
  }
}
```

#### Tx 3: Supply Collateral (WETH) to Morpho

```ts
{
  EvmEip1559: {
    chain_id: 42161,
    nonce: <current_nonce + 1>,
    max_priority_fee_per_gas: "0x...",
    max_fee_per_gas: "0x...",
    gas_limit: 300000,  // Morpho supplyCollateral
    to: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    value: "0x0",
    data: morphoBlue.interface.encodeFunctionData("supplyCollateral", [
      marketParams, supplyAmount, derivedEvmAddress, "0x"
    ]),
  }
}
```

#### Tx 4: Borrow USDC from Morpho

```ts
{
  EvmEip1559: {
    chain_id: 42161,
    nonce: <current_nonce + 2>,
    max_priority_fee_per_gas: "0x...",
    max_fee_per_gas: "0x...",
    gas_limit: 300000,  // Morpho borrow
    to: "0x6c247b1F6182318877311737BaC0844bAa518F5e",
    value: "0x0",
    data: morphoBlue.interface.encodeFunctionData("borrow", [
      marketParams, borrowAmount, 0, derivedEvmAddress, derivedEvmAddress
    ]),
  }
}
```

### 2C. Bridge Payload (Arbitrum → Stellar via 1Click API)

**Mechanism:** Use the [1Click API](https://docs.near-intents.org/integration/distribution-channels/1click-api/about-1click-api) to bridge USDC from Arbitrum to the **derived Stellar address** (`G...` StrKey from Step 0). The 1Click API coordinates a NEAR Intent swap — the user deposits USDC on Arbitrum to a solver-provided deposit address, and the solver delivers USDC to the derived Stellar address as the designated receiver.

**This adds one more EVM payload to the batch** (Tx 5: ERC-20 `transfer` of USDC to the 1Click deposit address). This requires **Policy 4** (USDC transfer) to be registered in Step 1.

**API base URL:** `https://1click.chaindefuser.com/v0`

**Authentication:** JWT token via `Authorization: Bearer <token>` header (obtain from [Partner Dashboard](https://partners.near-intents.org/home)). Unauthenticated requests incur a 0.2% fee.

**Asset IDs:**

- Arbitrum USDC: `nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near`
- Stellar USDC: `nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu` (7 decimals)

**Integration flow:**

1. **Request a quote** — `POST /quote`:

```ts
const quoteResponse = await fetch("https://1click.chaindefuser.com/v0/quote", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + process.env.ONECLICK_JWT,
  },
  body: JSON.stringify({
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,  // 1%
    originAsset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu",
    amount: borrowedUsdcAmount,  // in smallest unit (6 decimals for USDC)
    recipient: derivedStellarAddress,  // G... StrKey from Step 0
    recipientType: "DESTINATION_CHAIN",
    refundTo: derivedEvmAddress,  // refund to derived Arbitrum address if bridge fails
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),  // 10 min
  }),
});
const quote = await quoteResponse.json();
const depositAddress = quote.quote.depositAddress;  // EVM address to send USDC to
```

2. **Build EVM payload** — ERC-20 `transfer(address,uint256)` of USDC to the `depositAddress`:

```ts
// Tx 5 in the batch
{
  EvmEip1559: {
    chain_id: 42161,
    nonce: <current_nonce + 3>,
    max_priority_fee_per_gas: "0x...",
    max_fee_per_gas: "0x...",
    gas_limit: 60000,
    to: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",  // USDC contract
    value: "0x0",
    data: "0xa9059cbb" + abi.encode(depositAddress, borrowedUsdcAmount),
  }
}
```

3. **After broadcast** — submit the deposit tx hash to 1Click for faster tracking:

```ts
await fetch("https://1click.chaindefuser.com/v0/deposit/submit", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    depositAddress: depositAddress,
    txHash: broadcastedTxHash,
  }),
});
```

4. **Poll status** until USDC arrives on Stellar:

```ts
let status;
do {
  const res = await fetch(
    `https://1click.chaindefuser.com/v0/status?depositAddress=${depositAddress}`
  );
  status = (await res.json()).status;
  // Possible values: PENDING_DEPOSIT → KNOWN_DEPOSIT_TX → PROCESSING → SUCCESS
  if (status !== "SUCCESS") await sleep(5000);
} while (status !== "SUCCESS" && status !== "FAILED" && status !== "REFUNDED");
```

*Note: The bridge is asynchronous — typically takes 1-5 minutes. The `open_short` on Stellar (Tx 6) must wait until the 1Click status is `SUCCESS` before broadcasting.*

### 2D. Stellar Payload — Open Short (Tx 6)

This is the final payload in the batch. After bridged USDC arrives on Stellar, the signed `open_short` transaction is broadcast.

**`open_short` parameters:**

| Parameter | Type | Description | Example Value |
|-----------|------|-------------|---------------|
| `caller` | `Address` | Derived Stellar address | `G...` StrKey |
| `flash_amount` | `i128` | Amount of XLM to flash loan (in stroops) | `75_000_000` (7.5 XLM) |
| `initial_margin` | `i128` | Margin amount (in stroops) | `50_000_000` (5 XLM) |
| `min_swap_output` | `i128` | Minimum USDC from XLM→USDC swap (slippage) | Fetched from Aquarius API |
| `margin_from_quote` | `bool` | `true` = margin in USDC, `false` = margin in XLM | `false` |
| `swap_chain` | `Vec<SwapHop>` | Swap route from Aquarius AMM API | Decoded from API response |

**Leverage calculation (1.5x):**
- With `margin_from_quote = false` (XLM margin):
  - Effective exposure = `flash_amount` XLM short
  - Margin = `initial_margin` XLM
  - Leverage = `flash_amount / initial_margin` = e.g., `7.5 / 5 = 1.5x`
  - Borrow = `flash_amount - initial_margin` = `2.5 XLM`

**Pre-flight: Fetch swap route from Aquarius:**
```ts
const swapRoute = await fetch("https://amm-api.aqua.network/pools/find-path/", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    token_in_address: XLM_TOKEN,   // CAS3J7...OWMA
    token_out_address: USDC_TOKEN, // CCW67T...MI75
    amount: flashAmount,
  }),
});
```

**Contract payload:**
```ts
{
  StellarInvokeContract: {
    source_account: "<derived_ed25519_hex>",
    fee: 10_000_000,  // 1 XLM for complex Soroban tx
    sequence_number: <next_seq>,
    contract_id: "CAUZ4WS7EGHD7T2ICR4C5XDVLIOLK7QVVBSPFZSOQKVBCQJV4ISBRUMH",
    function_name: "open_short",
    args: [caller, flash_amount, initial_margin, min_swap_output, margin_from_quote, swap_chain],
    network: "Mainnet",
  }
}
```

### 2E. Batch Submission via `request_batch_signature()`

All payloads from sections 2A–2D are collected into a single array and submitted as one batch. The contract validates every policy upfront before signing anything — if any policy check fails, the entire batch is rejected. (`StellarChangeTrust` is policy-exempt so it always passes.)

```ts
// 1. Collect all payloads into a single batch array
const payloads = [
  { StellarChangeTrust: { /* Tx 1: setup USDC trustline           */ } },
  { EvmEip1559: { /* Tx 2: approve WETH for Morpho (nonce N)      */ } },
  { EvmEip1559: { /* Tx 3: supplyCollateral WETH   (nonce N+1)    */ } },
  { EvmEip1559: { /* Tx 4: borrow USDC             (nonce N+2)    */ } },
  { EvmEip1559: { /* Tx 5: bridge USDC via 1Click  (nonce N+3)    */ } },
  { StellarInvokeContract: { /* Tx 6: open_short on Untangled Loop */ } },
];

// 2. Submit batch — validates ALL policies, then signs first payload
//    Deposit = 6 * 0.25 NEAR = 1.5 NEAR (excess refundable)
const batchResult = await account.functionCall({
  contractId: MAINNET_CONTRACT_ID,
  methodName: "request_batch_signature",
  args: { payloads, derivation_index: 0, use_balance: false },
  gas: BigInt("300000000000000"),
  attachedDeposit: BigInt(payloads.length) * BigInt("250000000000000000000000"),
});
// Extract batch_id from the result
const batchId = parseBatchId(batchResult);

// 3. Crank remaining items (one sign_batch_next per remaining payload)
//    Each call signs the next pending item from the pre-paid deposit pool.
//    No additional deposit is needed — it was pre-paid in step 2.
for (let i = 1; i < payloads.length; i++) {
  await account.functionCall({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "sign_batch_next",
    args: { batch_id: batchId },
    gas: BigInt("300000000000000"),
  });
  // Optional: poll get_batch_status between cranks to check progress
}

// 4. Poll batch status until all items are completed
let status;
do {
  status = await account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_batch_status",
    args: { batch_id: batchId },
  });
  // status = { batch_id, total, completed, failed, pending, next_index }
  console.log(`Batch progress: ${status.completed}/${status.total} signed`);
  if (status.pending > 0) await sleep(3000);
} while (status.pending > 0);

// 5. Retrieve individual signatures from the batch
//    Each item has its own signature once completed
for (let i = 0; i < payloads.length; i++) {
  const item = await account.viewFunction({
    contractId: MAINNET_CONTRACT_ID,
    methodName: "get_batch_request",
    args: { batch_id: batchId },
  });
  // item.items[i].signature = { big_r, s, recovery_id }
}

// 6. Reconstruct + broadcast each signed tx to its respective chain
//    Stellar tx (1) → Horizon (trustline, broadcast first)
//    EVM txs (2-5) → Arbitrum RPC via ethers.js
//    Stellar tx (6) → Soroban RPC (wait for bridge USDC arrival first)

// 7. Refund unused deposit (if any items failed)
await account.functionCall({
  contractId: MAINNET_CONTRACT_ID,
  methodName: "refund_batch",
  args: { batch_id: batchId },
  gas: BigInt("30000000000000"),
});
```

---

## Step 3: Broadcast & Confirm

| Tx | Chain | Broadcast Target | Confirmation |
|----|-------|-------------------|--------------|
| Tx 1: change_trust USDC | Stellar | Horizon `submitTransaction` | Wait for ledger inclusion |
| Tx 2: approve WETH | Arbitrum | Arbitrum RPC via ethers.js | Wait 1 block confirmation |
| Tx 3: supplyCollateral | Arbitrum | Arbitrum RPC via ethers.js | Wait 1 block confirmation |
| Tx 4: borrow USDC | Arbitrum | Arbitrum RPC via ethers.js | Wait 1 block confirmation |
| Tx 5: bridge USDC | Arbitrum → Stellar | 1ClickAPI solver deposit | Poll Stellar for USDC arrival |
| Tx 6: open_short | Stellar | Soroban RPC `sendTransaction` | Poll `getTransaction` until SUCCESS |

**Broadcast order:**

1. **Tx 1 first** — the USDC trustline must exist on Stellar before the bridge (Tx 5) delivers USDC
2. **Tx 2 → Tx 3 → Tx 4 → Tx 5** — EVM transactions broadcast in nonce order on Arbitrum. They can be broadcast simultaneously since Arbitrum sequences by nonce, but each depends on the previous being mined.
3. **Tx 6 last** — `open_short` must wait until bridged USDC has arrived on Stellar. The script should poll the derived Stellar account's USDC balance before broadcasting.

---

## Open Questions / TBDs

All open questions have been resolved:

> **Resolved:** Stellar USDC asset ID for 1Click API: `nep245:v2_1.omni.hot.tg:1100_111bzQBB65GxAPAVoxqmMcgYo5oS3txhqs1Uh1cgahKQUeTUq1TJu` (7 decimals, classic issuer `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`, SAC `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75`).
>
> **Resolved:** 1Click API integration — base URL `https://1click.chaindefuser.com/v0`, endpoints: `POST /quote`, `POST /deposit/submit`, `GET /status`. USDC is transferred via ERC-20 `transfer()` to the `depositAddress` returned by the quote. Policy 4 (USDC transfer) must be registered.
>
> **Resolved:** `StellarInvokeContract` is fully supported by the asset-manager contract — confirmed in `src/types.rs`, `src/signing.rs`, and `src/policy.rs`.
>
> **Resolved:** Sequencing constraint — the bridge is asynchronous (1-5 minutes). The demo script polls `GET /status?depositAddress=...` until `SUCCESS` before broadcasting Tx 6 (`open_short`). See section 2C step 4 for the polling implementation.

---

## File Structure (Planned)

| File | Purpose |
|------|---------|
| `src/config-mainnet.ts` | Mainnet constants — Arbitrum RPC, Morpho address, token addresses, Stellar contracts, NEAR mainnet contract/MPC IDs |
| `src/near-mainnet.ts` | NEAR mainnet helpers — `getMainnetAccount()`, batch signing utilities |
| `src/demo-mainnet-leveraged-short.ts` | Main demo script — orchestrates the full flow (Steps 0–3) |
| `src/morpho.ts` | Morpho Blue helpers — `buildApproveCalldata()`, `buildSupplyCollateralCalldata()`, `buildBorrowCalldata()` |
| `src/bridge.ts` | 1ClickAPI bridge helpers — `getBridgeQuote()`, `buildBridgeTx()`, `pollBridgeCompletion()` |
| `src/stellar-invoke.ts` | Stellar invoke helpers — `buildOpenShortPayload()`, `fetchAquariusSwapRoute()` |
