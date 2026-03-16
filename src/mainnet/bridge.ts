// src/bridge.ts
// 1Click API bridge helpers — Arbitrum USDC → Stellar USDC

import {
  ONECLICK_BASE_URL,
  ONECLICK_ORIGIN_ASSET,
  ONECLICK_DEST_ASSET,
  ONECLICK_REVERSE_ORIGIN_ASSET,
  ONECLICK_REVERSE_DEST_ASSET,
} from "./config.js";

export interface BridgeQuote {
  quoteId: string;
  depositAddress: string;
  destinationAmount: string;
  expiresAt: string;
  memo?: string;
}

/**
 * Request a bridge quote from the 1Click API.
 *
 * @param amount USDC amount in smallest unit (6 decimals)
 * @param recipient Stellar G... StrKey address
 * @param refundTo EVM address for refunds
 * @param jwt Optional JWT for authenticated (fee-free) requests
 */
export async function getBridgeQuote(
  amount: string,
  recipient: string,
  refundTo: string,
  jwt?: string,
): Promise<BridgeQuote> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(`${ONECLICK_BASE_URL}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100, // 1%
      originAsset: ONECLICK_ORIGIN_ASSET,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: ONECLICK_DEST_ASSET,
      amount,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`1Click quote failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    quoteId: data.quoteId ?? data.quote?.quoteId,
    depositAddress: data.depositAddress ?? data.quote?.depositAddress,
    destinationAmount: data.destinationAmount ?? data.quote?.destinationAmount,
    expiresAt: data.expiresAt ?? data.quote?.expiresAt,
  };
}

/**
 * Request a reverse bridge quote: Stellar USDC → Arbitrum USDC.
 *
 * @param amount USDC amount in Stellar stroops (7 decimals)
 * @param recipient EVM address on Arbitrum (0x...)
 * @param refundTo Stellar G... address for refunds
 * @param jwt Optional JWT for authenticated requests
 */
export async function getBridgeQuoteReverse(
  amount: string,
  recipient: string,
  refundTo: string,
  jwt?: string,
): Promise<BridgeQuote> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (jwt) headers["Authorization"] = `Bearer ${jwt}`;

  const res = await fetch(`${ONECLICK_BASE_URL}/quote`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100, // 1%
      originAsset: ONECLICK_REVERSE_ORIGIN_ASSET, // Stellar USDC
      depositType: "ORIGIN_CHAIN",
      depositMode: "MEMO", // Stellar requires MEMO-based deposits
      destinationAsset: ONECLICK_REVERSE_DEST_ASSET, // Arbitrum USDC
      amount,
      recipient,
      recipientType: "DESTINATION_CHAIN",
      refundTo,
      refundType: "ORIGIN_CHAIN",
      deadline: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`1Click reverse quote failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return {
    quoteId: data.quoteId ?? data.quote?.quoteId,
    depositAddress: data.depositAddress ?? data.quote?.depositAddress,
    destinationAmount: data.destinationAmount ?? data.quote?.destinationAmount ?? data.quote?.amountOut,
    expiresAt: data.expiresAt ?? data.quote?.expiresAt ?? data.quote?.deadline,
    memo: data.memo ?? data.quote?.memo ?? data.quote?.depositMemo,
  };
}

/**
 * Submit the deposit tx hash to 1Click for faster tracking.
 */
export async function submitDeposit(depositAddress: string, txHash: string): Promise<void> {
  const res = await fetch(`${ONECLICK_BASE_URL}/deposit/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ depositAddress, txHash }),
  });
  if (!res.ok) {
    console.warn(`1Click deposit submit warning (${res.status}): ${await res.text()}`);
  }
}

export type BridgeStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "PROCESSING" | "SUCCESS" | "FAILED" | "REFUNDED";

/**
 * Poll 1Click bridge status until SUCCESS, FAILED, or REFUNDED.
 */
export async function pollBridgeStatus(
  depositAddress: string,
  depositMemo?: string,
  maxAttempts = 120,
  intervalMs = 5000,
): Promise<BridgeStatus> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const memoParam = depositMemo ? `&depositMemo=${depositMemo}` : "";
    const res = await fetch(`${ONECLICK_BASE_URL}/status?depositAddress=${depositAddress}${memoParam}`);
    const data = await res.json();
    const status: BridgeStatus = data.status;

    console.log(`  [${attempt}/${maxAttempts}] Bridge status: ${status}`);

    if (status === "SUCCESS" || status === "FAILED" || status === "REFUNDED") {
      return status;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for bridge completion");
}
