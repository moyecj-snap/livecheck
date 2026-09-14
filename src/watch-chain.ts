import {
  CHAIN_VERIFY_PRICE_ATOMIC,
  CHAIN_VERIFY_PRICE_USD,
  atomicFromUsd,
  confirmIntentPriceAtomic,
  confirmIntentPriceUsd,
} from "./config.js";
import { confirmUrl } from "./confirm.js";
import { publicReceiptUrl, sealConfirmResultDetailed, sha256Hex, stableJson } from "./receipt.js";
import type { ConfirmIntent, ConfirmReceipt, VerifyVerdict, WatchChain, WatchChainConfirmConfig } from "./types.js";
import { verifyUrl } from "./verify.js";
import { creditChainBalance, tryDebitChainBalance, type WatcherRow } from "./watch-store.js";

function chainVerifyReceipt(result: VerifyVerdict, eventId: string, requestUrl?: string, host?: string): ConfirmReceipt {
  return {
    hash: sha256Hex(stableJson(result)),
    verify_url: publicReceiptUrl(eventId, requestUrl, host),
  };
}

function confirmConfig(watcher: WatcherRow): WatchChainConfirmConfig {
  return watcher.chain_confirm ?? { intent: "lead_submit", url: null, claim: null };
}

function confirmUrlFor(watcher: WatcherRow, config: WatchChainConfirmConfig): string {
  return config.url ?? watcher.target_url;
}

/**
 * Internal Verify or Confirm — never POST the public x402 routes (no facilitator fee).
 * Debits $0.01 when `on_change.run=verify`.
 * Debits $0.10 (`lead_submit` / `listing_published`) or $0.25 (`order_placed`) when `run=confirm`.
 * Successful Confirm writes a `cfm_` row to receipts.sqlite via sealConfirmResultDetailed.
 */
export async function resolveChangeChain(
  watcher: WatcherRow,
  fetcher: typeof fetch,
  now: Date,
  eventId: string,
  requestUrl?: string,
  host?: string,
): Promise<WatchChain> {
  if (watcher.run === "confirm") {
    return resolveConfirmChain(watcher, fetcher, now, requestUrl, host);
  }
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

async function resolveConfirmChain(
  watcher: WatcherRow,
  fetcher: typeof fetch,
  now: Date,
  requestUrl?: string,
  host?: string,
): Promise<WatchChain> {
  const config = confirmConfig(watcher);
  const intent: ConfirmIntent = config.intent;
  const url = confirmUrlFor(watcher, config);
  const debitUsd = confirmIntentPriceUsd(intent);
  const debitAtomic = confirmIntentPriceAtomic(intent);
  const budgetAtomic = watcher.chain_budget_usd == null ? null : atomicFromUsd(watcher.chain_budget_usd);
  const debited = tryDebitChainBalance(watcher.id, debitAtomic, budgetAtomic);
  if (!debited) return { skipped: "insufficient_balance" };
  try {
    const classified = await confirmUrl(url, fetcher, now, {
      intent,
      claim: config.claim ?? undefined,
    });
    const { result, durable } = sealConfirmResultDetailed(classified, {
      intent,
      url,
      claim: config.claim ?? undefined,
      requestUrl,
      host,
      now,
    });
    if (!durable || !result.receipt || !result.id) {
      creditChainBalance(watcher.id, debitAtomic);
      return { skipped: "receipt_persist_failed" };
    }
    return {
      run: "confirm",
      intent,
      result,
      receipt: result.receipt,
      debit_usd: debitUsd,
    };
  } catch {
    creditChainBalance(watcher.id, debitAtomic);
    return { skipped: "insufficient_balance" };
  }
}
