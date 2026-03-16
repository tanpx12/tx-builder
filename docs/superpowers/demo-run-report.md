# Mainnet Demo Run Report

## Run 6 — Close Position Flow SUCCESS (full unwind)

**Date:** 2026-03-12
**Script:** `src/mainnet/execute-unwind.ts --submit`
**EVM Account:** `0x22458b64018A4B0ed91914F85A612d8831b4fec9`
**Stellar Account:** `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM`

### Steps Summary

| Step | Description | Status | Detail |
|------|-------------|--------|--------|
| 1 | Close short on Stellar | SKIPPED | Already closed in Run 5 |
| 1a | Withdraw residual Blend collateral | PASS | 0.509 USDC withdrawn via pool `submit(WITHDRAW_COLLATERAL)` |
| 1b | Swap XLM → USDC | PASS | 42.13 XLM → 6.73 USDC via `pathPaymentStrictSend` |
| 2 | Bridge USDC Stellar → Arbitrum | PASS | 6.73 USDC via 1Click (MEMO mode), memo `34153372` |
| 3a | Register missing policies | PASS | 4 new: USDC approve, repay, withdrawCollateral, close_short |
| 3b | NEAR batch sign (3 payloads) | PASS | Batch ID 10, 3/3 signed |
| 3c | Approve USDC for Morpho | PASS | nonce 15, block 441074508 |
| 3d | Repay USDC debt (by shares) | PASS | nonce 16, block 441074511 |
| 3e | Withdraw WETH collateral | PASS | nonce 17, block 441074514 |

### Result

| Metric | Before | After |
|--------|--------|-------|
| Stellar XLM | 44.14 | 2.0 |
| Stellar USDC | 0.001 | 0.001 |
| Blend USDC collateral | 0.509 | 0 |
| Morpho borrow shares | 3,386,211,702,211 | 0 |
| Morpho WETH collateral | 0.0024 | 0 |
| Arbitrum USDC | 0.0008 | 3.727 |
| Arbitrum WETH | 0 | 0.0025 |

**Position fully unwound.** All Stellar and Arbitrum positions closed.

### Key Fixes Applied

1. **`depositMode: "MEMO"`** — Stellar-origin 1Click quotes require MEMO mode; response includes `depositMemo` field
2. **Memo in Stellar payment** — `Memo.text(depositMemo)` must be attached to the USDC payment tx
3. **Status polling with memo** — `pollBridgeStatus(depositAddress, depositMemo)` adds `&depositMemo=` query param
4. **Blend residual collateral withdrawal** — Call pool `submit` with `WITHDRAW_COLLATERAL` request (request_type: 3)
5. **XLM→USDC swap** — Stellar classic `pathPaymentStrictSend` (auto-routed by Horizon, no Soroban needed)
6. **4 new NEAR policies** — `USDC.approve(Morpho)`, `Morpho.repay`, `Morpho.withdrawCollateral`, `Stellar.close_short`
7. **RPC rate limiting** — Sequential calls with `sleep(1000)` between Morpho queries to avoid QuickNode 10/s limit

### Transaction Hashes

| Chain | Operation | Hash |
|-------|-----------|------|
| Stellar | Blend withdraw collateral | `2ca01f46dec77d83430b33546ffc539a77beca2786e4ab45ffc16713c8cf9090` |
| Stellar | XLM→USDC swap | `75b86ede349715239832c021f29acb61935c814bc8b009dc950fb4004fec6d81` |
| Stellar | Bridge USDC payment | `5c824269143c0fb7cf57a9c8464d5632fd4db88e7a695b8f0076d31dd0c8c870` |
| NEAR | Batch submit (3 items) | `3DkpRKvoZWo5rj4NzVg25u6d1zhSLKzx7wVVdoH6RkAs` |
| Arbitrum | Approve USDC→Morpho | `0x5404529dbb8225f75500cc09ac11bd6aa792083eecdf75d919cf3bc9226e0f71` |
| Arbitrum | Repay USDC debt | `0x84a76ba25ed4e3fcacee3f2faa02abf2bd14e31739d846af4087a21f10fe9dcf` |
| Arbitrum | Withdraw WETH | `0x7c9782256fca289ed47ffaa0ef4b059f9aff23cb910d2165e2df36c993f7b5e6` |

---

## Run 5 — close_short SUCCESS (standalone)

**Date:** 2026-03-12
**Script:** `src/mainnet/close-short.ts --submit`
**Stellar Account:** `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM`

### Parameters (auto-calculated from on-chain position)

