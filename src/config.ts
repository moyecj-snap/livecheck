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
/** Sentinel chain top-up. $0.50 USDC at 6 decimals = 500000 atomic. Funds on_change.verify / on_change.confirm, not bundled into watch $2.50. */
export const CHAIN_TOPUP_PRICE_USD = 0.5;
export const CHAIN_TOPUP_PRICE_LABEL = "$0.50";
export const CHAIN_TOPUP_PRICE_ATOMIC_USDC = "500000";
export const CHAIN_TOPUP_PRICE_ATOMIC = 500_000;
/** Internal chained Verify debit. Same $0.01 / 10000 atomic as POST /v1/verify. */
export const CHAIN_VERIFY_PRICE_USD = PRICE_USD;
export const CHAIN_VERIFY_PRICE_ATOMIC = 10_000;
/** Internal chained Confirm debit. Same prices as public Confirm routes — no new public price. */
export const CHAIN_CONFIRM_PRICE_USD = CONFIRM_PRICE_USD;
export const CHAIN_CONFIRM_PRICE_ATOMIC = 100_000;
export const CHAIN_ORDER_CONFIRM_PRICE_USD = ORDER_PLACED_PRICE_USD;
export const CHAIN_ORDER_CONFIRM_PRICE_ATOMIC = 250_000;
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
/**
 * While a target is failing, the next check is 1×, then 2×, then 4× `interval_s`,
 * and never later than this cap. A successful fetch returns to plain `interval_s`.
 */
export const WATCH_FAILURE_BACKOFF_CAP_S = 60 * 60;
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

