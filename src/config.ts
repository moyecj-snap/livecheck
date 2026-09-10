export const PRICE_USD = 0.01;
export const PRICE_LABEL = "$0.01";
/** $0.01 USDC at 6 decimals = 10000 atomic. */
export const PRICE_ATOMIC_USDC = "10000";
export const CONFIRM_PRICE_USD = 0.1;
export const CONFIRM_PRICE_LABEL = "$0.10";
/** $0.10 USDC at 6 decimals = 100000 atomic. */
export const CONFIRM_PRICE_ATOMIC_USDC = "100000";
/** order_placed only. lead_submit / listing_published stay $0.10. */
export const ORDER_PLACED_PRICE_USD = 0.25;
export const ORDER_PLACED_PRICE_LABEL = "$0.25";
/** $0.25 USDC at 6 decimals = 250000 atomic. */
export const ORDER_PLACED_PRICE_ATOMIC_USDC = "250000";
/** Sentinel one-shot check. $0.02 USDC at 6 decimals = 20000 atomic. */
export const CHECK_PRICE_USD = 0.02;
export const CHECK_PRICE_LABEL = "$0.02";
export const CHECK_PRICE_ATOMIC_USDC = "20000";
/** Sentinel standard watcher. $2.50 USDC at 6 decimals = 2500000 atomic. Same scale as check ($0.01=10000). */
export const WATCH_PRICE_USD = 2.5;
export const WATCH_PRICE_LABEL = "$2.50";
export const WATCH_PRICE_ATOMIC_USDC = "2500000";
/** Sentinel chain top-up. $0.50 USDC at 6 decimals = 500000 atomic. Funds on_change.verify, not bundled into watch $2.50. */
export const CHAIN_TOPUP_PRICE_USD = 0.5;
export const CHAIN_TOPUP_PRICE_LABEL = "$0.50";
export const CHAIN_TOPUP_PRICE_ATOMIC_USDC = "500000";
export const CHAIN_TOPUP_PRICE_ATOMIC = 500_000;
/** Internal chained Verify debit. Same $0.01 / 10000 atomic as POST /v1/verify. */
export const CHAIN_VERIFY_PRICE_USD = PRICE_USD;
export const CHAIN_VERIFY_PRICE_ATOMIC = 10_000;
export const USDC_ATOMIC_SCALE = 1_000_000;
export const WATCH_TIER = "standard" as const;
export const WATCH_TERM_DAYS = 30;
export const WATCH_TERM_SECONDS = WATCH_TERM_DAYS * 24 * 60 * 60;
export const WATCH_MAX_CHECKS_PER_TERM = 2880;
export const WATCH_MIN_INTERVAL_S = 300;
export const WATCH_DEFAULT_INTERVAL_S = 900;
export const WATCH_MAX_ACTIVE_PER_WALLET = 200;
export const WATCH_HOST_CONCURRENCY = 2;
export const WATCH_BASELINE_TIMEOUT_MS = 10_000;
export const WATCH_SCHEDULER_POLL_MS = 15_000;
/** Standard-tier 2-of-3: confirmation re-fetch after a candidate change. */
export const WATCH_CONFIRM_REFETCH_MS = 20_000;
export const WATCH_OWNER_TOKEN_HEADER = "x-livecheck-owner-token";
/** HMAC callback POST timeout. */
export const WATCH_CALLBACK_TIMEOUT_MS = 10_000;
/**
 * Backoff after each failed delivery attempt (1m, 5m, 30m, 2h, 12h).
 * Five POSTs total: immediate, then the first four delays. After the fifth
 * failure the event stays stored (`exhausted`) — never dropped.
 */
export const WATCH_CALLBACK_RETRY_DELAYS_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 60 * 60_000,
  12 * 60 * 60_000,
] as const;
export const WATCH_CALLBACK_MAX_ATTEMPTS = 5;
/** Consecutive target-fetch failures before a single `unreachable` event. */
export const WATCH_UNREACHABLE_FAILURES = 3;
/** Lead time for a one-shot `expiring` event. */
export const WATCH_EXPIRING_LEAD_MS = 24 * 60 * 60 * 1000;
export const WATCH_EVENTS_RETENTION_DAYS = 30;
export const WATCH_EVENTS_DEFAULT_LIMIT = 50;
export const WATCH_EVENTS_MAX_LIMIT = 100;
export const SENTINEL_SIGNATURE_HEADER = "X-Sentinel-Signature";

