// src/morpho.ts
// Morpho Blue calldata builders for Arbitrum One

import { ethers } from "ethers";
import { MORPHO_ADDRESS, MORPHO_MARKET_ID, WETH_ADDRESS, USDC_ADDRESS } from "./config.js";

// ── Morpho Blue ABI fragments ──

const MORPHO_ABI = [
  "function supplyCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, bytes data)",
  "function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver)",
  "function repay((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256 assetsRepaid, uint256 sharesRepaid)",
  "function withdrawCollateral((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, address onBehalf, address receiver)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint64 lastUpdate, uint16 fee)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
];

const morphoIface = new ethers.Interface(MORPHO_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);

// ── Market Parameters ──
// These must match the on-chain market identified by MORPHO_MARKET_ID.
// They are passed as a struct to supplyCollateral() and borrow().

export interface MarketParams {
  loanToken: string;
  collateralToken: string;
  oracle: string;
  irm: string;
  lltv: bigint;
}

/**
 * Fetch market parameters from the Morpho Blue contract.
 * Reads the `idToMarketParams` mapping on-chain.
 */
export async function fetchMarketParams(provider: ethers.JsonRpcProvider): Promise<MarketParams> {
  const morpho = new ethers.Contract(
    MORPHO_ADDRESS,
    ["function idToMarketParams(bytes32) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)"],
    provider,
  );
  const [loanToken, collateralToken, oracle, irm, lltv] = await morpho.idToMarketParams!(MORPHO_MARKET_ID);
  return { loanToken, collateralToken, oracle, irm, lltv };
}

// ── Calldata Builders ──

/** ERC-20 approve(MORPHO_ADDRESS, amount) on WETH */
export function buildApproveWethCalldata(amount: bigint): string {
  return erc20Iface.encodeFunctionData("approve", [MORPHO_ADDRESS, amount]);
}

/** Morpho supplyCollateral(marketParams, assets, onBehalf, "0x") */
export function buildSupplyCollateralCalldata(
  marketParams: MarketParams,
  assets: bigint,
  onBehalf: string,
): string {
  return morphoIface.encodeFunctionData("supplyCollateral", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    assets,
    onBehalf,
    "0x",
  ]);
}

/** Morpho borrow(marketParams, assets, shares=0, onBehalf, receiver) */
export function buildBorrowCalldata(
  marketParams: MarketParams,
  borrowAmount: bigint,
  onBehalf: string,
  receiver: string,
): string {
  return morphoIface.encodeFunctionData("borrow", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    borrowAmount,
    0n, // shares = 0, borrow by assets
    onBehalf,
    receiver,
  ]);
}

/** ERC-20 approve(MORPHO_ADDRESS, amount) on USDC (for repay) */
export function buildApproveUsdcCalldata(amount: bigint): string {
  return erc20Iface.encodeFunctionData("approve", [MORPHO_ADDRESS, amount]);
}

/** Morpho repay(marketParams, assets, shares=0, onBehalf, "0x") */
export function buildRepayCalldata(
  marketParams: MarketParams,
  repayAmount: bigint,
  onBehalf: string,
): string {
  return morphoIface.encodeFunctionData("repay", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    repayAmount,
    0n, // shares = 0, repay by assets
    onBehalf,
    "0x",
  ]);
}

/** Morpho repay by shares (for full repayment to avoid dust) */
export function buildRepayBySharesCalldata(
  marketParams: MarketParams,
  shares: bigint,
  onBehalf: string,
): string {
  return morphoIface.encodeFunctionData("repay", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    0n, // assets = 0, repay by shares
    shares,
    onBehalf,
    "0x",
  ]);
}

/** Morpho withdrawCollateral(marketParams, assets, onBehalf, receiver) */
export function buildWithdrawCollateralCalldata(
  marketParams: MarketParams,
  assets: bigint,
  onBehalf: string,
  receiver: string,
): string {
  return morphoIface.encodeFunctionData("withdrawCollateral", [
    [marketParams.loanToken, marketParams.collateralToken, marketParams.oracle, marketParams.irm, marketParams.lltv],
    assets,
    onBehalf,
    receiver,
  ]);
}

/** Query Morpho position: returns { supplyShares, borrowShares, collateral } */
export async function fetchPosition(
  provider: ethers.JsonRpcProvider,
  user: string,
): Promise<{ supplyShares: bigint; borrowShares: bigint; collateral: bigint }> {
  const morpho = new ethers.Contract(MORPHO_ADDRESS, MORPHO_ABI, provider);
  const [supplyShares, borrowShares, collateral] = await morpho.position!(MORPHO_MARKET_ID, user);
  return { supplyShares, borrowShares, collateral };
}

/** Query Morpho market state: returns totalBorrowAssets/Shares for computing actual debt */
export async function fetchMarketState(
  provider: ethers.JsonRpcProvider,
): Promise<{ totalBorrowAssets: bigint; totalBorrowShares: bigint }> {
  const morpho = new ethers.Contract(MORPHO_ADDRESS, MORPHO_ABI, provider);
  const [, , totalBorrowAssets, totalBorrowShares] = await morpho.market!(MORPHO_MARKET_ID);
  return { totalBorrowAssets, totalBorrowShares };
}

/** ERC-20 transfer(to, amount) on USDC */
export function buildUsdcTransferCalldata(to: string, amount: bigint): string {
  return erc20Iface.encodeFunctionData("transfer", [to, amount]);
}

// ── Selectors (for policy registration) ──

export const APPROVE_SELECTOR = [0x09, 0x5e, 0xa7, 0xb3]; // approve(address,uint256)
export const SUPPLY_COLLATERAL_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("supplyCollateral")!.selector),
);
export const BORROW_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("borrow")!.selector),
);
export const TRANSFER_SELECTOR = [0xa9, 0x05, 0x9c, 0xbb]; // transfer(address,uint256)
export const REPAY_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("repay")!.selector),
);
export const WITHDRAW_COLLATERAL_SELECTOR = Array.from(
  ethers.getBytes(morphoIface.getFunction("withdrawCollateral")!.selector),
);
