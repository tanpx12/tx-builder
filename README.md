# tx-builder

TypeScript script environment for the [`asset-manager`](../asset-manager) NEAR contract. Provides address derivation, transaction building, MPC signing, and end-to-end demos for cross-chain operations via [NEAR Chain Signatures](https://docs.near.org/concepts/abstraction/chain-signatures).

---

## Overview

The `asset-manager` contract is deployed on NEAR and uses Chain Signatures to authorize and sign transactions on other chains (Ethereum, Bitcoin, Stellar). This repo contains the off-chain tooling to:

- Derive cross-chain addresses from the MPC root key
- Build and sign transactions for EVM, Bitcoin, and Stellar
- Register and manage bitwise mask policies on the contract
- Run end-to-end demos (e.g. ETH transfer via MPC)

---

## Contracts

| Network  | Contract ID                                                              |
|----------|--------------------------------------------------------------------------|
| Testnet  | `testnet-deployer.testnet`                                               |
| Mainnet  | `8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e`       |

| Network  | MPC Signer               |
|----------|--------------------------|
| Testnet  | `v1.signer-prod.testnet` |
| Mainnet  | `v1.signer`              |

---

## Module Structure

| File                         | Purpose                                                                                                    |
|------------------------------|------------------------------------------------------------------------------------------------------------|
| `src/config.ts` | Constants — RPC endpoints, contract/MPC account IDs, derivation path builder, domain IDs, chain configs |
| `src/near.ts` | NEAR helpers — `getNearAccount()`, `fetchMpcPublicKey()`, `initContract()`, `requestSignature()` |
| `src/derive.ts` | `deriveAllAddresses()` — derives ETH/BTC/Stellar addresses from MPC root key |
| `src/eth.ts` | Build + sign Ethereum transactions |
| `src/btc.ts` | Build + sign Bitcoin transactions |
| `src/stellar.ts` | Build + sign Stellar transactions |
| `src/index.ts` | Main entry — `--init`, `--sign` flags |
| `src/demo-eth-transfer.ts` | E2E demo: register policy, then send ETH via the contract on Sepolia |
| `src/manage-policy.ts` | CLI for registering/viewing/removing bitwise mask policies |
| `src/test-payloads.ts` | Test payload construction utilities |

---

## Setup

**Prerequisites:** Node.js, `npm`

```bash
npm install
```

Create a `.env` file for signing and write operations:

```env
KEY="ed25519:<YOUR_NEAR_PRIVATE_KEY>"
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

# E2E ETH transfer demo
npx tsx src/demo-eth-transfer.ts
# or
npm run demo:eth-transfer

# Policy management CLI
npx tsx src/manage-policy.ts status
npx tsx src/manage-policy.ts set-evm <contract> <selector-hex> <mask-hex> <condition-hex>
npx tsx src/manage-policy.ts get-evm <contract> <selector-hex>
npx tsx src/manage-policy.ts example-erc20 <token-contract> [recipient]
```

---

## MPC Signing

Scripts call `requestSignature()` in `src/near.ts`, which calls the MPC signer directly with the full 300 Tgas budget. Each signing operation requires a `0.25 NEAR` deposit (excess is refunded).

```ts
await account.functionCall({
  contractId: NEAR_ACCOUNT_ID,
  methodName: "request_signature",
  args: {
    payload: { EvmEip1559: { chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, to, value, data } },
    derivation_index: 0,
    use_balance: false,
  },
  gas: BigInt("300000000000000"),
  attachedDeposit: BigInt("250000000000000000000000"),
});
```

For batch signing, use `request_batch_signature()` followed by `sign_batch_next()` calls. See [CLAUDE.md](./CLAUDE.md) for details.

---

## Policy Engine

The contract gates `request_signature()` calls with a bitwise mask policy engine. Before proposing a transaction, the relevant policy must be registered.

Validation rule:

```text
payload_bytes & mask == condition
```

### Policy management

```bash
npx tsx src/manage-policy.ts status                          # show default behavior
npx tsx src/manage-policy.ts set-default <allow|deny>        # set global default
npx tsx src/manage-policy.ts set-evm <contract> <sel> <mask> <cond>
npx tsx src/manage-policy.ts get-evm <contract> <sel>
npx tsx src/manage-policy.ts remove-evm <contract> <sel>
npx tsx src/manage-policy.ts example-erc20 <token> [recipient]
npx tsx src/manage-policy.ts simulate <payload> <mask> <cond>
```

---

## Address Derivation

Addresses are derived from the MPC root key using the NEAR chain-signature KDF:

```text
epsilon = sha256("near-mpc-recovery v0.1.0 epsilon derivation:<accountId>,<path>")
child_key = root_key + epsilon * G
```

Derivation path format: `"<contract_id>,<owner>,<chain>,<index>"`

Domain IDs: `0` = Secp256k1 (Ethereum, Bitcoin), `1` = Ed25519 (Stellar, Solana, NEAR)

---

## Writing New Scripts

1. Create scripts in `src/`
2. Use `near-api-js` — see `src/near.ts` for the `getNearAccount()` pattern
3. Import config from `./config.js` (use `.js` extension for ESM imports)
4. Run with `npx tsx src/your-script.ts`

---

## Contract Reference

See [`../asset-manager/CLAUDE.md`](../asset-manager/CLAUDE.md) for the full contract context and Rust source layout.
