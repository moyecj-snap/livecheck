import { CHAIN_TOPUP_OUTPUT_SCHEMA, CHECK_OUTPUT_SCHEMA, CONFIRM_OUTPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA, VERIFY_PAID_EXAMPLE, WATCH_OUTPUT_SCHEMA, WATCH_RENEW_OUTPUT_SCHEMA } from "./bazaar.js";
import {
  OPENAPI_CHAIN_TOPUP_DESCRIPTION,
  OPENAPI_CHAIN_TOPUP_SUMMARY,
  OPENAPI_CHECK_DESCRIPTION,
  OPENAPI_CHECK_SUMMARY,
  OPENAPI_CONFIRM_CLAIM_DESCRIPTION,
  OPENAPI_CONFIRM_DESCRIPTION,
  OPENAPI_CONFIRM_INTENT_DESCRIPTION,
  OPENAPI_CONFIRM_SUMMARY,
  OPENAPI_ORDER_CONFIRM_CLAIM_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_INTENT_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_SUMMARY,
  OPENAPI_WATCH_DESCRIPTION,
  OPENAPI_WATCH_RENEW_DESCRIPTION,
  OPENAPI_WATCH_RENEW_SUMMARY,
  OPENAPI_WATCH_SUMMARY,
  VERIFY_DESCRIPTION,
} from "./config.js";
import { publicOrigin } from "./public-url.js";

const OPENAPI_VERSION = "1.0.0";
const OPENAPI_PRICE_AMOUNT = "0.01";
const OPENAPI_CONFIRM_PRICE_AMOUNT = "0.10";
const OPENAPI_ORDER_PLACED_PRICE_AMOUNT = "0.25";
const OPENAPI_CHECK_PRICE_AMOUNT = "0.02";
const OPENAPI_WATCH_PRICE_AMOUNT = "2.50";
const OPENAPI_CHAIN_TOPUP_PRICE_AMOUNT = "0.50";

/**
 * Concrete paid URLs listed on GET /.well-known/x402.
 * Crawlers (x402scan, AgentCash) hit these strings literally — no `{id}` templates.
 * Path-param chain topup stays on OpenAPI only (PAID_DISCOVERY_ROUTES).
 */
export const WELL_KNOWN_X402_ROUTES = [
  { path: "/v1/verify", amount: OPENAPI_PRICE_AMOUNT },
  { path: "/v1/check", amount: OPENAPI_CHECK_PRICE_AMOUNT },
  { path: "/v1/watch", amount: OPENAPI_WATCH_PRICE_AMOUNT },
  { path: "/v1/watch/renew", amount: OPENAPI_WATCH_PRICE_AMOUNT },
  { path: "/v1/confirm", amount: OPENAPI_CONFIRM_PRICE_AMOUNT },
  { path: "/v1/confirm/order", amount: OPENAPI_ORDER_PLACED_PRICE_AMOUNT },
] as const;

/** Paid routes documented on OpenAPI. One fixed price each. Includes path-param topup. */
export const PAID_DISCOVERY_ROUTES = [
  { path: "/v1/verify", amount: OPENAPI_PRICE_AMOUNT },
  { path: "/v1/check", amount: OPENAPI_CHECK_PRICE_AMOUNT },
  { path: "/v1/watch", amount: OPENAPI_WATCH_PRICE_AMOUNT },
  { path: "/v1/watch/renew", amount: OPENAPI_WATCH_PRICE_AMOUNT },
  { path: "/v1/watch/{id}/chain/topup", amount: OPENAPI_CHAIN_TOPUP_PRICE_AMOUNT },
  { path: "/v1/confirm", amount: OPENAPI_CONFIRM_PRICE_AMOUNT },
  { path: "/v1/confirm/order", amount: OPENAPI_ORDER_PLACED_PRICE_AMOUNT },
] as const;

export function discoveryHeaders(): Record<string, string> {
  return {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "public, max-age=300",
    "access-control-allow-origin": "*",
  };
}

