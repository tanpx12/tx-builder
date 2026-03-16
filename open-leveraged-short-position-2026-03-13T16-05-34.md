# Open Leveraged Short Position

**Date:** 2026-03-13T16:05:34.391Z
**Duration:** 129s

## Addresses

| Chain | Address |
|-------|--------|
| EVM (Arbitrum) | `0x22458b64018A4B0ed91914F85A612d8831b4fec9` |
| Stellar | `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM` |

## Parameters

| Parameter | Value |
|-----------|-------|
| WETH supply | 0.0025 (~$5.32) |
| WETH price | ~$0.00 |
| LTV | 70% |
| Borrow USDC | 3.722423 |
| Bridge USDC | 3.722423 |
| Margin | 3.61075 USDC |
| Flash loan | 22.1027272 XLM |

## Transactions

| # | Step | Chain | Description | Hash | Status |
|---|------|-------|-------------|------|--------|
| 1 | Batch submit | NEAR | Submit 6 payloads (batch #13) | [8upMwXGXLBbW...](https://nearblocks.io/txns/8upMwXGXLBbWbsUy3kC8qLPdojY3BPmv37ecsMZ61Nuh) | ✅ success |
| 2 | Change trust | Stellar | USDC trustline (already exists) | — | ⏭️ skipped |
| 3 | EVM 1 | Arbitrum | Approve WETH → Morpho | [0xaa4c3c3442...](https://arbiscan.io/tx/0xaa4c3c3442f6c18777015fa56be62365db31db84d02de6181aa601bc9a57da0b) | ✅ success |
| 4 | EVM 2 | Arbitrum | Supply WETH collateral | [0xaf3e322a32...](https://arbiscan.io/tx/0xaf3e322a3202518137ba334219383b2e96af2f4e4b90d6f6c0fe1be4244ac9ee) | ✅ success |
| 5 | EVM 3 | Arbitrum | Borrow USDC | [0x01838b6ede...](https://arbiscan.io/tx/0x01838b6edeba56588c53af73be61425e8b88c40d4aa802a13494d37f3c86dd00) | ✅ success |
| 6 | EVM 4 | Arbitrum | USDC → bridge | [0x0124aea852...](https://arbiscan.io/tx/0x0124aea8527eea6464af001e877c1b29636779a0a709f2098fdf3ec52add9dd6) | ✅ success |
| 7 | Bridge | 1Click Bridge | USDC Arbitrum → Stellar (3.722423 USDC) | — | ✅ success |
| 8 | Approve USDC | Stellar | Approve 8.2237157 USDC for Blend pool | [cc8491621e51...](https://stellar.expert/explorer/public/tx/cc8491621e51856feba71b6a003ece30af57c4e0a1742dfb92947c1bb88932d3) | ✅ success |
| 9 | Open short | Stellar | Flash 22.1938707 XLM, margin 3.6256394 USDC | [3d729de6a4db...](https://stellar.expert/explorer/public/tx/3d729de6a4db30a5e99ea22b3810d6002a8e8661d0f8642bb06914778ecd97ee) | ✅ success |

## Details

### EVM 1 — Approve WETH → Morpho

Block 441409225

### EVM 2 — Supply WETH collateral

Block 441409242

### EVM 3 — Borrow USDC

Block 441409259

### EVM 4 — USDC → bridge

Block 441409276

