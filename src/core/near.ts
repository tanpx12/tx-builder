// ──────────────────────────────────────────────
// NEAR helpers – connect, fetch MPC public key, call request_signature
// ──────────────────────────────────────────────

import { connect, keyStores, KeyPair } from "near-api-js";
import type { ConnectConfig } from "near-api-js";
import { NEAR_RPC, NEAR_ACCOUNT_ID, MPC_CONTRACT_ID, DOMAIN_IDS } from "./config.js";

/**
 * Create a NEAR connection and account object.
 * For read-only calls (deriving address) no key is needed.
 * For signing calls a NEAR key must be provided.
 */
export async function getNearAccount(privateKey?: string) {
  const keyStore = new keyStores.InMemoryKeyStore();

  if (privateKey) {
    const keyPair = KeyPair.fromString(privateKey);
    await keyStore.setKey("testnet", NEAR_ACCOUNT_ID, keyPair);
  }

  const near = await connect({
    networkId: "testnet",
    nodeUrl: NEAR_RPC,
    keyStore,
  } as ConnectConfig);

  return near.account(NEAR_ACCOUNT_ID);
}

/**
 * Fetch the MPC root public key from the signer contract (view call).
 * Returns the raw string from the MPC contract (e.g. "secp256k1:BASE58_ENCODED_KEY").
 */
export async function fetchMpcPublicKey(): Promise<string> {
  const account = await getNearAccount();
  const result: any = await account.viewFunction({
    contractId: MPC_CONTRACT_ID,
    methodName: "public_key",
    args: {},
  });
  return result;
}

/**
 * Initialize the asset-manager contract by calling its `new` method.
 * This must be called once before any other method.
 * The caller (NEAR_ACCOUNT_ID) becomes the contract owner.
 */
export async function initContract(nearPrivateKey: string) {
  const account = await getNearAccount(nearPrivateKey);

  const result = await account.functionCall({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "new",
    args: {
      mpc_signer: MPC_CONTRACT_ID,
    },
    gas: BigInt("300000000000000"),
    attachedDeposit: BigInt("0"),
  });

  return result;
}

/**
 * Supported chain types matching the contract's ChainType enum.
 */
export type ChainType = "Ethereum" | "Bitcoin" | "Stellar";

/**
 * Map chain type to the derivation path prefix used by the asset-manager.
 */
const CHAIN_PATH_PREFIX: Record<ChainType, string> = {
  Ethereum: "ethereum",
  Bitcoin: "bitcoin",
  Stellar: "stellar",
};

/**
 * Map chain type to the MPC key_version (domain_id).
 *   0 = Secp256k1 (Ethereum, Bitcoin)
 *   1 = Ed25519   (Stellar)
 */
const CHAIN_KEY_VERSION: Record<ChainType, number> = {
  Ethereum: DOMAIN_IDS.ethereum,
  Bitcoin: DOMAIN_IDS.bitcoin,
  Stellar: DOMAIN_IDS.stellar,
};

/**
 * Request a chain signature by calling the MPC signer contract DIRECTLY.
 *
 * This bypasses the asset-manager intermediary contract, giving the full
 * 300 Tgas budget to the MPC signer and avoiding the "exceeded prepaid gas"
 * error that occurs with the two-hop cross-contract call.
 *
 * `payload` is the 32-byte hash to sign (as number array).
 * `chainType` is the chain enum variant.
 * `derivationIndex` defaults to 0.
 *
 * For Ethereum/Bitcoin: key_version=0 (secp256k1), returns { big_r, s, recovery_id }.
 * For Stellar: key_version=1 (Ed25519), returns { big_r, s, recovery_id } where
 *   big_r contains the 32-byte R and s contains the 32-byte S of the Ed25519 signature.
 */
export async function requestSignature(
  payload: number[],
  chainType: ChainType,
  nearPrivateKey: string,
  derivationIndex: number = 0
) {
  const account = await getNearAccount(nearPrivateKey);

  // Build the same derivation path the asset-manager contract would use:
  //   "<contract_id>,<owner>,<chain>,<index>"
  const chainPrefix = CHAIN_PATH_PREFIX[chainType];
  const path = `${NEAR_ACCOUNT_ID},${NEAR_ACCOUNT_ID},${chainPrefix},${derivationIndex}`;

  // Select key_version based on chain type
  const keyVersion = CHAIN_KEY_VERSION[chainType];

  // Deposit 0.25 NEAR — the MPC signer requires a meaningful deposit.
  // Excess is refunded.
  const SIGN_DEPOSIT = BigInt("250000000000000000000000"); // 0.25 NEAR

  const result = await account.functionCall({
    contractId: MPC_CONTRACT_ID,
    methodName: "sign",
    args: {
      request: {
        payload,
        path,
        key_version: keyVersion,
      },
    },
    gas: BigInt("300000000000000"), // 300 Tgas — all for the MPC signer
    attachedDeposit: SIGN_DEPOSIT,
  });

  // Parse the result
  const successValue = (result.status as any).SuccessValue;
  if (!successValue) {
    throw new Error("Signature request failed: " + JSON.stringify(result.status));
  }
  const decoded = JSON.parse(Buffer.from(successValue, "base64").toString());
  return decoded;
}

/**
 * (Legacy) Request a chain signature via the asset-manager intermediary.
 * Kept for reference — this route is prone to "exceeded prepaid gas"
 * because the intermediary consumes gas before forwarding to the MPC signer.
 */
export async function requestSignatureViaContract(
  payload: number[],
  chainType: ChainType,
  nearPrivateKey: string,
  derivationIndex: number = 0
) {
  const account = await getNearAccount(nearPrivateKey);
  const payloadBase64 = Buffer.from(payload).toString("base64");
  const SIGN_DEPOSIT = BigInt("250000000000000000000000");

  const result = await account.functionCall({
    contractId: NEAR_ACCOUNT_ID,
    methodName: "request_signature",
    args: {
      payload: payloadBase64,
      chain_type: chainType,
      derivation_index: derivationIndex,
    },
    gas: BigInt("300000000000000"),
    attachedDeposit: SIGN_DEPOSIT,
  });

  const successValue = (result.status as any).SuccessValue;
  if (!successValue) {
    throw new Error("Signature request failed: " + JSON.stringify(result.status));
  }
  return JSON.parse(Buffer.from(successValue, "base64").toString());
}