| Parameter | Value |
|-----------|-------|
| flash_amount | 5.5973557 USDC (full collateral) |
| repay_amount | 1.0089135 XLM (debt + 1% buffer) |
| withdraw_amount | 5.5973557 USDC (full collateral) |
| slippage | 1% |
| swap route | 3-hop via Aquarius (USDC → yUSDC → AQUA → XLM) |

### Steps Summary

| Step | Description | Status | Detail |
|------|-------------|--------|--------|
| 1 | Query Blend position | PASS | 0.999 XLM debt, 5.597 USDC collateral |
| 2 | Get Aquarius quote (USDC → XLM) | PASS | ~35.27 XLM estimated output |
| 3a | Approve Blend pool for XLM | PASS | LIKELY_SUCCESS (Bad union switch SDK bug) |
| 3b | Approve Blend pool for USDC | PASS | LIKELY_SUCCESS |
| 4 | Submit close_short on-chain | PASS | CHECK_ERROR (SDK bug) but tx succeeded |

### Result

| Metric | Before | After |
|--------|--------|-------|
| XLM balance | ~9.93 | 44.14 |
| USDC balance | 0.43 | 0.43 |
| XLM debt | 0.999 | 0 |
| USDC collateral | 5.597 | 0.509 (residual) |

**Position closed.** Excess XLM from the swap (~34.2 XLM) returned to user. Small residual USDC collateral (0.509) remains from rounding/interest.

### Key Details

1. **Two approve steps needed** — Blend pool uses `transfer_from` for both XLM (debt repayment) and USDC (flash loan repayment)
2. **"Bad union switch: 4"** — Stellar SDK parsing bug on all three tx status checks. Transactions succeeded despite CHECK_ERROR.
3. **3-hop swap route** — USDC → yUSDC → AQUA → XLM (Aquarius chose multi-hop for better rate)
4. **Position query** via Soroban `get_positions()` — returns scvMap with collateral/liabilities/supply, each containing Map<u32 reserve_index, i128 amount>

---

## Run 4 — open_short SUCCESS (standalone)

**Date:** 2026-03-12
**Script:** `src/mainnet/test-open-short.ts --submit --flash=1 --margin=6`
**Stellar Account:** `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM`

### Parameters

| Parameter | Value |
|-----------|-------|
| flash | 1 XLM (10,000,000 stroops) |
| margin | 6 USDC (60,000,000 stroops) |
| margin_from_quote | true |
| slippage | 1% |
| swap route | 2-hop via Aquarius API (XLM → intermediate → USDC) |

### Steps Summary

| Step | Description | Status | Detail |
|------|-------------|--------|--------|
| 1 | Get Aquarius quote (XLM → USDC) | PASS | ~0.15 USDC estimated output for 1 XLM |
| 2 | Approve Blend pool for USDC | PASS | Approved ~6.15 USDC + buffer |
| 3 | Simulate open_short | PASS | Soroban simulation OK |
| 4 | Submit open_short on-chain | PASS | Position opened |

### Result

| Metric | Before | After |
|--------|--------|-------|
| USDC balance | 6.43 | 0.43 |
| XLM balance | ~10.0 | ~9.93 |

**Position opened:** ~6.15 USDC collateral, 1 XLM debt (SHORT XLM)

### Key Fixes That Made This Work

1. **SwapHop encoding** — Soroban structs serialize as `scvMap` with alphabetically sorted symbol keys (`pool_index`, `token_out`, `tokens_in_pool`), NOT as `scvVec` tuples. The Aquarius API returns tuple format which must be decoded and re-encoded.
2. **Aquarius API URL** — Correct endpoint is `/pools/find-path/` (not `/api/external/v1/find-path/`)
3. **USDC approve** — Blend pool uses `transfer_from` for `supply_collateral`, so USDC approval is required before `open_short`
4. **Fee reduction** — Lowered max fee from 10 XLM to 2 XLM (actual fee ~0.073 XLM) to avoid `txInsufficientBalance`
5. **"Bad union switch" handling** — Stellar SDK parsing bug on tx result; added try/catch to treat as likely success

### Fixes Applied to execute-bridge-short.ts

The same fixes were backported to the full demo script (`src/mainnet/execute-bridge-short.ts`):
- Aquarius API URL fix
- SwapHop scvMap encoding (added `decodeSwapChainXdr`, `buildSwapHopScVal`, `buildSwapChainScVal`)
- USDC approve step before open_short
- Slippage reduced from 5% to 1%
- Fee bumped to 2 XLM
- "Bad union switch" error handling in tx polling

---

## Run 3 (Batch 6) — Steps 0-8e PASS

