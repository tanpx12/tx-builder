# Mainnet Demo: Issues Log

All issues encountered during the mainnet demo script development, in chronological order across ~6 demo runs (batches 1–6).

---

## 1. NEAR RPC endpoint deprecated

- **Error:** `WARNING! THIS ENDPOINT IS DEPRECATED!` when connecting to `rpc.mainnet.near.org`
- **Fix:** Changed to `rpc.fastnear.com` in `config-mainnet.ts` and `derive-mainnet.ts`

## 2. TypeScript compilation errors

- **Error:** `balanceOf` possibly undefined, `TransactionBuilder.TIMEOUT_INFINITE` doesn't exist, `morpho.idToMarketParams` possibly undefined
- **Fix:** Added `!` non-null assertions, changed `TIMEOUT_INFINITE` to `0`

## 3. `get_total_batches` contract method not found

- **Error:** View function doesn't exist on the mainnet contract
- **Fix:** Replaced with probing `get_batch_status` with incrementing IDs (1, 2, 3…) until null is returned

## 4. BigInt serialization for i64 fields

- **Error:** `invalid type: string "9223372036854775807", expected i64` — Stellar sequence numbers and trustline limit exceed `Number.MAX_SAFE_INTEGER`
- **Fix:** Custom JSON serializer in `submitBatch()` using `__BIGINT__` placeholder pattern: stringify with tagged strings, then regex-replace to bare numbers

## 5. Stellar network enum name

- **Error:** `unknown variant "Mainnet", expected one of "Public", "Testnet", "Custom"`
- **Fix:** Changed `"Mainnet"` to `"Public"` in both Stellar payload definitions

## 6. SorobanScVal typed args for open_short

- **Error:** `unknown variant "GASYQY7...", expected one of "Bool", "Void", "U32"...` — passing raw Stellar address strings as Soroban args
- **Fix:** Pass `args: []` (empty) in batch payload since open_short is signed locally with Ed25519; the batch only validates policy (function_name + contract_id)

## 7. Stellar contract field format

- **Error:** Contract expected `{ contract_id: string }` object with hex, not a raw StrKey string
- **Fix:** Changed to `contract: { contract_id: Buffer.from(StrKey.decodeContract(...)).toString("hex") }`

## 8. Contract owner check

- **Error:** `Only a sub-account of ... can call this method` — the contract's `assert_subaccount()` rejected the implicit account (which is the owner itself, not a sub-account)
- **Fix:** Contract redeployed with `assert_owner_or_subaccount()` allowing the owner directly

## 9. Policies cleared after contract redeploy

- **Error:** `Transaction violates registered policy` — all 5 policies wiped by contract state reset
- **Fix:** Re-ran `npx tsx src/mainnet/set-policies.ts` to re-register all policies

## 10. Policy mask length mismatch

- **Error:** `Transaction violates registered policy` — `apply_mask_policy` returns false when `payload_bytes.len() != policy.mask.len()`
- **Root cause:** Mask lengths were set to minimal sizes (36 bytes for EVM, 32 for Stellar) but the contract computes `evm_policy_bytes` as `value(32) + full_calldata`, which is much longer for Morpho calls
- **Fix:** Updated mask lengths to match actual payload sizes:
  - approve: 100 bytes (32 + 4 selector + 64 args)
  - supplyCollateral: 324 bytes (32 + 292 calldata)
  - borrow: 324 bytes (32 + 292 calldata)
  - USDC transfer: 100 bytes (32 + 68 calldata)
  - open_short: 42 bytes (32 contract_id + 10 function_name)

## 11. Existing policy with wrong mask length silently skipped

- **Error:** `set-policies.ts` saw an existing policy and skipped it, but the existing policy had the old (wrong) mask length
- **Fix:** Added mask length comparison: if existing policy has different mask length, update it instead of skipping

## 12. `MAINNET_CONTRACT_ID` not imported in execute-batch.ts