export function confirmIntentPriceUsd(intent: string): number {
  return intent === "order_placed" ? ORDER_PLACED_PRICE_USD : CONFIRM_PRICE_USD;
}

export function usdFromAtomic(atomic: number): number {
  return Math.round(atomic) / USDC_ATOMIC_SCALE;
}

export function atomicFromUsd(usd: number): number {
  return Math.round(usd * USDC_ATOMIC_SCALE);
}
/** Bazaar 402 / health confirm_description — rich copy; 402 headers stay ASCII. */
export const CONFIRM_DESCRIPTION =
  "Livecheck Confirm — independent side-effect verification (actor ≠ verifier). POST /v1/confirm with {url, intent} (+ optional claim). Returns confirmed|failed|unknown; thank-you fluff alone never confirmed — durable ref/id required. Intents: lead_submit $0.10 (lead/contact thank-you), listing_published $0.10 (listing go-live; claim title/sku/id optional) on /v1/confirm; order_placed $0.25 on POST /v1/confirm/order (order confirm/status; claim optional). Signed receipts + GET /stats. Same origin as Livecheck verify ($0.01). Not Trust Oracle / L3.";
/** ASCII-only copy for x402 payment-required (purl/CDP). Keep CONFIRM_DESCRIPTION for /health. */
export const CONFIRM_PAYMENT_DESCRIPTION =
  "Livecheck Confirm - independent side-effect verification (actor != verifier). POST /v1/confirm with {url, intent} (+ optional claim). Returns confirmed|failed|unknown; thank-you fluff alone never confirmed - durable ref/id required. Intents: lead_submit $0.10, listing_published $0.10. order_placed is POST /v1/confirm/order ($0.25). Signed receipts + GET /stats. Same origin as Livecheck verify ($0.01). Not Trust Oracle / L3.";
/** ASCII-only 402 copy for POST /v1/confirm/order (fixed $0.25). */
export const ORDER_PAYMENT_DESCRIPTION =
  "Livecheck Confirm order_placed - independent side-effect verification (actor != verifier). POST /v1/confirm/order with {url, intent: order_placed} (+ optional claim). Returns confirmed|failed|unknown; thank-you fluff alone never confirmed - durable order/ref/ticket id required. Fixed $0.25 USDC. lead_submit and listing_published stay on POST /v1/confirm ($0.10). Signed receipts + GET /stats. Not Trust Oracle / L3.";

export const OPENAPI_CONFIRM_SUMMARY =
  "Independently confirm lead_submit ($0.10) or listing_published ($0.10)";
/**
 * OpenAPI POST /v1/confirm description + x-guidance.
 * This route is fixed $0.10. order_placed lives on POST /v1/confirm/order.
 */
export const OPENAPI_CONFIRM_DESCRIPTION =
  "POST {url, intent, claim?} after a side-effect. Payable intents on this route: lead_submit ($0.10) — thank-you/result page; confirmed only with a confirmation/ref/ticket/lead id (thank-you fluff alone is never confirmed). listing_published ($0.10) — specific job/product/eBay listing URL; claim.title/sku/id optional (match or veto; not required for L2). order_placed is not payable here — POST /v1/confirm/order ($0.25). Returns confirmed|failed|unknown with Level-2+ evidence. Independent cookieless verifier (actor ≠ verifier). Signed receipts: GET /v1/receipt/{id}. Keys: GET /.well-known/livecheck-keys.json. GET /stats publishes rolling counts; accuracy benches are not published; missing ≠ false-confirmed rate of 0. Not URL/stock liveness (use /v1/verify). Not Trust Oracle / L3. Unsupported intents → 400 unsupported_intent.";
