import { CONFIRM_OUTPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA } from "./bazaar.js";
import {
  OPENAPI_CONFIRM_CLAIM_DESCRIPTION,
  OPENAPI_CONFIRM_DESCRIPTION,
  OPENAPI_CONFIRM_INTENT_DESCRIPTION,
  OPENAPI_CONFIRM_SUMMARY,
  OPENAPI_ORDER_CONFIRM_CLAIM_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_INTENT_DESCRIPTION,
  OPENAPI_ORDER_CONFIRM_SUMMARY,
  VERIFY_DESCRIPTION,
} from "./config.js";
import { publicConfirmOrderUrl, publicConfirmUrl, publicOrigin, publicVerifyUrl } from "./public-url.js";

const OPENAPI_VERSION = "1.0.0";
const OPENAPI_PRICE_AMOUNT = "0.01";
const OPENAPI_CONFIRM_PRICE_AMOUNT = "0.10";
const OPENAPI_ORDER_PLACED_PRICE_AMOUNT = "0.25";

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
              description: "Primary-source live, closed, or unknown verdict",
              content: {
                "application/json": {
                  schema: VERIFY_OUTPUT_SCHEMA,
                },
              },
            },
            "402": {
              description: "Payment Required",
            },
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
              description: "Independent confirmed, failed, or unknown verdict",
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
              description: "Independent confirmed, failed, or unknown verdict",
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
            "Free. Returns the stored receipt, canonical payload, and verify metadata. Unsigned when CONFIRM_RECEIPT_PRIVATE_KEY is unset.",
          tags: ["Confirm"],
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              schema: { type: "string" },
              description: "Confirm id (cfm_ + ULID).",
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
          operationId: "confirmStats",
          summary: "Confirm rolling counts",
          description:
            "Free. lead_submit, listing_published, and order_placed rolling counts. No published false-confirmed rate. Not a payable route.",
          tags: ["Confirm"],
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
 */
export function wellKnownX402(requestUrl?: string, host?: string): Record<string, unknown> {
  return {
    version: 1,
    x402Version: 2,
    resources: [
      publicVerifyUrl(requestUrl, host),
      publicConfirmUrl(requestUrl, host),
      publicConfirmOrderUrl(requestUrl, host),
    ],
  };
}

export function openApiPriceAmount(): string {
  return OPENAPI_PRICE_AMOUNT;
}
