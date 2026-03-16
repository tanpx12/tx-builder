# tx-builder — Claude Code Context

## Project Overview

TypeScript script environment for the `asset-manager` NEAR contract (at `../asset-manager`). Provides address derivation, transaction building, MPC signing, and end-to-end demos for cross-chain operations via NEAR Chain Signatures.

- **Language:** TypeScript (ESM, `"type": "module"`)
- **Runtime:** Node.js via `tsx` (no compile step needed for scripts)
- **Contract (testnet):** `testnet-deployer.testnet` on NEAR testnet
- **Contract (mainnet):** `8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e` (implicit account)
- **MPC signer (testnet):** `v1.signer-prod.testnet`
- **MPC signer (mainnet):** `v1.signer`

---

## Module Structure

| File | Purpose |
|------|---------|
| `src/config.ts` | Constants — RPC endpoints, contract/MPC account IDs, derivation path builder, domain IDs, chain configs |
| `src/near.ts` | NEAR helpers — `getNearAccount()`, `fetchMpcPublicKey()`, `initContract()`, `requestSignature()` (direct MPC), `requestSignatureViaContract()` (legacy) |
| `src/derive.ts` | `deriveAllAddresses()` — derives ETH/BTC/Stellar addresses from MPC root key using NEAR chain-sig KDF |
| `src/eth.ts` | Build + sign Ethereum transactions |
| `src/btc.ts` | Build + sign Bitcoin transactions |
| `src/stellar.ts` | Build + sign Stellar transactions |
| `src/index.ts` | Main entry — `--init`, `--sign` flags; derive addresses + build/sign test txs for all chains |
| `src/demo-eth-transfer.ts` | E2E demo: build+set policy, then send 0.1 ETH via the asset-manager contract on Sepolia |
| `src/manage-policy.ts` | CLI tool for registering/viewing/removing bitwise mask policies on the contract |
| `src/test-payloads.ts` | Test payload construction utilities |

---

## Key Config Values

```ts
// ========== Testnet ==========
NEAR_ACCOUNT_ID = "testnet-deployer.testnet"   // contract + owner account
MPC_CONTRACT_ID = "v1.signer-prod.testnet"     // MPC signer
ETH_RPC         = "https://rpc.sepolia.org"    // Ethereum Sepolia
ETH_CHAIN_ID    = 11155111                      // Sepolia
BTC_NETWORK     = "testnet"
STELLAR_HORIZON = "https://horizon-testnet.stellar.org"

// ========== Mainnet ==========
MAINNET_CONTRACT_ID = "8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e"
MAINNET_MPC_CONTRACT_ID = "v1.signer"
MAINNET_RPC_URL = "https://rpc.mainnet.near.org"
// Default behavior: DenyAll — policies must be registered before signing

// Derivation path format (matches contract's build_derivation_path):
// "<contract_id>,<owner>,<chain>,<index>"
// e.g. "testnet-deployer.testnet,testnet-deployer.testnet,ethereum,0"
```

---

## Running Scripts

```bash
# Derive cross-chain addresses + build test transactions
npx tsx src/index.ts

# Derive + sign via MPC (requires KEY in .env)
npx tsx src/index.ts --sign

# Initialize contract (run once)
npx tsx src/index.ts --init

# E2E ETH transfer demo (includes policy setup before tx)
npx tsx src/demo-eth-transfer.ts
# or
npm run demo:eth-transfer

# Policy management CLI
npx tsx src/manage-policy.ts status
npx tsx src/manage-policy.ts set-evm <contract> <selector-hex> <mask-hex> <condition-hex>
npx tsx src/manage-policy.ts get-evm <contract> <selector-hex>
npx tsx src/manage-policy.ts example-erc20 <token-contract> [recipient]
```

`.env` file required for signing and write operations:
```
KEY="ed25519:<YOUR_NEAR_PRIVATE_KEY>"
```

---

## MPC Signing: Direct vs Via Contract

**Prefer `requestSignature()` (direct MPC)** — calls `v1.signer-prod.testnet` directly with full 300 Tgas budget.

**Avoid `requestSignatureViaContract()` (legacy)** — calls the asset-manager as intermediary; prone to "exceeded prepaid gas" errors because the contract consumes gas before forwarding to the MPC signer.

Both functions live in `src/near.ts`.

Signing deposit: `0.25 NEAR` (`250000000000000000000000` yoctoNEAR). Excess is refunded.

---

## Calling the Contract via `request_signature()`

When building scripts that propose transactions to the asset-manager:

```ts
await account.functionCall({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "request_signature",
  args: {
    payload: { EvmEip1559: { chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data } },
    // OR: payload: "<base64-encoded 32-byte hash>" for raw signing
    derivation_index: 0,
    use_balance: false,
  },
  gas: BigInt("300000000000000"),       // 300 Tgas
  attachedDeposit: BigInt("250000000000000000000000"),  // 0.25 NEAR
});
```

Supported `chain_type` values: `"Ethereum"` | `"Bitcoin"` | `"Stellar"`.

After submitting, poll `get_signature_request({ request_id })` until `status === "Completed"`.

### Batch signing via `request_batch_signature()`