export const OPENAPI_CONFIRM_INTENT_DESCRIPTION =
  "Payable on this route: lead_submit ($0.10), listing_published ($0.10). listing_published claim.title/sku/id optional (match or veto; not required for L2). order_placed → 400 unsupported_intent (use POST /v1/confirm/order). Other values → 400 unsupported_intent.";
export const OPENAPI_CONFIRM_CLAIM_DESCRIPTION =
  "Optional. Not required. lead_submit ignores claim. listing_published: title/sku/id may match or veto; not required for L2.";
export const OPENAPI_ORDER_CONFIRM_SUMMARY =
  "Independently confirm order_placed ($0.25)";
export const OPENAPI_ORDER_CONFIRM_DESCRIPTION =
  "POST {url, intent: order_placed, claim?} after checkout. url is a thank-you/confirmation/order-status page; claim.order_id/total/email_domain optional (match or veto); thank-you fluff alone never confirmed; a durable order/confirmation/ref/ticket id is required for confirmed. Fixed $0.25 USDC. Returns confirmed|failed|unknown with Level-2+ evidence. Independent cookieless verifier (actor ≠ verifier). Signed receipts: GET /v1/receipt/{id}. lead_submit and listing_published stay on POST /v1/confirm ($0.10). Not Trust Oracle / L3. Other intents → 400 unsupported_intent.";
export const OPENAPI_ORDER_CONFIRM_INTENT_DESCRIPTION =
  "Payable on this route: order_placed ($0.25). claim.order_id/total/etc optional; thank-you fluff alone never confirmed; durable order/confirmation/ref/ticket id required for confirmed. Other values → 400 unsupported_intent (lead_submit / listing_published use POST /v1/confirm).";
export const OPENAPI_ORDER_CONFIRM_CLAIM_DESCRIPTION =
  "Optional. Not required. order_id/total/email_domain may match or veto; never invents ids; fluff-only pages stay unknown.";
/** Health / OpenAPI — Sentinel one-shot check. */
export const CHECK_DESCRIPTION =
  "Livecheck Sentinel check — one-shot URL condition check. POST /v1/check with {target, condition, baseline_hash?}. Detectors: status_change (Verify classify; fires when status/http class differs from baseline_hash), keyword (any/all/none presence), text_diff (selector recommended; ignore regexes; min_change_ratio default 0.02), numeric_threshold (selector or jsonpath; lt/lte/gt/gte/eq/change_pct). Returns current observation + fired when comparable. Fixed $0.02 USDC. No watcher created. Not /v1/verify ($0.01) and not Confirm.";
/** ASCII-only 402 copy for POST /v1/check (fixed $0.02). Unicode broke Confirm settles. */
export const CHECK_PAYMENT_DESCRIPTION =
  "Livecheck Sentinel check - one-shot URL condition check. POST /v1/check with {target, condition, baseline_hash?}. Detectors: status_change, keyword, text_diff, numeric_threshold. Returns current observation + fired when comparable. Fixed $0.02 USDC. No watcher created. Not /v1/verify ($0.01) and not Confirm.";
export const OPENAPI_CHECK_SUMMARY = "One-shot URL condition check ($0.02)";
export const OPENAPI_CHECK_DESCRIPTION =
  "POST {target, condition, baseline_hash?} for a one-shot check. No watcher is created. target.type=url, render=never (HTML only). Detectors: status_change — reuse Verify fetch/classify; fired when status or HTTP class differs from baseline_hash. keyword — params.any/all/none string arrays, optional selector, case_sensitive default false; fired when the presence set matches. text_diff — params.selector recommended (without it confidence is capped at 0.6), params.ignore regex array, params.min_change_ratio default 0.02; hashes after the ignore-by-default list (timestamps, viewers/sold, session ids, CSRF, ad slots, cookie banners). numeric_threshold — params.selector or params.jsonpath, params.op lt/lte/gt/gte/eq/change_pct, params.value, optional params.currency; parses $1,299.00 / 1 299,00 EUR / 149. Returns observation (status/signals/http_status/hash/summary), fired when comparable, confidence, price_usd 0.02, id (chk_ + ULID), and a Confirm-style receipt. 400 invalid_target / invalid_condition. 422 baseline_unreachable when the target cannot be fetched or baseline_hash is unusable. Unpaid → 402 with one $0.02 accept (20000 atomic).";