export function confirmIntentPriceAtomic(intent: string): number {
  return atomicFromUsd(confirmIntentPriceUsd(intent));
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
  "POST {url, intent, claim?} after a side-effect. Payable intents on this route: lead_submit ($0.10) — thank-you/result page; confirmed only with a confirmation/ref/ticket/lead id (thank-you fluff alone is never confirmed). listing_published ($0.10) — specific job/product/eBay listing URL; claim.title/sku/id optional (match or veto; not required for L2). order_placed is not payable here — POST /v1/confirm/order ($0.25). Returns confirmed|failed|unknown with Level-2+ evidence. Independent cookieless verifier (actor ≠ verifier). Signed receipts: GET /v1/receipt/{id}. Keys: GET /.well-known/livecheck-keys.json. GET /stats publishes rolling counts and CI/local Confirm honesty benches (per-intent false_confirmed_rate + N); not a live dispute rate; missing ≠ live FC of 0. Not URL/stock liveness (use /v1/verify). Not Trust Oracle / L3. Unsupported intents → 400 unsupported_intent.";
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
  "POST {target, condition, baseline_hash?} for a one-shot check. No watcher is created. target.type=url, render=never (HTML only). Detectors: status_change — reuse Verify fetch/classify; fired when status or HTTP class differs from baseline_hash. keyword — params.any/all/none string arrays, optional selector, case_sensitive default false; fired when the presence set matches. text_diff — params.selector recommended (without it confidence is capped at 0.6), params.ignore regex array, params.min_change_ratio default 0.02; hashes after the ignore-by-default list (timestamps, viewers/sold, session ids, CSRF, ad slots, cookie banners). numeric_threshold — params.selector or params.jsonpath, params.op lt/lte/gt/gte/eq/change_pct, params.value, optional params.currency; parses $1,299.00 / 1 299,00 EUR / 149. Returns observation (status/signals/http_status/hash/summary), fired when comparable, confidence, price_usd 0.02, id (chk_ + ULID), and a Confirm-style receipt. 400 invalid_target / invalid_condition. 422 baseline_unreachable when the target cannot be fetched, baseline_hash is unusable, or keyword/text_diff/numeric gets HTTP 5xx (including 530), a timeout, a DNS failure, or a challenge page (no observation). status_change: 404 and 410 are closed; 5xx and timeouts are unreachable, not closed. Unpaid → 402 with one $0.02 accept (20000 atomic).";
/** Health / OpenAPI — Sentinel standard watcher. */
export const WATCH_DESCRIPTION =
  "Livecheck Sentinel watch — 30-day URL condition watcher. POST /v1/watch with {target, condition, callback?, interval_s, on_change?, chain_budget_usd?}. Omit callback to pull GET /v1/watch/{id}/events with the owner token. Detectors: status_change, keyword, text_diff, numeric_threshold (same as /v1/check). Standard tier emits change only after 2-of-3 confirmation (two consecutive checks or one check plus a ~20s re-fetch). HMAC-signed callbacks (X-Sentinel-Signature) when callback is set. Returns wtc_ id, owner_token (once), baseline, and a Confirm-style receipt. Fixed $2.50 USDC. on_change.run none|verify|confirm; confirm defaults intent=lead_submit ($0.10 internal). chain_budget_usd is a spend cap. Fund chain balance via POST /v1/watch/{id}/chain/topup ($0.50). GET/DELETE /v1/watch/{id} and GET /v1/watch/{id}/events with X-Livecheck-Owner-Token. No Playwright / fast tier in this phase. Not /v1/check ($0.02) and not a new Confirm price.";
/**
 * ASCII-only 402 copy for POST /v1/watch (fixed $2.50).
 * CDP rejects paymentPayload.resource.description over 500 characters
 * (x402-foundation/x402#2832; 500 passes, 501 fails). The previous 743-char
 * line was echoed by purl and failed verify before any USDC debit.
 * Keep this in the verify band (~200-300). Rich copy stays on
 * WATCH_DESCRIPTION and OPENAPI_WATCH_DESCRIPTION.
 */
export const WATCH_PAYMENT_DESCRIPTION =
  "Livecheck Sentinel watch - 30-day URL condition watcher. POST /v1/watch with {target, condition, callback?}. Omit callback to pull events. Optional HMAC callback. 2-of-3 confirmation. Returns wtc_ id and a signed receipt. Fixed $2.50 USDC (2500000 atomic). Not /v1/check ($0.02).";
export const OPENAPI_WATCH_SUMMARY = "Create a 30-day URL condition watcher ($2.50)";
export const OPENAPI_WATCH_DESCRIPTION =
  "POST {target, condition, callback?, interval_s?, label?, context?, on_change?, chain_budget_usd?} to create a standard watcher. Omit callback to pull events with the owner token on GET /v1/watch/{id}/events (no public HTTPS endpoint required). When callback is present it must be {url, secret, deliver?}. target.type=url, render=never (HTML only). render=always → 400 render_not_available (use /v1/watch/fast when that route ships). Detectors: status_change, keyword, text_diff, numeric_threshold — same internals as POST /v1/check. Standard tier emits change only after 2-of-3 confirmation: two consecutive candidate checks, or one candidate plus a ~20s confirmation re-fetch. callback.deliver on_change or every_check is accepted (standard still skips baseline spam). When callback.url is set, HMAC POSTs to that URL with X-Sentinel-Signature t=<unix>,v1=<hex> (HMAC-SHA256 of the raw JSON body with callback.secret). Pull-only watchers store events as already delivered and do not POST. Failed deliveries retry 1m, 5m, 30m, 2h (5 attempts); events are never dropped. on_change.run is none, verify, or confirm. confirm default intent is lead_submit ($0.10, same as POST /v1/confirm); set on_change.intent to listing_published ($0.10) or order_placed ($0.25, same as POST /v1/confirm/order). Optional on_change.url overrides the Confirm URL (default target.url); optional on_change.claim is forwarded to Confirm. Chain Confirm is internal (no public x402 / no new route price) and writes a cfm_ receipt to receipts.sqlite. chain_budget_usd is a spend cap only — the $2.50 watch price does not include chain funds. Fund via POST /v1/watch/{id}/chain/topup ($0.50, owner token + payment). interval_s min 300, default 900, max 2880 checks per 30-day term. Baseline is captured synchronously (≤10s); fetch failure still returns 201 with baseline.captured=false (never 422). owner_token (owt_…) is returned once; send it as X-Livecheck-Owner-Token on GET/DELETE /v1/watch/{id}, GET /v1/watch/{id}/events, POST /v1/watch/renew, and POST /v1/watch/{id}/chain/topup. DELETE stops early with no refund. Duplicate active watcher for the same paying wallet + target.url + condition → 409 duplicate_watch. Soft cap 200 active standard watchers per wallet → 429 rate_limited. Unpaid → 402 with one $2.50 accept (2500000 atomic).";
export const CHAIN_TOPUP_DESCRIPTION =
  "Livecheck Sentinel chain top-up — add $0.50 USDC chain balance to an existing watcher. POST /v1/watch/{id}/chain/topup. Requires X-Livecheck-Owner-Token plus x402 payment. Balance funds on_change.run=verify (internal Verify at $0.01) and on_change.run=confirm (internal Confirm at $0.10 / $0.25). No public /v1/verify or /v1/confirm payment. chain_budget_usd on create is a spend cap, not funding. Fixed $0.50 USDC. Not watch create ($2.50) and not a new Confirm price.";
/** ASCII-only 402 copy for POST /v1/watch/{id}/chain/topup (fixed $0.50). */
export const CHAIN_TOPUP_PAYMENT_DESCRIPTION =
  "Livecheck Sentinel chain top-up - add $0.50 USDC chain balance to an existing watcher. POST /v1/watch/{id}/chain/topup. Requires X-Livecheck-Owner-Token plus payment. Funds on_change.run=verify (internal Verify at $0.01) and on_change.run=confirm (internal Confirm at $0.10 / $0.25). No public /v1/verify or /v1/confirm. chain_budget_usd is a spend cap, not funding. Fixed $0.50 USDC (500000 atomic). Not watch create ($2.50) and not a new Confirm price.";
export const OPENAPI_CHAIN_TOPUP_SUMMARY = "Add $0.50 chain balance to a watcher";
export const OPENAPI_CHAIN_TOPUP_DESCRIPTION =
  "Paid $0.50 USDC (500000 atomic). One accept. Requires X-Livecheck-Owner-Token in addition to payment (owner token + payment). Credits $0.50 chain balance on the watcher in the path. Balance spends on on_change.run=verify ($0.01) or on_change.run=confirm ($0.10 lead_submit/listing_published, $0.25 order_placed). chain_budget_usd from create is a spend cap; this route is the only funding path (not bundled into POST /v1/watch $2.50). Unpaid → 402. Missing owner token after pay → 401. Wrong token → 403. Unknown id → 404.";
/** Health / OpenAPI — watch renew (same $2.50 product as create; Confirm continuity only). */
export const WATCH_RENEW_DESCRIPTION =
  "Livecheck watch renew — extend an active 30-day watcher prepaid window. POST /v1/watch/renew with {id}. Requires X-Livecheck-Owner-Token plus x402 payment. Same $2.50 USDC as POST /v1/watch create (one accept). Adds one prepaid term to expires_at (from the later of now and current expiry) and one term of checks_remaining. Same watcher id, condition, callback, and chain balance — not a second product and not a new detector or event. Stopped or expired watchers cannot renew. owner_token is not returned again. Signed wrn_ receipt. Confirm continuity only. Not /v1/watch/fast.";
/** ASCII-only 402 copy for POST /v1/watch/renew (fixed $2.50). Unicode broke Confirm settles. */
export const WATCH_RENEW_PAYMENT_DESCRIPTION =
  "Livecheck watch renew - extend an active 30-day watcher prepaid window. POST /v1/watch/renew with {id}. Requires X-Livecheck-Owner-Token plus payment. Same $2.50 USDC as POST /v1/watch create (2500000 atomic). One accept. Adds one prepaid term to expires_at and checks_remaining. Same watcher, not a second product. No new detector or event. Stopped or expired cannot renew. owner_token is not returned again. Confirm continuity only. Not /v1/watch/fast.";
export const OPENAPI_WATCH_RENEW_SUMMARY = "Renew an active 30-day watcher ($2.50)";
export const OPENAPI_WATCH_RENEW_DESCRIPTION =
  "POST {id} to extend an active standard watcher's prepaid window (Confirm continuity / Wave 4). Same $2.50 USDC (2500000 atomic) as POST /v1/watch — one accept, no dual price. id is the watcher id (wtc_ + ULID) in the JSON body so /.well-known/x402 can list a concrete URL (no {id} template). Requires X-Livecheck-Owner-Token in addition to payment (same as GET/DELETE /v1/watch/{id} and chain topup). Extends expires_at by 30 days from the later of now and the current expiry, and adds one term of checks_remaining (interval-based, max 2880/term). Same watcher id, target, condition, callback, and chain balance. Does not add detectors, lifecycle event types, or recapture baseline. Does not return owner_token. Stopped or expired → 409 not_renewable. Missing owner token after pay → 401. Wrong token → 403. Unknown id → 404. Unpaid → 402 with one $2.50 accept. Not Playwright / /v1/watch/fast. Not Confirm chain.";
/** x402 ResourceInfo / RouteConfig — Confirm only, so CDP can find Confirm under Livecheck. */
export const CONFIRM_SERVICE_NAME = "Livecheck";
export const CONFIRM_RESOURCE_TAGS = ["livecheck", "confirm"] as const;
export const NETWORK = "eip155:8453";
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
export const USDC_EIP712 = { name: "USD Coin", version: "2" } as const;
/** OpenAPI info.title. AgentCash serviceName cap is 32 ASCII characters. */
export const OPENAPI_INFO_TITLE = "Livecheck: Live Listing Status";
export const OPENAPI_INFO_DESCRIPTION =
  "Live status of a specific product page, marketplace listing, or job posting, read from the page at call time. Returns live, closed, or unknown plus title and evidence signals. Also one-shot page condition checks, 30-day URL watchers, watcher renew, and signed confirmation of form submissions and orders.";
export const OPENAPI_INFO_GUIDANCE =
  'Is this job posting still open? POST /v1/verify/job with {"url": "<one job posting URL>"} for $0.01. Is this product listing still available or sold out? POST /v1/verify/listing with {"url": "<one eBay, Shopify, or product page URL>"} for $0.01. Both return {status: live|closed|unknown, title, signals[], confidence}, read from the page at call time. Use before applying, recommending, buying, or scraping. Not a search engine: bring the URL. /v1/verify ($0.01) accepts any of these URLs. POST /v1/check ($0.02) for one-shot keyword / price-threshold / text-change checks. POST /v1/watch ($2.50) for 30-day watchers; HTTPS callback optional (pull GET /v1/watch/{id}/events). POST /v1/watch/renew ($2.50) extends a watcher. POST /v1/confirm ($0.10) and /v1/confirm/order ($0.25) after a form submission or checkout. On 503, wait for Retry-After and retry. For a list of URLs, send up to 8 checks at a time.';
export const OPENAPI_INFO_TAGS = [
  "listing-status",
  "product-availability",
  "job-postings",
  "ecommerce",
  "web-monitoring",
] as const;
/** OpenAPI POST /v1/verify only. 402 resource.description stays VERIFY_DESCRIPTION (CDP rejects descriptions over 500 characters). */
export const OPENAPI_VERIFY_SUMMARY = "Is this listing, product, or job posting still live? ($0.01)";
export const OPENAPI_VERIFY_DESCRIPTION =
  'POST {"url"} for one specific product page, marketplace listing (eBay, Shopify, Etsy, Poshmark, Mercari), or job posting (Greenhouse, Lever, Workday, Ashby, company careers pages). Livecheck fetches the page at call time and returns status live, closed, or unknown, with title, evidence signals (e.g. in stock, sold out, ended, apply form present, 404), HTTP status, canonical URL, and confidence. Use it before recommending, buying, applying, or scraping, and to clean stale URLs out of search results or datasets. Search engines and job boards are snapshots; this reads the page now. Not a search engine: bring the URL. Reads HTML (no JavaScript). Ashby, Workday, Lever, and Greenhouse job URLs may also use that vendor\'s public job-board API (no API key): a missing posting is closed, a listed posting can confirm live, and API errors fall back to HTML. Bot challenges stay unknown. Availability only, not legitimacy or fraud risk. Fixed $0.01 USDC on Base. On 503, wait for Retry-After and retry. For a list of URLs, send up to 8 checks at a time.';
export const OPENAPI_VERIFY_TAGS = ["listing-status", "product-availability", "job-postings"] as const;
/** OpenAPI POST /v1/verify/job. Same $0.01 handler as /v1/verify, plus public ATS board APIs. */
export const OPENAPI_VERIFY_JOB_SUMMARY =
  "Is this job posting still open? Check one specific job URL before applying ($0.01)";
export const OPENAPI_VERIFY_JOB_DESCRIPTION =
  'POST {"url"} for one specific job posting page. Livecheck fetches the posting at call time and returns open or closed status as live, closed, or unknown, with the job title and evidence signals. Works on company careers pages and applicant tracking systems such as Greenhouse, Lever, Workday, Ashby, SmartRecruiters, and iCIMS. Detects closed postings from 404 and 410 responses, redirects back to the job board, empty ATS listings, and closure language such as "position filled", "no longer accepting applications", and "this job has expired". For Ashby, Workday, Lever, and Greenhouse posting URLs, may also consult that vendor\'s public job-board API (no API key). If the API reports the posting missing, the verdict is closed (ats_api_missing). If the API lists it and the page is live or a JavaScript-only shell, the verdict is live (ats_api_listed). If the page looks closed but the API still lists it, the verdict is unknown. A bot challenge stays unknown (challenge_page) even when the API is tried; Livecheck does not bypass Cloudflare or reCAPTCHA. API timeouts and HTTP 5xx fall back to the HTML read and are never treated as closed. Not a job search: bring the posting URL. Fixed $0.01 USDC on Base. On 503, wait for Retry-After and retry. For a list of URLs, send up to 8 checks at a time.';
export const OPENAPI_VERIFY_JOB_TAGS = ["job-postings", "job-status", "listing-status"] as const;
/** OpenAPI POST /v1/verify/listing. Same $0.01 handler as /v1/verify. Craig Sept 30 brief, word for word. */
export const OPENAPI_VERIFY_LISTING_SUMMARY =
  "Is this product listing still available or sold out? Check one eBay, Shopify, or product page URL ($0.01)";
export const OPENAPI_VERIFY_LISTING_DESCRIPTION =
  'POST {"url"} for one specific product page or marketplace listing. Livecheck fetches the page at call time and returns live, closed, or unknown with the title and evidence signals such as in-stock, sold-out, and eBay listing ended. Works on eBay item pages, Shopify product pages, and standard HTML product pages. Use it before recommending a product, before adding to cart or buying, and to remove sold-out or deleted items from shopping search results, price comparisons, and scraped product lists. Search engines and shopping indexes are snapshots; this reads the page now. Not a product search: bring the item URL. Reads HTML only; unknown means the page could not be read reliably. Availability only, not legitimacy or fraud risk. Fixed $0.01 USDC on Base. On 503, wait for Retry-After and retry. For a list of URLs, send up to 8 checks at a time.';
export const OPENAPI_VERIFY_LISTING_TAGS = ["product-availability", "listing-status", "ecommerce"] as const;
/**
 * ASCII-only 402 / health description for POST /v1/verify.
 * Keep this short. OPENAPI_VERIFY_DESCRIPTION is the catalog copy and is longer than CDP's 500-character resource.description cap.
 */
export const VERIFY_DESCRIPTION =
  "Before you scrape a job posting, Shopify or HTML product page, or eBay item, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.";
export const USER_AGENT =
  "Livecheck/0.1 (+https://livecheck.local; primary-source verification)";
export const FETCH_TIMEOUT_MS = 8_000;
/** Public ATS board JSON (Ashby, Workday, Lever, Greenhouse). Separate from the HTML page fetch. */
export const ATS_FETCH_TIMEOUT_MS = 5_000;
/**
 * Whole verifyUrl / runCheck budget. On expiry, verify returns status
 * `unknown` with signal `check_timeout`. Check stays 422 baseline_unreachable
 * with the same signal so Sentinel does not store a fake observation.
 */
export const VERIFY_DEADLINE_MS = 20_000;
export const CHECK_TIMEOUT_SIGNAL = "check_timeout";
/**
 * Each facilitator verify / settle HTTP call.
 * @x402/core defaults to 30s. 5s stops a stuck Coinbase/CDP verify or settle
 * from holding the only Fly machine. On timeout or processor error Livecheck
 * does not settle and returns 503. A settle timeout is indeterminate at the
 * facilitator, so Livecheck does not retry settle and does not record a paid call.
 */
export const FACILITATOR_TIMEOUT_MS = 5_000;
/**
 * In-flight verify work on POST /v1/verify, /v1/verify/job, and
 * /v1/verify/listing. One shared CPU. 8 matches observed headroom (about 37%
 * memory, checks stayed fast under load). Override with
 * LIVECHECK_CHECK_CONCURRENCY (integer 1–64).
 *
 * When every slot is taken, up to CHECK_QUEUE_MAX requests wait up to
 * CHECK_QUEUE_WAIT_MS for a free slot. The response is 503 + Retry-After
 * only when that queue is full or the wait expires, and only before
 * facilitator verify/settle, so the caller is not charged.
 * LIVECHECK_CHECK_QUEUE_MAX: integer 0–256, default 30 (0 rejects immediately).
 * LIVECHECK_CHECK_QUEUE_WAIT_MS: integer 1–120000, default 10000.
 */
export const CHECK_CONCURRENCY = 8;
export const CHECK_QUEUE_MAX = 30;
export const CHECK_QUEUE_WAIT_MS = 10_000;
export const CHECK_CAPACITY_RETRY_AFTER_SECONDS = 5;
/** Shared Ashby board JSON, and single-posting responses for the other vendors. */
export const ATS_BOARD_CACHE_TTL_MS = 5 * 60 * 1000;
export const ATS_BOARD_CACHE_MAX_ENTRIES = 64;
/** Cap cached board JSON so a few large Ashby boards cannot eat the 1gb machine. */
export const ATS_BOARD_CACHE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * Off by default. When LIVECHECK_TEST_MODE_SECRET is set, a matching
 * x-livecheck-test-mode header skips x402 on the verify routes and still runs
 * the check. Never commit a production secret.
 */
export const TEST_MODE_HEADER = "x-livecheck-test-mode";
export const TEST_MODE_SECRET_ENV = "LIVECHECK_TEST_MODE_SECRET";
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
