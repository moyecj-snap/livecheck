import {
  CHAIN_VERIFY_PRICE_ATOMIC,
  CHAIN_VERIFY_PRICE_USD,
  atomicFromUsd,
} from "./config.js";
import { publicReceiptUrl, sha256Hex, stableJson } from "./receipt.js";
import type { ConfirmReceipt, VerifyVerdict, WatchChain } from "./types.js";
import { verifyUrl } from "./verify.js";
import { creditChainBalance, tryDebitChainBalance, type WatcherRow } from "./watch-store.js";

function chainVerifyReceipt(result: VerifyVerdict, eventId: string, requestUrl?: string, host?: string): ConfirmReceipt {
  return {
    hash: sha256Hex(stableJson(result)),
    verify_url: publicReceiptUrl(eventId, requestUrl, host),
  };
}

/**
 * Internal Verify only — never POST /v1/verify (no public x402 / no facilitator fee).
 * Debits $0.01 from chain balance when `on_change.run=verify`.
 */
export async function resolveChangeChain(
  watcher: WatcherRow,
  fetcher: typeof fetch,
  now: Date,
  eventId: string,
  requestUrl?: string,
  host?: string,
): Promise<WatchChain> {
  if (watcher.run !== "verify") return { run: "none" };
  const budgetAtomic = watcher.chain_budget_usd == null ? null : atomicFromUsd(watcher.chain_budget_usd);
  const debited = tryDebitChainBalance(watcher.id, CHAIN_VERIFY_PRICE_ATOMIC, budgetAtomic);
  if (!debited) return { skipped: "insufficient_balance" };
  try {
    const result = await verifyUrl(watcher.target_url, fetcher, now);
    return {
      run: "verify",
      result,
      receipt: chainVerifyReceipt(result, eventId, requestUrl, host),
      debit_usd: CHAIN_VERIFY_PRICE_USD,
    };
  } catch {
    creditChainBalance(watcher.id, CHAIN_VERIFY_PRICE_ATOMIC);
    return { skipped: "insufficient_balance" };
  }
}