**Date:** 2026-03-12
**Batch ID:** 6
**NEAR Tx:** `H1K93vFRJ3zPVasBbPNamYBsgToiWCaK68EgSxMoRwMi`
**Params:** `--weth-amount=0.0004 --borrow-usdc=0.5`

### Steps Summary

| Step | Description | Status | Detail |
|------|-------------|--------|--------|
| 0 | Derive addresses | PASS | <1s |
| 1 | Fetch chain state | PASS | ~2s |
| 2 | Get bridge quote from 1Click API | PASS | ~1s |
| 3 | Build 6 transaction payloads | PASS | ~1s |
| 4 | Submit batch to NEAR | PASS | ~3s |
| 5 | Crank remaining 5 items | PASS | ~40s |
| 6 | Poll batch status (6/6 completed) | PASS | <1s |
| 7 | Retrieve 6 signatures | PASS | ~1s |
| 8a | Stellar change_trust USDC | PASS | ledger 61617800 |
| 8b | Approve WETH -> Morpho (nonce 8) | PASS | block 441010307 |
| 8c | Supply collateral WETH (nonce 9) | PASS | block 441010310 |
| 8d | Borrow USDC (nonce 10) | PASS | block 441010313 |
| 8e | Bridge USDC transfer (nonce 11) | PASS | block 441010316 |
| 8f | Open short on Untangled Loop | NOT RUN | Script crashed before reaching 8f (fixed in Run 4 standalone) |

### Notes

- Steps 0-8e all passed — the full EVM + Stellar trustline flow is working end-to-end.
- Script crashed after Tx 5 broadcast due to QuickNode RPC rate limit (10 req/s) on `eth_getTransactionReceipt`. The tx itself confirmed successfully.
- **Fix:** Added retry loop with 3s backoff for rate-limited receipt polling.
- Step 8f (open_short) was not reached due to the crash. The SwapHop encoding and Aquarius API fixes were validated separately in Run 4 and backported to `execute-bridge-short.ts`.

---

## Run 2 (Batch 4)

**Date:** 2026-03-12
**Batch ID:** 4
**NEAR Tx:** `E7g6Te2hA8RkoCZ2ZZTcwTn3zKANSFCjFYu6vf7Fjv4V`

### Steps Summary

| Step | Description | Status | Duration |
|------|-------------|--------|----------|
| 0 | Derive addresses | PASS | <1s |
| 1 | Fetch chain state (Arb nonce, gas, balances; Stellar sequence) | PASS | ~2s |
| 2 | Get bridge quote from 1Click API | PASS | ~1s |
| 3 | Build 6 transaction payloads | PASS | ~1s |
| 4 | Submit batch to NEAR (`request_batch_signature`) | PASS | ~3s |
| 5 | Crank remaining 5 items (`sign_batch_next` x5) | PASS | ~40s |
| 6 | Poll batch status (6/6 completed) | PASS | <1s |
| 7 | Retrieve 6 signatures | PASS | ~1s |
| 8a | Broadcast Tx 1: Stellar change_trust USDC | PASS | ledger 61617747 |
| 8b | Broadcast Tx 2: Approve WETH -> Morpho (nonce 2) | PASS | block 441009095 |
| 8c | Broadcast Tx 3: Supply collateral WETH (nonce 3) | PASS | block 441009115 |
| 8d | Broadcast Tx 4: Borrow USDC (nonce 4) | PASS | block 441009118 |
| 8e | Broadcast Tx 5: Bridge USDC (nonce 5) | **FAIL** | block 441009138 |
| 8f | Broadcast Tx 6: Open short | SKIPPED | - |

### Failure Details

#### Step 8e: USDC transfer reverted (out of gas)

**EVM Tx Hash:** `0xc06707952e2cea14cb4c7a4b6f8eb04ced7bbb8602b3b9ffb302fef3aadabefc`

**Error:** `transaction execution reverted` (CALL_EXCEPTION)

**Root Cause:** Gas limit set to 60,000 for the USDC `transfer()` call, but native USDC on Arbitrum (`0xaf88d065...`, Circle FiatTokenV2) includes blacklist checks that consume more gas than a standard ERC-20. The tx used 59,556 / 60,000 gas and ran out.

**Fix:** Increased gas limit from 60,000 to 100,000 for USDC transfer (both in batch payload and broadcast config).

---

## Run 1 (Batch 3)

**Date:** 2026-03-12
**Batch ID:** 3
**NEAR Tx:** `HsYB9hczppapumFsbDThHJzZaQ5Xjw4gQukB177TKGVo`

### Steps Summary