/** Health / OpenAPI — Sentinel standard watcher. */
export const WATCH_DESCRIPTION =
  "Livecheck Sentinel watch — 30-day URL condition watcher. POST /v1/watch with {target, condition, callback, interval_s, on_change?, chain_budget_usd?}. Detectors: status_change, keyword, text_diff, numeric_threshold (same as /v1/check). Standard tier emits change only after 2-of-3 confirmation (two consecutive checks or one check plus a ~20s re-fetch). HMAC-signed callbacks (X-Sentinel-Signature). Returns wtc_ id, owner_token (once), baseline, and a Confirm-style receipt. Fixed $2.50 USDC. on_change.run none|verify; chain_budget_usd is a spend cap. Fund chain balance via POST /v1/watch/{id}/chain/topup ($0.50). GET/DELETE /v1/watch/{id} and GET /v1/watch/{id}/events with X-Livecheck-Owner-Token. No Playwright / fast tier in this phase. Not /v1/check ($0.02) and not Confirm.";
/** ASCII-only 402 copy for POST /v1/watch (fixed $2.50). Unicode broke Confirm settles. */
export const WATCH_PAYMENT_DESCRIPTION =
  "Livecheck Sentinel watch - 30-day URL condition watcher. POST /v1/watch with {target, condition, callback, interval_s, on_change?, chain_budget_usd?}. Detectors: status_change, keyword, text_diff, numeric_threshold (same as /v1/check). Standard tier change events use 2-of-3 confirmation. HMAC-signed callbacks. Returns wtc_ id, owner_token (once), baseline, and a signed receipt. Fixed $2.50 USDC (2500000 atomic). on_change.run none or verify. chain_budget_usd is a spend cap; fund via POST /v1/watch/{id}/chain/topup ($0.50). GET/DELETE /v1/watch/{id} and GET /v1/watch/{id}/events with X-Livecheck-Owner-Token. No Playwright. Not /v1/check ($0.02) and not Confirm.";
export const OPENAPI_WATCH_SUMMARY = "Create a 30-day URL condition watcher ($2.50)";
export const OPENAPI_WATCH_DESCRIPTION =
  "POST {target, condition, callback, interval_s?, label?, context?, on_change?, chain_budget_usd?} to create a standard watcher. target.type=url, render=never (HTML only). render=always → 400 render_not_available (use /v1/watch/fast when that route ships). Detectors: status_change, keyword, text_diff, numeric_threshold — same internals as POST /v1/check. Standard tier emits change only after 2-of-3 confirmation: two consecutive candidate checks, or one candidate plus a ~20s confirmation re-fetch. callback.deliver on_change or every_check is accepted (standard still skips baseline spam). HMAC POSTs to callback.url with X-Sentinel-Signature t=<unix>,v1=<hex> (HMAC-SHA256 of the raw JSON body with callback.secret). Failed deliveries retry 1m, 5m, 30m, 2h (5 attempts); events are never dropped. on_change.run is none or verify (Confirm chain is not in this phase). chain_budget_usd is a spend cap only — the $2.50 watch price does not include chain funds. Fund via POST /v1/watch/{id}/chain/topup ($0.50, owner token + payment). interval_s min 300, default 900, max 2880 checks per 30-day term. Baseline is captured synchronously (≤10s); fetch failure still returns 201 with baseline.captured=false (never 422). owner_token (owt_…) is returned once; send it as X-Livecheck-Owner-Token on GET/DELETE /v1/watch/{id}, GET /v1/watch/{id}/events, and POST /v1/watch/{id}/chain/topup. DELETE stops early with no refund. Duplicate active watcher for the same paying wallet + target.url + condition → 409 duplicate_watch. Soft cap 200 active standard watchers per wallet → 429 rate_limited. Unpaid → 402 with one $2.50 accept (2500000 atomic).";
