import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { CONFIRM_DESCRIPTION, CONFIRM_PRICE_USD, PRICE_USD, VERIFY_DESCRIPTION } from "./config.js";

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

/** Body JSON Schema only — goodsong.dev/verify/url omits a wrapper `type`. */
export const VERIFY_INPUT_SCHEMA = {
  properties: {
    url: {
      type: "string",
      description:
        "Absolute http(s) URL of the specific product or job page to check. Not a search-results URL.",
    },
  },
  required: ["url"],
} as const;

type BazaarDeclaration = {
  info?: {
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
  };
  schema?: {
    properties?: {
      input?: {
        properties?: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
        type?: string;
      };
    };
  };
};

/**
 * declareDiscoveryExtension({ bodyType: "json" }) writes info.input as
 * { type, bodyType, body } and omits method. schema.properties.input.required
 * is ["type","method","bodyType","body"]. AJV: "/input: must have required
 * property 'method'". bazaarResourceServerExtension.enrichDeclaration adds
 * method from the HTTP request on the 402 only. Settle backfill injects this
 * object without that enricher — CDP then rejects "invalid discovery
 * configuration". goodsong.dev/verify/url (indexed) has method: "POST".
 */
function withPostJsonMethod(declared: Record<string, unknown>): Record<string, unknown> {
  const bazaar = (declared.bazaar ?? declared) as BazaarDeclaration;
  const input = { ...(bazaar.info?.input ?? {}) };
  input.type = "http";
  input.method = "POST";
  input.bodyType = "json";
  const inputSchema = bazaar.schema?.properties?.input ?? {};
  const inputProps = { ...(inputSchema.properties ?? {}) };
  inputProps.method = { type: "string", enum: ["POST"] };
  const required = ["type", "method", "bodyType", "body"];
  const nextBazaar: BazaarDeclaration = {
    ...bazaar,
    info: {
      ...bazaar.info,
      input,
    },
    schema: {
      ...bazaar.schema,
      properties: {
        ...bazaar.schema?.properties,
        input: {
          type: "object",
          additionalProperties: false,
          ...inputSchema,
          properties: inputProps,
          required,
        },
      },
    },
  };
  return { bazaar: nextBazaar };
}

/**
 * x402 v2 Bazaar declaration (Coinbase seller docs).
 * `discoverable: true` is a v1 field and is rejected on v2 — listing is this extension.
 */
export function verifyBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: { url: VERIFY_EXAMPLE.url },
      inputSchema: VERIFY_INPUT_SCHEMA,
      output: {
        example: VERIFY_EXAMPLE,
        schema: VERIFY_OUTPUT_SCHEMA,
      },
    }),
  );
}

export const VERIFY_ROUTE_DESCRIPTION = VERIFY_DESCRIPTION;

export const CONFIRM_EXAMPLE = {
  url: "https://example.com/contact/thanks",
  canonical_url: "https://example.com/contact/thanks",
  status: "confirmed",
  intent: "lead_submit",
  http_status: 200,
  checked_at: "2026-09-06T21:00:00Z",
  title: "Thank you — Northwind Labs",
  signals: ["level2_confirmation_id:CNF-1842"],
  confidence: 0.9,
  price_usd: CONFIRM_PRICE_USD,
  evidence: { level: 2, confirmation_id: "CNF-1842", kind: "confirmation_id" },
} as const;

export const CONFIRM_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    canonical_url: { type: "string" },
    status: { type: "string", enum: ["confirmed", "failed", "unknown"] },
    intent: { type: "string", enum: ["lead_submit"] },
    http_status: { type: "number" },
    checked_at: { type: "string" },
    title: { type: "string" },
    signals: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    price_usd: { type: "number" },
    evidence: { type: "object" },
  },
  required: [
    "url",
    "canonical_url",
    "status",
    "intent",
    "http_status",
    "checked_at",
    "signals",
    "confidence",
    "price_usd",
    "evidence",
  ],
} as const;

export const CONFIRM_INPUT_SCHEMA = {
  properties: {
    url: {
      type: "string",
      description: "Absolute http(s) URL of the thank-you or result page after lead_submit.",
    },
    intent: {
      type: "string",
      enum: ["lead_submit"],
      description: "Day-1 Confirm intent. Only lead_submit is accepted.",
    },
  },
  required: ["url", "intent"],
} as const;

export function confirmBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: { url: CONFIRM_EXAMPLE.url, intent: "lead_submit" },
      inputSchema: CONFIRM_INPUT_SCHEMA,
      output: {
        example: CONFIRM_EXAMPLE,
        schema: CONFIRM_OUTPUT_SCHEMA,
      },
    }),
  );
}

export const CONFIRM_ROUTE_DESCRIPTION = CONFIRM_DESCRIPTION;
