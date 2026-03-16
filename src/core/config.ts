// ──────────────────────────────────────────────
// Configuration
// ──────────────────────────────────────────────

/** NEAR testnet RPC endpoint */
export const NEAR_RPC = "https://test.rpc.fastnear.com";

/** The NEAR account that deployed the asset-manager contract */
export const NEAR_ACCOUNT_ID = "testnet-deployer.testnet";

/** The MPC signer contract on NEAR testnet */
export const MPC_CONTRACT_ID = "v1.signer-prod.testnet";

/**
 * Build the derivation path that matches the asset-manager contract's
 * `build_derivation_path` function:
 *   format!("{},{},{},{}", env::current_account_id(), owner, chain_prefix, index)
 *
 * Since the contract is deployed at NEAR_ACCOUNT_ID and the owner is also
 * NEAR_ACCOUNT_ID, the path becomes:
 *   "testnet-deployer.testnet,testnet-deployer.testnet,<chain>,<index>"
 */
function buildDerivationPath(chain: string, index: number = 0): string {
  return `${NEAR_ACCOUNT_ID},${NEAR_ACCOUNT_ID},${chain},${index}`;
}

export const DERIVATION_PATHS = {
  ethereum: buildDerivationPath("ethereum", 0),
  bitcoin: buildDerivationPath("bitcoin", 0),
  stellar: buildDerivationPath("stellar", 0),
};

/**
 * Domain IDs (signature schemes) matching the contract's ChainType::default_domain_id():
 *   0 = Secp256k1 (Ethereum, Bitcoin)
 *   1 = Ed25519   (Stellar, Solana, Cosmos, NEAR)
 */
export const DOMAIN_IDS = {
  ethereum: 0,
  bitcoin: 0,
  stellar: 1,
};

/** Ethereum Sepolia testnet */
export const ETH_RPC = "https://sepolia.drpc.org";
export const ETH_CHAIN_ID = 11155111; // Sepolia

/** Bitcoin testnet3 */
export const BTC_NETWORK = "testnet";

/** Stellar testnet */
export const STELLAR_HORIZON = "https://horizon-testnet.stellar.org";
export const STELLAR_NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";