export function openApiDocument(requestUrl?: string, host?: string): Record<string, unknown> {
  const origin = publicOrigin(requestUrl, host);
  return {
    openapi: "3.1.0",
    info: {
      title: "Livecheck",
      version: OPENAPI_VERSION,
      description: VERIFY_DESCRIPTION,
      "x-guidance": VERIFY_DESCRIPTION,
    },
    servers: [{ url: origin }],
    paths: {
      "/v1/verify": {
        post: {
          operationId: "verifyListing",
          summary: "Verify a specific job, product, or eBay item URL",
          description: VERIFY_DESCRIPTION,
          tags: ["Verify"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Absolute http(s) URL of the specific job, product, or eBay item page to check. Not a search-results URL.",
                    },
                  },
                  required: ["url"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Primary-source live, closed, or unknown verdict. Paid 200 includes watch suggest for POST /v1/watch (detector status_change, $2.50). Unpaid 402 has no watch field.",
              content: {
                "application/json": {
                  schema: VERIFY_OUTPUT_SCHEMA,
                  example: VERIFY_PAID_EXAMPLE,
                },
              },
            },
            "402": {
              description: "Payment Required",
            },
          },
        },
      },
      "/v1/check": {
        post: {
          operationId: "sentinelCheck",
          summary: OPENAPI_CHECK_SUMMARY,
          description: OPENAPI_CHECK_DESCRIPTION,
          "x-guidance": OPENAPI_CHECK_DESCRIPTION,
          tags: ["Sentinel", "check"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_CHECK_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    target: {
                      type: "object",
                      description: "URL target. type must be url. render must be never. selector optional.",
                      properties: {
                        type: { type: "string", enum: ["url"] },
                        url: { type: "string", format: "uri" },
                        render: { type: "string", enum: ["never"] },
                        selector: { type: ["string", "null"] },
                      },
                      required: ["type", "url"],
                    },
                    condition: {
                      type: "object",
                      description:
                        "detector status_change, keyword, text_diff, or numeric_threshold. text_diff: selector?, ignore[], min_change_ratio default 0.02. numeric_threshold: selector or jsonpath, op, value, currency?.",
                      properties: {
                        detector: {
                          type: "string",
                          enum: ["status_change", "keyword", "text_diff", "numeric_threshold"],
                        },
                        params: { type: "object" },
                      },
                      required: ["detector"],
                    },
                    baseline_hash: {
                      type: ["string", "null"],
                      description: "Prior observation.hash. Required for status_change fired. Omit on first check.",
                    },
                  },
                  required: ["target", "condition"],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Current observation, optional fired, chk_ id, and receipt",
              content: {
                "application/json": {
                  schema: CHECK_OUTPUT_SCHEMA,
                },
              },
            },
            "400": {
              description: "invalid_target or invalid_condition",
            },
            "402": {
              description: "Payment required. Fixed $0.02 USDC (20000 atomic).",
            },
            "422": {
              description: "baseline_unreachable — target fetch failed or baseline_hash unusable",
            },
          },
        },
      },
      "/v1/watch": {
        post: {
          operationId: "sentinelWatch",
          summary: OPENAPI_WATCH_SUMMARY,
          description: OPENAPI_WATCH_DESCRIPTION,
          "x-guidance": OPENAPI_WATCH_DESCRIPTION,
          tags: ["Sentinel", "watch"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_WATCH_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    target: {
                      type: "object",
                      description: "URL target. type must be url. render must be never. render=always is 400 render_not_available.",
                      properties: {
                        type: { type: "string", enum: ["url"] },
                        url: { type: "string", format: "uri" },
                        render: { type: "string", enum: ["never"] },
                        selector: { type: ["string", "null"] },
                      },
                      required: ["type", "url"],
                    },
                    condition: {
                      type: "object",
                      description: "detector status_change, keyword, text_diff, or numeric_threshold. Same detectors as POST /v1/check.",
                      properties: {
                        detector: {
                          type: "string",
                          enum: ["status_change", "keyword", "text_diff", "numeric_threshold"],
                        },
                        params: { type: "object" },
                      },
                      required: ["detector"],
                    },
                    callback: {
                      type: "object",
                      description:
                        "HTTPS callback. deliver=on_change or every_check. HMAC-SHA256 over the raw JSON body; header X-Sentinel-Signature: t=<unix>,v1=<hex>.",
                      properties: {
                        url: { type: "string", format: "uri" },
                        secret: { type: "string" },
                        deliver: { type: "string", enum: ["on_change", "every_check"] },
                      },
                      required: ["url", "secret"],
                    },
                    interval_s: {
                      type: "integer",
                      minimum: 300,
                      default: 900,
                      description: "Seconds between observations. Min 300, default 900. Max 2880 checks/term.",
                    },
                    label: { type: "string" },
                    context: { type: "object" },
                    chain_budget_usd: {
                      type: "number",
                      description:
                        "Spend cap for chained Verify. Funding is POST /v1/watch/{id}/chain/topup ($0.50), not bundled into the $2.50 watch price.",
                    },
                    on_change: {
                      type: "object",
                      description: "run=none (default) or verify. On emitted change, verify runs internally when chain balance >= $0.01.",
                      properties: {
                        run: { type: "string", enum: ["none", "verify"] },
                      },
                    },
                  },
                  required: ["target", "condition", "callback"],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "Watcher created. owner_token is returned once.",
              content: {
                "application/json": {
                  schema: WATCH_OUTPUT_SCHEMA,
                },
              },
            },
            "400": {
              description: "invalid_target, invalid_condition, invalid_callback, invalid_interval, or render_not_available",
            },
            "402": {
              description: "Payment required. Fixed $2.50 USDC (2500000 atomic).",
            },
            "409": {
              description: "duplicate_watch — same paying wallet + target.url + condition while active",
            },
            "429": {
              description: "rate_limited — 200 active standard watchers per wallet",
            },
          },
        },
      },
      "/v1/watch/renew": {
        post: {
          operationId: "sentinelWatchRenew",
          summary: OPENAPI_WATCH_RENEW_SUMMARY,
          description: OPENAPI_WATCH_RENEW_DESCRIPTION,
          "x-guidance": OPENAPI_WATCH_RENEW_DESCRIPTION,
          tags: ["Sentinel", "watch"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_WATCH_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          parameters: [
            {
              name: "X-Livecheck-Owner-Token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "owt_ token returned once on POST /v1/watch. Required in addition to payment.",
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    id: {
                      type: "string",
                      description: "Watcher id (wtc_ + ULID). In the body so the well-known URL stays concrete.",
                    },
                  },
                  required: ["id"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Watcher prepaid window extended. owner_token is not returned again. Receipt id is wrn_.",
              content: {
                "application/json": {
                  schema: WATCH_RENEW_OUTPUT_SCHEMA,
                },
              },
            },
            "400": {
              description: "invalid_id — missing or malformed watcher id",
            },
            "401": { description: "Missing owner token" },
            "403": { description: "Wrong owner token" },
            "404": { description: "Unknown watcher" },
            "409": { description: "not_renewable — watcher is stopped or expired" },
            "402": {
              description: "Payment required. Fixed $2.50 USDC (2500000 atomic). One accept.",
            },
          },
        },
      },
      "/v1/watch/{id}": {
        get: {
          operationId: "getSentinelWatch",
          summary: "Read a watcher (owner token required)",
          description:
            "Free. Send the owner_token from create as header X-Livecheck-Owner-Token. Does not return the token again. Does not refund or charge.",
          tags: ["Sentinel", "watch"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Watcher id (wtc_ + ULID).",
            },
            {
              name: "X-Livecheck-Owner-Token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "owt_ token returned once on POST /v1/watch.",
            },
          ],
          responses: {
            "200": { description: "Watcher status, baseline, last observation" },
            "401": { description: "Missing owner token" },
            "403": { description: "Wrong owner token" },
            "404": { description: "Unknown id" },
          },
        },
        delete: {
          operationId: "deleteSentinelWatch",
          summary: "Stop a watcher early (no refund)",
          description:
            "Free. Requires X-Livecheck-Owner-Token. Stops the watcher immediately. No refund.",
          tags: ["Sentinel", "watch"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Watcher id (wtc_ + ULID).",
            },
            {
              name: "X-Livecheck-Owner-Token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "owt_ token returned once on POST /v1/watch.",
            },
          ],
          responses: {
            "200": { description: "Stopped. { id, status: stopped, refund: false }" },
            "401": { description: "Missing owner token" },
            "403": { description: "Wrong owner token" },
            "404": { description: "Unknown id" },
          },
        },
      },
      "/v1/watch/{id}/chain/topup": {
        post: {
          operationId: "sentinelWatchChainTopup",
          summary: OPENAPI_CHAIN_TOPUP_SUMMARY,
          description: OPENAPI_CHAIN_TOPUP_DESCRIPTION,
          "x-guidance": OPENAPI_CHAIN_TOPUP_DESCRIPTION,
          tags: ["Sentinel", "watch", "chain"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_CHAIN_TOPUP_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Watcher id (wtc_ + ULID).",
            },
            {
              name: "X-Livecheck-Owner-Token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "owt_ token returned once on POST /v1/watch. Required in addition to payment.",
            },
          ],
          responses: {
            "200": {
              description: "Chain balance increased by $0.50.",
              content: {
                "application/json": {
                  schema: CHAIN_TOPUP_OUTPUT_SCHEMA,
                },
              },
            },
            "401": { description: "Missing owner token" },
            "403": { description: "Wrong owner token" },
            "404": { description: "Unknown watcher" },
            "402": {
              description: "Payment required. Fixed $0.50 USDC (500000 atomic). One accept.",
            },
          },
        },
      },
      "/v1/watch/{id}/events": {
        get: {
          operationId: "listSentinelWatchEvents",
          summary: "Paginated watcher event history (30 days, free)",
          description:
            "Free. Requires X-Livecheck-Owner-Token. Returns change, unreachable, recovered, expiring, and expired events from the last 30 days. Query limit (default 50, max 100) and cursor (event id). Bad owner token → 403.",
          tags: ["Sentinel", "watch"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Watcher id (wtc_ + ULID).",
            },
            {
              name: "X-Livecheck-Owner-Token",
              in: "header",
              required: true,
              schema: { type: "string" },
              description: "owt_ token returned once on POST /v1/watch.",
            },
            {
              name: "limit",
              in: "query",
              required: false,
              schema: { type: "integer", minimum: 1, maximum: 100, default: 50 },
            },
            {
              name: "cursor",
              in: "query",
              required: false,
              schema: { type: "string" },
              description: "Event id (evt_). Returns events older than this id.",
            },
          ],
          responses: {
            "200": { description: "Paginated events with next_cursor when has_more" },
            "401": { description: "Missing owner token" },
            "403": { description: "Wrong owner token" },
            "404": { description: "Unknown watcher or cursor" },
          },
        },
      },
      "/v1/confirm": {
        post: {
          operationId: "confirmLeadSubmit",
          summary: OPENAPI_CONFIRM_SUMMARY,
          description: OPENAPI_CONFIRM_DESCRIPTION,
          "x-guidance": OPENAPI_CONFIRM_DESCRIPTION,
          tags: ["Confirm", "lead_submit", "side-effect"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_CONFIRM_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Absolute http(s) URL. lead_submit: thank-you or result page. listing_published: the specific job, product, or eBay item URL claimed to be live.",
                    },
                    intent: {
                      type: "string",
                      enum: ["lead_submit", "listing_published"],
                      description: OPENAPI_CONFIRM_INTENT_DESCRIPTION,
                    },
                    claim: {
                      type: "object",
                      description: OPENAPI_CONFIRM_CLAIM_DESCRIPTION,
                    },
                  },
                  required: ["url", "intent"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Independent confirmed, failed, or unknown verdict. Paid 200 includes watch suggest for POST /v1/watch.",
              content: {
                "application/json": {
                  schema: CONFIRM_OUTPUT_SCHEMA,
                },
              },
            },
            "400": {
              description:
                "unsupported_intent or invalid body. Payable intents: lead_submit, listing_published. order_placed → POST /v1/confirm/order.",
            },
            "402": {
              description: "Payment required. Fixed $0.10 USDC (100000 atomic).",
            },
          },
        },
      },
      "/v1/confirm/order": {
        post: {
          operationId: "confirmOrderPlaced",
          summary: OPENAPI_ORDER_CONFIRM_SUMMARY,
          description: OPENAPI_ORDER_CONFIRM_DESCRIPTION,
          "x-guidance": OPENAPI_ORDER_CONFIRM_DESCRIPTION,
          tags: ["Confirm", "order_placed", "side-effect"],
          "x-payment-info": {
            price: {
              mode: "fixed",
              currency: "USD",
              amount: OPENAPI_ORDER_PLACED_PRICE_AMOUNT,
            },
            protocols: [{ x402: {} }],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    url: {
                      type: "string",
                      format: "uri",
                      description:
                        "Absolute http(s) URL of the thank-you / confirmation / order-status page after checkout.",
                    },
                    intent: {
                      type: "string",
                      enum: ["order_placed"],
                      description: OPENAPI_ORDER_CONFIRM_INTENT_DESCRIPTION,
                    },
                    claim: {
                      type: "object",
                      description: OPENAPI_ORDER_CONFIRM_CLAIM_DESCRIPTION,
                    },
                  },
                  required: ["url", "intent"],
                },
              },
            },
          },
          responses: {
            "200": {
              description:
                "Independent confirmed, failed, or unknown verdict. Paid 200 includes watch suggest for POST /v1/watch.",
              content: {
                "application/json": {
                  schema: CONFIRM_OUTPUT_SCHEMA,
                },
              },
            },
            "400": {
              description:
                "unsupported_intent or invalid body. Payable intent: order_placed. lead_submit / listing_published → POST /v1/confirm.",
            },
            "402": {
              description: "Payment required. Fixed $0.25 USDC (250000 atomic).",
            },
          },
        },
      },
      "/v1/receipt/{id}": {
        get: {
          operationId: "getConfirmReceipt",
          summary: "Fetch a Confirm receipt by id",
          description:
            "Free. Returns the stored receipt, canonical payload, and verify metadata. Accepts Confirm ids (cfm_), Sentinel check ids (chk_), watcher ids (wtc_), watch renew ids (wrn_), and watch event ids (evt_). Rows persist in receipts.sqlite on the same Fly volume as watchers and survive redeploy. Unsigned when CONFIRM_RECEIPT_PRIVATE_KEY is unset.",
          tags: ["Confirm", "Sentinel"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Confirm id (cfm_ + ULID), check id (chk_ + ULID), watcher id (wtc_ + ULID), renew id (wrn_ + ULID), or event id (evt_ + ULID).",
            },
          ],
          responses: {
            "200": { description: "Receipt and verify metadata" },
            "404": { description: "Unknown id" },
          },
        },
      },
      "/.well-known/livecheck-keys.json": {
        get: {
          operationId: "livecheckKeys",
          summary: "Ed25519 public key for Confirm receipts",
          description: "Free JWKS-style document. keys is empty when signing is not configured.",
          tags: ["Confirm"],
          responses: {
            "200": { description: "Public keys" },
          },
        },
      },
      "/stats": {
        get: {
          operationId: "livecheckStats",
          summary: "Confirm and Sentinel counts",
          description:
            "Free. Confirm: lead_submit, listing_published, and order_placed rolling counts (false_confirmed_rate is a structured null). paid_calls are intent-scoped confirm-route rows on this machine's volume (store.scope=this_machine_volume); unscoped pre-intent rows are not attributed to lead_submit. Sentinel: active_watchers, checks_run, change_events, by_detector from SQLite; sentinel.benches publishes CI/local gate numbers from bench/sentinel-report.json (status_change/text_diff FP, latency p50/p95, HMAC, chain Verify) with a hardcoded fallback from main 590627c. Not a live dispute rate or 1000-watcher soak. Not a payable route.",
          tags: ["Confirm", "Sentinel"],
          responses: {
            "200": { description: "JSON stats (HTML when Accept: text/html)" },
          },
        },
      },
      "/v1/judge": {
        get: {
          operationId: "confirmJudgeStub",
          summary: "Human review stub",
          description:
            "Not implemented in this phase. Returns 501. Not a payable x402 resource; est_price_usd on next_step is a stub only.",
          tags: ["Confirm"],
          responses: {
            "501": { description: "not_implemented" },
          },
        },
      },
    },
  };
}

/**
 * x402scan DISCOVERY.md compatibility fan-out.
 * resources must be absolute URL strings (not objects) — @agentcash/discovery
 * WellKnownDocSchema is z.array(z.string()).
 * Concrete paid URLs, one fixed accept each: verify $0.01, check $0.02,
 * watch $2.50, watch/renew $2.50, confirm $0.10, confirm/order $0.25.
 * POST /v1/watch/{id}/chain/topup ($0.50) stays on OpenAPI as a path-param
 * implementation detail — listing a literal `{id}` URL makes crawlers probe
 * https://…/v1/watch/{id}/chain/topup and get a 402 with an empty body.
 * Renew is POST /v1/watch/renew with id in the JSON body so the well-known
 * URL stays concrete.
 */
export function wellKnownX402(requestUrl?: string, host?: string): Record<string, unknown> {
  const origin = publicOrigin(requestUrl, host);
  return {
    version: 1,
    x402Version: 2,
    resources: WELL_KNOWN_X402_ROUTES.map((route) => `${origin}${route.path}`),
  };
}

export function openApiPriceAmount(): string {
  return OPENAPI_PRICE_AMOUNT;
}
