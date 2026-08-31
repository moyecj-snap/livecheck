import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { PRICE_USD, VERIFY_DESCRIPTION } from "./config.js";

export const VERIFY_EXAMPLE = {
  url: "https://boards.greenhouse.io/example/jobs/1842",
  canonical_url: "https://boards.greenhouse.io/example/jobs/1842",
  status: "live",
  http_status: 200,
  checked_at: "2026-08-30T21:00:00Z",
  title: "Staff Backend Engineer — Northwind Labs",
  signals: ["apply form present", "no closure banner"],
  confidence: 0.82,
  price_usd: PRICE_USD,
} as const;

export const VERIFY_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    canonical_url: { type: "string" },
    status: { type: "string", enum: ["live", "closed", "unknown"] },
    http_status: { type: "number" },
    checked_at: { type: "string" },
    title: { type: "string" },
    signals: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    price_usd: { type: "number" },
  },
  required: [
    "url",
    "canonical_url",
    "status",
    "http_status",
    "checked_at",
    "signals",
    "confidence",
    "price_usd",
  ],
} as const;

export const VERIFY_INPUT_SCHEMA = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description:
        "Absolute http(s) URL of the specific product or job page to check. Not a search-results URL.",
    },
  },
  required: ["url"],
} as const;

/**
 * x402 v2 Bazaar declaration (Coinbase seller docs).
 * `discoverable: true` is a v1 field and is rejected on v2 — listing is this extension.
 */
export function verifyBazaarExtensions(): Record<string, unknown> {
  return {
    ...declareDiscoveryExtension({
      bodyType: "json",
      input: { url: VERIFY_EXAMPLE.url },
      inputSchema: VERIFY_INPUT_SCHEMA,
      output: {
        example: VERIFY_EXAMPLE,
        schema: VERIFY_OUTPUT_SCHEMA,
      },
    }),
  };
}

export const VERIFY_ROUTE_DESCRIPTION = VERIFY_DESCRIPTION;
