// src/config-mainnet.ts
// Mainnet constants for the cross-chain leveraged short demo

// ── NEAR Mainnet ──
export const MAINNET_CONTRACT_ID = "8fa7217570eb2766d2328a819098acf5e7a116c2d4d5c4d7823fccd83ec0556e";
export const MAINNET_MPC_CONTRACT_ID = "v1.signer";
export const MAINNET_RPC_URL = "https://rpc.fastnear.com";

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
export const MORPHO_MARKET_ID = "0xca83d02be579485cc10945c9597a6141e772f1cf0e0aa28d09a327b6cbd8642c";

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

// ── Reverse Bridge: Stellar USDC → Arbitrum USDC ──
export const ONECLICK_REVERSE_ORIGIN_ASSET = ONECLICK_DEST_ASSET; // Stellar USDC
export const ONECLICK_REVERSE_DEST_ASSET = ONECLICK_ORIGIN_ASSET; // Arbitrum USDC

// ── Aquarius AMM API ──
export const AQUARIUS_API_URL = "https://amm-api.aqua.network/pools/find-path/";