| Step | Description | Status | Duration |
|------|-------------|--------|----------|
| 0 | Derive addresses | PASS | <1s |
| 1 | Fetch chain state (Arb nonce, gas, balances; Stellar sequence) | PASS | ~2s |
| 2 | Get bridge quote from 1Click API | PASS | ~1s |
| 3 | Build 6 transaction payloads | PASS | ~1s |
| 4 | Submit batch to NEAR (`request_batch_signature`) | PASS | ~3s |
| 5 | Crank remaining 5 items (`sign_batch_next` x5) | PASS | ~40s |
| 6 | Poll batch status (6/6 completed) | PASS | ~5s |
| 7 | Retrieve 6 signatures | PASS | ~1s |
| 8a | Broadcast Tx 1: Stellar change_trust USDC | PASS | ledger 61617525 |
| 8b | Broadcast Tx 2: Approve WETH -> Morpho (nonce 0) | PASS | block 441004028 |
| 8c | Broadcast Tx 3: Supply collateral WETH (nonce 1) | **FAIL** | block 441004031 |
| 8d-f | Remaining broadcasts | SKIPPED | - |

### Failure Details

#### Step 8c: supplyCollateral reverted on Arbitrum

**EVM Tx Hash:** `0x1534a6013ad5e87709bebfeb90894298203b1c683182a9aa6156371c3aa17c61`

**Error:** `transaction execution reverted` (CALL_EXCEPTION)

**Root Cause:** The `MORPHO_MARKET_ID` in `config-mainnet.ts` was invalid — `idToMarketParams()` returned zero addresses. Market did not exist on Arbitrum One.

**Fix:** Updated `MORPHO_MARKET_ID` to `0xca83d02be579485cc10945c9597a6141e772f1cf0e0aa28d09a327b6cbd8642c` (a real WETH/USDC market on Arbitrum with 86% LLTV, active liquidity).

---

## Issues Fixed During Development

These issues were encountered and fixed across multiple iterations:

### 1. NEAR RPC endpoint deprecated
- **Error:** `WARNING! THIS ENDPOINT IS DEPRECATED!`
- **Fix:** Changed `rpc.mainnet.near.org` to `rpc.fastnear.com`

### 2. BigInt serialization for i64 fields
- **Error:** `invalid type: string "9223372036854775807", expected i64`
- **Fix:** Custom JSON serializer in `submitBatch()` that replaces BigInt placeholders with bare numbers

### 3. Stellar network enum name
- **Error:** `unknown variant "Mainnet", expected one of "Public", "Testnet", "Custom"`
- **Fix:** Changed `"Mainnet"` to `"Public"` in Stellar payloads

### 4. SorobanScVal typed args for open_short
- **Error:** `unknown variant "GASYQY7...", expected one of "Bool", "Void", "U32"...`
- **Fix:** Pass `args: []` (empty) in batch payload since open_short is signed locally; batch only validates policy (function_name + contract_id)

### 5. Contract owner check
- **Error:** `Only a sub-account of ... can call this method`
- **Fix:** Contract redeployed with `assert_owner_or_subaccount()` allowing the owner directly

### 6. Policy mask length mismatch
- **Error:** `Transaction violates registered policy` (apply_mask_policy returns false on length mismatch)
- **Fix:** Policy mask/condition must be exactly `32 + calldata.len()` bytes:
  - supplyCollateral: 36 -> 324 bytes
  - borrow: 36 -> 324 bytes
  - open_short: 32 -> 42 bytes

### 7. Async crank nonce collisions
- **Error:** Cranks sent via `sendTransactionAsync` with small delays caused NEAR nonce conflicts; items never dispatched
- **Fix:** Changed `crankBatchNext()` to use synchronous `account.functionCall()` which waits for tx confirmation + MPC callback

### 8. Slow first-item wait
- **Error:** 11-minute gap between `request_batch_signature` and first `sign_batch_next`
- **Fix:** Don't wait for `completed >= 1` (MPC sign finish); just wait for batch to exist, then immediately start cranking

### 9. Invalid Morpho market ID
- **Error:** `supplyCollateral` reverted because `MORPHO_MARKET_ID` returned zero oracle address
- **Fix:** Found correct WETH/USDC market via Morpho Blue GraphQL API: `0xca83d02be...`

### 10. USDC transfer out of gas
- **Error:** Native USDC (FiatTokenV2) transfer used 59,556 / 60,000 gas limit
- **Fix:** Increased gas limit from 60,000 to 100,000 for USDC transfer

### 11. QuickNode RPC rate limit on receipt polling
- **Error:** `10/second request limit reached` on `eth_getTransactionReceipt` after rapid sequential broadcasts
- **Fix:** Added retry loop with 3s backoff for rate-limited RPC calls in the broadcast step