- **Error:** `MAINNET_CONTRACT_ID is not defined` when polling batch status
- **Fix:** Added to the import list from `config-mainnet.js`

## 13. Async crank NEAR nonce collisions

- **Error:** Cranks sent via `sendTransactionAsync` with 2s/5s delays caused NEAR nonce conflicts; items never dispatched
- **Root cause:** `sendTransactionAsync` is fire-and-forget — the next crank fires before NEAR confirms the previous one, causing nonce reuse
- **Fix:** Changed `crankBatchNext()` to use synchronous `account.functionCall()` which waits for tx confirmation + MPC callback before returning

## 14. 11-minute gap before first crank (slow first-item wait)

- **Error:** Script waited for `completed >= 1` (MPC sign finish on item 0) before starting cranks. MPC signing took ~11 minutes.
- **Root cause:** `sign_batch_next` doesn't require previous items to be completed — it just dispatches the next item to MPC. Waiting for item 0's MPC completion was unnecessary.
- **Fix:** Changed to just wait for batch existence on-chain (tx inclusion), then immediately start cranking. Total crank time dropped from ~11 min to ~40s.

## 15. Invalid Morpho market ID

- **Error:** `supplyCollateral` reverted on Arbitrum — `MORPHO_MARKET_ID` returned zero oracle address from `idToMarketParams()`
- **Root cause:** The hardcoded market ID `0xb323495f...` doesn't exist on Arbitrum One
- **Fix:** Queried Morpho Blue GraphQL API (`blue-api.morpho.org/graphql`) for WETH/USDC markets on chain 42161. Found `0xca83d02be579485cc10945c9597a6141e772f1cf0e0aa28d09a327b6cbd8642c` (86% LLTV, ~$20k available liquidity). Verified via on-chain `idToMarketParams()` call.

## 16. USDC transfer out of gas

- **Error:** Native USDC `transfer()` reverted using 59,556 / 60,000 gas
- **Root cause:** Circle's FiatTokenV2 on Arbitrum includes blacklist checks, pausing logic, and proxy delegation that consume more gas than a vanilla ERC-20
- **Fix:** Increased gas limit from 60,000 to 100,000 for USDC transfer (both in batch payload and broadcast config)

## 17. QuickNode RPC rate limit on receipt polling

- **Error:** `10/second request limit reached` on `eth_getTransactionReceipt` after rapid sequential EVM broadcasts
- **Root cause:** 5 sequential broadcasts + receipt polls hit the free-tier 10 req/s limit
- **Fix:** Added retry loop with 3s backoff for rate-limited RPC calls in the broadcast step

---

## Summary

| # | Category | Issue | Severity |
|---|----------|-------|----------|
| 1 | Infra | NEAR RPC deprecated | Blocker |
| 2 | TypeScript | Compilation errors | Minor |
| 3 | Contract API | Missing view method | Blocker |
| 4 | Serialization | BigInt i64 overflow | Blocker |
| 5 | Contract API | Stellar network enum | Blocker |
| 6 | Contract API | Soroban arg types | Blocker |
| 7 | Contract API | Stellar contract field format | Blocker |
| 8 | Contract | Owner permission check | Blocker |
| 9 | Contract | Policies wiped on redeploy | Blocker |
| 10 | Contract | Policy mask length mismatch | Blocker |
| 11 | Script logic | Stale policy not updated | Medium |
| 12 | Script logic | Missing import | Blocker |
| 13 | NEAR runtime | Async nonce collisions | Blocker |
| 14 | Script logic | Unnecessary MPC wait | Performance |
| 15 | Config | Invalid Morpho market ID | Blocker |
| 16 | EVM gas | USDC gas underestimate | Blocker |
| 17 | Infra | RPC rate limiting | Medium |

**Final state:** Run 3 (Batch 6) completed Steps 0–8e successfully. The full NEAR batch signing → Morpho supply/borrow on Arbitrum → 1Click bridge flow works end-to-end on mainnet.