```ts
// 1. Create batch (validates all policies, signs first item)
await account.functionCall({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "request_batch_signature",
  args: {
    payloads: [
      { EvmEip1559: { chain_id, nonce: 0, ... } },
      { EvmEip1559: { chain_id, nonce: 1, ... } },
    ],
    derivation_index: 0,
    use_balance: false,
  },
  gas: BigInt("300000000000000"),
  attachedDeposit: BigInt("500000000000000000000000"),  // N * 0.25 NEAR
});

// 2. Crank remaining items (one per NEAR tx, no deposit needed)
await account.functionCall({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "sign_batch_next",
  args: { batch_id: 1 },
  gas: BigInt("300000000000000"),
});

// 3. Poll batch status
const status = await account.viewFunction({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "get_batch_status",
  args: { batch_id: 1 },
});
// status = { batch_id, total, completed, failed, pending, next_index }

// 4. Refund unused deposit (owner only)
await account.functionCall({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "refund_batch",
  args: { batch_id: 1 },
  gas: BigInt("30000000000000"),
});
```

---

## Address Derivation (KDF)

The NEAR chain-signature KDF:
```
epsilon = sha256("near-mpc-recovery v0.1.0 epsilon derivation:<accountId>,<path>")
child_key = root_key + epsilon * G
```

Domain IDs (signature scheme):
- `0` = Secp256k1 (Ethereum, Bitcoin)
- `1` = Ed25519 (Stellar, Solana, Cosmos, NEAR)

---

## Policy Engine

The asset-manager contract has a bitwise mask policy engine that gates `request_signature()` calls. Before proposing a transaction, the relevant policy must be registered (or the default behavior must be `AllowAll`).

### Policy key structure

| Chain | `contract` field | `selector` field |
|-------|-----------------|-----------------|
| EVM | `to` address (lowercase, no 0x) | first 4 bytes of calldata, or `[]` for native transfers |
| Stellar payment | source account hex | `"payment"` as UTF-8 bytes |
| Stellar invoke | source account hex | function name as UTF-8 bytes |

### Policy bytes layout

**EVM** (32 + calldata.len() bytes):
- `[0..32]` — `tx.value` as big-endian uint256 (zero-padded)
- `[32..]` — raw calldata (`tx.data`)

Native ETH transfer (no calldata): 32 bytes only.
ERC-20 `transfer(address,uint256)`: 100 bytes (32 value + 4 selector + 12 pad + 20 addr + 32 amount).

### Validation rule

```
payload_bytes & mask == condition
```

Mask bytes set to `0xff` enforce the corresponding condition byte. Mask bytes set to `0x00` allow any value at that position.

### Demo flow (demo-eth-transfer.ts)

The E2E demo follows this order:
1. Derive ETH address
2. Fetch Sepolia chain state (nonce, gas, balance)
3. Connect to NEAR
4. **Register policy** — native ETH transfer to RECIPIENT, mask=all-zeros (allow any value)
5. **Verify policy** — view call to confirm registration
6. Propose EIP-1559 tx via `request_signature()`
7. Poll for MPC signature
8. Reconstruct signed tx
9. Broadcast to Sepolia

### manage-policy.ts commands

```bash
npx tsx src/manage-policy.ts status                         # show default behavior
npx tsx src/manage-policy.ts set-default <allow|deny>       # set global default
npx tsx src/manage-policy.ts set-evm <contract> <sel> <mask> <cond>
npx tsx src/manage-policy.ts get-evm <contract> <sel>
npx tsx src/manage-policy.ts remove-evm <contract> <sel>
npx tsx src/manage-policy.ts example-erc20 <token> [recipient]  # print + simulate ERC-20 policy
npx tsx src/manage-policy.ts simulate <payload> <mask> <cond>   # dry-run policy check
```

---

## Writing New Demo Scripts

1. Create scripts in `src/` (not elsewhere)
2. Use `near-api-js` — see `src/near.ts` for the `getNearAccount()` / `functionCall()` pattern
3. Import config from `./config.js` (use `.js` extension in ESM imports)
4. Run with `npx tsx src/your-script.ts`
5. Require `KEY` from `.env` for any signing operations

---

## Contract Reference (`../asset-manager`)

See `../asset-manager/CLAUDE.md` for the full contract context. Key points for script writers:

- Contract state and module layout in `src/` (Rust)
- `request_signature()` is the main entry point — detects chain type, builds payload hash, enforces policy, calls MPC
- `request_batch_signature(payloads, derivation_index, use_balance)` — batch signing: validates all policies upfront, requires `N * 0.25 NEAR` deposit, signs first item immediately
- `sign_batch_next(batch_id)` — crank: signs next pending batch item from pre-paid deposit pool (no additional deposit needed)
- `refund_batch(batch_id)` — owner reclaims unused deposit pool
- `get_batch_request(batch_id)` / `get_batch_status(batch_id)` — view batch state and completion counts
- Signature result shape: `{ big_r: { affine_point: string }, s: { scalar: string }, recovery_id: number }`
- `big_r.affine_point` has a compressed-key prefix byte (02/03) — strip first 2 chars to get `r`
- Recovery ID may need to be flipped (0 ↔ 1) if recovered signer doesn't match derived address
