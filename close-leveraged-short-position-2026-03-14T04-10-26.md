# Close Leveraged Short Position

**Date:** 2026-03-14T04:10:26.970Z
**Duration:** 129s

## Addresses

| Chain | Address |
|-------|--------|
| EVM (Arbitrum) | `0x22458b64018A4B0ed91914F85A612d8831b4fec9` |
| Stellar | `GASYQY7YNO3TLIO7XRCWX6MFBZWYPRB3OTMSMQ3VNBKVS37NUMEKXGTM` |

## Transactions

| # | Step | Chain | Description | Hash | Status |
|---|------|-------|-------------|------|--------|
| 1 | Approve XLM | Stellar | Approve XLM for Blend pool | [5b310408dcd3...](https://stellar.expert/explorer/public/tx/5b310408dcd333d5608d5c574380101b8e83650dbe2e20d03d1c3af0de76a329) | ✅ success |
| 2 | Approve USDC | Stellar | Approve USDC for Blend pool | [fdc18c3408a6...](https://stellar.expert/explorer/public/tx/fdc18c3408a6a45cd05c6bf925fff15edb0e0e3063c3754644114c74fbdbed4f) | ✅ success |
| 3 | Close short | Stellar | Flash 7.0547645 USDC, repay 22.1699288 XLM debt | [03b1c8a353f8...](https://stellar.expert/explorer/public/tx/03b1c8a353f8c65dcf48eaca08cc5fe536902b7daceb9f9356b563b0fd3469c3) | ✅ success |
| 4 | Swap XLM→USDC | Stellar | Swap 20.4910368 XLM → USDC | [d77be3900c4d...](https://stellar.expert/explorer/public/tx/d77be3900c4d824ab0fcde128b8c322b039c82ba796c88d8e3227d975be53361) | ✅ success |
| 5 | Bridge payment | Stellar | Send 3.4936089 USDC to bridge | [ded9d010cb4e...](https://stellar.expert/explorer/public/tx/ded9d010cb4e32d1d14ff0b567d781484dbc0bff7f594a515ce95fd734557ff8) | ✅ success |
| 6 | Bridge | 1Click Bridge | USDC Stellar → Arbitrum (3.4936089 USDC) | — | ✅ success |
| 7 | Batch submit | NEAR | Submit 3 EVM payloads (batch #14) | [3xK4EMBQ6sU1...](https://nearblocks.io/txns/3xK4EMBQ6sU1KpmCmcPy865x8qWdX3fkSSuFKrQ48msG) | ✅ success |
| 8 | EVM 1 | Arbitrum | Approve USDC | [0x6827244c91...](https://arbiscan.io/tx/0x6827244c91b7d35762436c50465836c8b2c7261b890b2241caa6101c52de1be5) | ✅ success |
| 9 | EVM 2 | Arbitrum | Repay USDC debt | [0xbee5bd9811...](https://arbiscan.io/tx/0xbee5bd9811671e1402ab9b873752b7707aff5b921120b318b3ba25bf7961bc67) | ✅ success |
| 10 | EVM 3 | Arbitrum | Withdraw WETH | [0x05af8986e5...](https://arbiscan.io/tx/0x05af8986e50c522f70cacb886d7cd485bb9d668b17bc3b475cbbf2d74e0a0ad5) | ✅ success |

## Details

### Bridge — USDC Stellar → Arbitrum (3.4936089 USDC)

SUCCESS

### EVM 1 — Approve USDC

Block 441582648

### EVM 2 — Repay USDC debt

Block 441582652

### EVM 3 — Withdraw WETH

Block 441582655