export const CHAIN_TOPUP_DESCRIPTION =
  "Livecheck Sentinel chain top-up — add $0.50 USDC chain balance to an existing watcher. POST /v1/watch/{id}/chain/topup. Requires X-Livecheck-Owner-Token plus x402 payment. Balance funds on_change.run=verify (internal Verify at $0.01, no public /v1/verify payment). chain_budget_usd on create is a spend cap, not funding. Fixed $0.50 USDC. Not watch create ($2.50) and not Confirm.";
/** ASCII-only 402 copy for POST /v1/watch/{id}/chain/topup (fixed $0.50). */
export const CHAIN_TOPUP_PAYMENT_DESCRIPTION =
  "Livecheck Sentinel chain top-up - add $0.50 USDC chain balance to an existing watcher. POST /v1/watch/{id}/chain/topup. Requires X-Livecheck-Owner-Token plus payment. Funds on_change.run=verify (internal Verify at $0.01; no public /v1/verify). chain_budget_usd is a spend cap, not funding. Fixed $0.50 USDC (500000 atomic). Not watch create ($2.50) and not Confirm.";
export const OPENAPI_CHAIN_TOPUP_SUMMARY = "Add $0.50 chain balance to a watcher";
export const OPENAPI_CHAIN_TOPUP_DESCRIPTION =
  "Paid $0.50 USDC (500000 atomic). One accept. Requires X-Livecheck-Owner-Token in addition to payment (owner token + payment). Credits $0.50 chain balance on the watcher in the path. chain_budget_usd from create is a spend cap; this route is the only funding path (not bundled into POST /v1/watch $2.50). Unpaid → 402. Missing owner token after pay → 401. Wrong token → 403. Unknown id → 404.";
/** x402 ResourceInfo / RouteConfig — Confirm only, so CDP can find Confirm under Livecheck. */
export const CONFIRM_SERVICE_NAME = "Livecheck";
export const CONFIRM_RESOURCE_TAGS = ["livecheck", "confirm"] as const;
export const NETWORK = "eip155:8453";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
export const VERIFY_DESCRIPTION =
  "Before you scrape a job posting, Shopify or HTML product page, or eBay item, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.";
export const USER_AGENT =
  "Livecheck/0.1 (+https://livecheck.local; primary-source verification)";
export const FETCH_TIMEOUT_MS = 8_000;
export const MAX_BODY_BYTES = 1_500_000;
export const DEFAULT_PORT = 43127;
export const STRIPE_X402_API_VERSION = "2026-05-27.preview";
export const MOCK_PAY_TO = "0x2222222222222222222222222222222222222222";
export const MOCK_PAYMENT_HEADER = "livecheck-dev";

const requiredLive = [
  "STRIPE_SECRET_KEY",
  "DEPOSIT_ADDRESS",
  "CDP_API_KEY_ID",
  "CDP_API_KEY_SECRET",
] as const;

export type LiveKeys = {
  stripeSecretKey: string;
  depositAddress: string;
  cdpApiKeyId: string;
  cdpApiKeySecret: string;
};

export function readLiveKeys(): LiveKeys | null {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();
  const depositAddress = process.env.DEPOSIT_ADDRESS?.trim();
  const cdpApiKeyId = process.env.CDP_API_KEY_ID?.trim();
  const cdpApiKeySecret = process.env.CDP_API_KEY_SECRET?.trim();
  if (!stripeSecretKey || !depositAddress || !cdpApiKeyId || !cdpApiKeySecret) {
    return null;
  }
  return {
    stripeSecretKey,
    depositAddress: depositAddress.toLowerCase(),
    cdpApiKeyId,
    cdpApiKeySecret,
  };
}

export function missingLiveKeyNames(): string[] {
  return requiredLive.filter((name) => !process.env[name]?.trim());
}

export function isLiveSettlement(): boolean {
  return readLiveKeys() !== null;
}

export function payToAddress(): string {
  return readLiveKeys()?.depositAddress ?? MOCK_PAY_TO;
}

export function port(): number {
  const raw = process.env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}
