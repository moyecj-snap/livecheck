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

export function confirmIntentPriceUsd(intent: string): number {
  return intent === "order_placed" ? ORDER_PLACED_PRICE_USD : CONFIRM_PRICE_USD;
}
/** Bazaar 402 / health confirm_description — lead_submit-primary. Quiet listing_published pointer. Not a GA order_placed ad. */
export const CONFIRM_DESCRIPTION =
  "Livecheck Confirm — use after your agent submits a lead/contact form (intent=lead_submit): POST {url, intent} where url is the thank-you or result page. Returns confirmed|failed|unknown with Level-2+ evidence (confirmation/ref/ticket id required for confirmed). Independent cookieless verifier — actor ≠ verifier. Also accepts intent=listing_published ($0.10) for listing go-live checks — see OpenAPI. Signed receipts + GET /stats. Not URL/stock liveness (use /v1/verify). Not Trust Oracle / L3.";
/** OpenAPI POST /v1/confirm summary — machine-accurate for all payable intents. */
export const OPENAPI_CONFIRM_SUMMARY =
  "Independently confirm lead_submit ($0.10), listing_published ($0.10), or order_placed ($0.25)";
/**
 * OpenAPI POST /v1/confirm description + x-guidance.
 * Machine-accurate for all three payable intents. Bazaar/health still use CONFIRM_DESCRIPTION.
 */
export const OPENAPI_CONFIRM_DESCRIPTION =
  "POST {url, intent, claim?} after a side-effect. Payable intents: lead_submit ($0.10) — thank-you/result page; confirmed only with a confirmation/ref/ticket/lead id (thank-you fluff alone is never confirmed). listing_published ($0.10) — specific job/product/eBay listing URL; claim.title/sku/id optional (match or veto; not required for L2). order_placed ($0.25) — thank-you/confirmation/order-status page; claim.order_id/total/etc optional (match or veto); thank-you fluff alone never confirmed; a durable order/confirmation/ref/ticket id is required for confirmed. Returns confirmed|failed|unknown with Level-2+ evidence. Independent cookieless verifier (actor ≠ verifier). Signed receipts: GET /v1/receipt/{id}. Keys: GET /.well-known/livecheck-keys.json. GET /stats publishes rolling counts; accuracy benches are not published; missing ≠ false-confirmed rate of 0. Not URL/stock liveness (use /v1/verify). Not Trust Oracle / L3. Unsupported intents → 400 unsupported_intent.";
export const OPENAPI_CONFIRM_INTENT_DESCRIPTION =
  "Payable: lead_submit ($0.10), listing_published ($0.10), order_placed ($0.25). listing_published claim.title/sku/id optional (match or veto; not required for L2). order_placed claim.order_id/total/etc optional; thank-you fluff alone never confirmed; durable order/confirmation/ref/ticket id required for confirmed. Other values → 400 unsupported_intent.";
export const OPENAPI_CONFIRM_CLAIM_DESCRIPTION =
  "Optional. Not required. lead_submit ignores claim. listing_published: title/sku/id may match or veto; not required for L2. order_placed: order_id/total/email_domain may match or veto; never invents ids; fluff-only pages stay unknown.";
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
