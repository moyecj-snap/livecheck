import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  CHAIN_TOPUP_PRICE_USD,
  CHECK_DESCRIPTION,
  CHECK_PRICE_USD,
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_USD,
  ORDER_PLACED_PRICE_USD,
  PRICE_USD,
  VERIFY_DESCRIPTION,
  WATCH_PRICE_USD,
} from "./config.js";
import { WATCH_HINT_DETECTOR, WATCH_HINT_SUGGEST } from "./watch-hint.js";

/** Paid 200 Verify / Confirm only. Not on 402 bodies or payment-required headers. */
export const WATCH_HINT_SCHEMA = {
  type: "object",
  description:
    "Present on paid 200 responses. Cross-sell hint to POST /v1/watch ($2.50, 30-day standard watcher). Default detector is status_change. Not included on unpaid 402.",
  properties: {
    suggest: { type: "string", enum: [WATCH_HINT_SUGGEST] },
    detector: { type: "string", enum: [WATCH_HINT_DETECTOR] },
    price_usd: { type: "number" },
  },
  required: ["suggest", "detector", "price_usd"],
} as const;

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

/** Paid 200 shape for OpenAPI. Bazaar 402 example stays VERIFY_EXAMPLE (no watch). */
export const VERIFY_PAID_EXAMPLE = {
  ...VERIFY_EXAMPLE,
  watch: {
    suggest: WATCH_HINT_SUGGEST,
    detector: WATCH_HINT_DETECTOR,
    price_usd: WATCH_PRICE_USD,
  },
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
    watch: WATCH_HINT_SCHEMA,
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
        "Absolute http(s) URL of the specific job, product, or eBay item page to check. Not a search-results URL.",
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
  url: "https://example.com/thank-you?ref=ABC123",
  canonical_url: "https://example.com/thank-you?ref=ABC123",
  id: "cfm_01J8Z0K3N4P5Q6R7S8T9V0WXYZ",
  verdict: "confirmed",
  effect: { type: "lead_submit", id: "ABC123" },
  evidence_strength: 2,
  evidence_level: 2,
  confidence: 0.92,
  signals: ["cookieless_fetch", "confirmation_id", "level_2"],
  independent_signals: 1,
  independent_evidence: true,
  evidence_id: "ev_01example",
  http_status: 200,
  fetched_at: "2026-09-06T17:00:00Z",
  price_usd: CONFIRM_PRICE_USD,
  receipt: {
    hash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verify_url: "https://livecheck.fly.dev/v1/receipt/cfm_01J8Z0K3N4P5Q6R7S8T9V0WXYZ",
  },
} as const;

export const CONFIRM_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable confirm id (cfm_ + ULID)." },
    verdict: { type: "string", enum: ["confirmed", "failed", "unknown"] },
    effect: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["lead_submit", "listing_published", "order_placed"] },
        id: { type: "string" },
      },
      required: ["type"],
    },
    evidence_strength: { type: "number", enum: [1, 2] },
    evidence_level: { type: "number", enum: [0, 1, 2, 3, 4] },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    signals: { type: "array", items: { type: "string" } },
    independent_signals: { type: "number" },
    independent_evidence: { type: "boolean" },
    evidence_id: { type: "string" },
    http_status: { type: "number" },
    fetched_at: { type: "string" },
    url: { type: "string" },
    canonical_url: { type: "string" },
    price_usd: { type: "number" },
    receipt: {
      type: "object",
      properties: {
        hash: { type: "string" },
        signature: { type: "string" },
        signer: { type: "string" },
        verify_url: { type: "string" },
      },
      required: ["hash", "verify_url"],
    },
    next_step: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["human_review"] },
        endpoint: { type: "string", enum: ["/v1/judge"] },
        est_price_usd: { type: "number" },
      },
      description: "Present when verdict is unknown. /v1/judge is a 501 stub in this phase and is not payable.",
    },
    watch: WATCH_HINT_SCHEMA,
  },
  required: [
    "id",
    "verdict",
    "effect",
    "evidence_strength",
    "evidence_level",
    "confidence",
    "signals",
    "independent_signals",
    "independent_evidence",
    "evidence_id",
    "http_status",
    "fetched_at",
    "url",
    "canonical_url",
    "price_usd",
    "receipt",
  ],
} as const;

export const CONFIRM_INPUT_SCHEMA = {
  properties: {
    url: {
      type: "string",
      description:
        "Absolute http(s) URL. lead_submit: thank-you or result page. listing_published: specific job, product, or eBay item URL.",
    },
    intent: {
      type: "string",
      enum: ["lead_submit", "listing_published"],
      description:
        "Payable on POST /v1/confirm: lead_submit ($0.10), listing_published ($0.10). listing_published claim.title/sku/id optional. order_placed uses POST /v1/confirm/order.",
    },
    claim: {
      type: "object",
      description:
        "Optional. Not required. lead_submit ignores claim. listing_published: title/sku/id may match or veto; not required for L2.",
    },
  },
  required: ["url", "intent"],
} as const;

export const ORDER_CONFIRM_EXAMPLE = {
  url: "https://shop.example.com/thank-you?order_id=ORD-18421",
  canonical_url: "https://shop.example.com/thank-you?order_id=ORD-18421",
  id: "cfm_01J8Z0K3N4P5Q6R7S8T9V0WORD",
  verdict: "confirmed",
  effect: { type: "order_placed", id: "ORD-18421" },
  evidence_strength: 2,
  evidence_level: 2,
  confidence: 0.9,
  signals: ["cookieless_fetch", "order_id", "level_2"],
  independent_signals: 1,
  independent_evidence: true,
  evidence_id: "ev_01order",
  http_status: 200,
  fetched_at: "2026-09-06T17:00:00Z",
  price_usd: ORDER_PLACED_PRICE_USD,
  receipt: {
    hash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    verify_url: "https://livecheck.fly.dev/v1/receipt/cfm_01J8Z0K3N4P5Q6R7S8T9V0WORD",
  },
} as const;

export const ORDER_CONFIRM_INPUT_SCHEMA = {
  properties: {
    url: {
      type: "string",
      description: "Absolute http(s) URL of the thank-you / confirmation / order-status page after checkout.",
    },
    intent: {
      type: "string",
      enum: ["order_placed"],
      description: "Payable on POST /v1/confirm/order: order_placed ($0.25).",
    },
    claim: {
      type: "object",
      description:
        "Optional. Not required. order_id/total/email_domain may match or veto; never invents ids.",
    },
  },
  required: ["url", "intent"],
} as const;

/** Verify-shaped Bazaar: POST JSON + method, same wrapper as /v1/verify. */
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

export function orderConfirmBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: { url: ORDER_CONFIRM_EXAMPLE.url, intent: "order_placed" },
      inputSchema: ORDER_CONFIRM_INPUT_SCHEMA,
      output: {
        example: ORDER_CONFIRM_EXAMPLE,
        schema: CONFIRM_OUTPUT_SCHEMA,
      },
    }),
  );
}

export const CONFIRM_ROUTE_DESCRIPTION = CONFIRM_DESCRIPTION;

export const CHECK_EXAMPLE = {
  id: "chk_01J8Z0K3N4P5Q6R7S8T9V0WCHK",
  target: {
    type: "url",
    url: "https://boards.greenhouse.io/example/jobs/1842",
    render: "never",
    selector: null,
  },
  condition: { detector: "status_change", params: {} },
  observation: {
    status: "live",
    signals: ["apply form present", "no closure banner"],
    http_status: 200,
    http_class: "2xx",
    hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    summary: "live 2xx (200); apply form present, no closure banner",
    checked_at: "2026-09-10T18:00:00Z",
    canonical_url: "https://boards.greenhouse.io/example/jobs/1842",
    title: "Staff Backend Engineer — Northwind Labs",
  },
  fired: null,
  confidence: 0.82,
  price_usd: CHECK_PRICE_USD,
  receipt: {
    hash: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    verify_url: "https://livecheck.fly.dev/v1/receipt/chk_01J8Z0K3N4P5Q6R7S8T9V0WCHK",
  },
} as const;

export const CHECK_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable check id (chk_ + ULID)." },
    target: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["url"] },
        url: { type: "string" },
        render: { type: "string", enum: ["never"] },
        selector: { type: ["string", "null"] },
      },
      required: ["type", "url", "render"],
    },
    condition: {
      type: "object",
      properties: {
        detector: { type: "string", enum: ["status_change", "keyword", "text_diff", "numeric_threshold"] },
        params: { type: "object" },
      },
      required: ["detector"],
    },
    observation: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["live", "closed", "unknown"] },
        signals: { type: "array", items: { type: "string" } },
        http_status: { type: "number" },
        http_class: { type: "string" },
        hash: { type: "string" },
        summary: { type: "string" },
        checked_at: { type: "string" },
        canonical_url: { type: "string" },
        title: { type: "string" },
      },
      required: ["status", "signals", "http_status", "http_class", "hash", "summary"],
    },
    fired: { type: ["boolean", "null"] },
    confidence: { type: "number" },
    price_usd: { type: "number" },
    receipt: {
      type: "object",
      properties: {
        hash: { type: "string" },
        signature: { type: "string" },
        signer: { type: "string" },
        verify_url: { type: "string" },
      },
      required: ["hash", "verify_url"],
    },
  },
  required: ["id", "target", "condition", "observation", "fired", "confidence", "price_usd", "receipt"],
} as const;

export const CHECK_INPUT_SCHEMA = {
  properties: {
    target: {
      type: "object",
      description: "URL target. type=url, render=never. selector optional.",
    },
    condition: {
      type: "object",
      description:
        "detector status_change, keyword, text_diff, or numeric_threshold. text_diff: selector?, ignore[], min_change_ratio. numeric_threshold: selector or jsonpath, op, value, currency?",
    },
    baseline_hash: {
      type: ["string", "null"],
      description: "Prior observation.hash for status_change. Omit or null on first check.",
    },
  },
  required: ["target", "condition"],
} as const;

/** Verify-shaped Bazaar only — same POST JSON wrapper as /v1/verify. Not a fat Confirm bazaar. */
export function checkBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: {
        target: CHECK_EXAMPLE.target,
        condition: CHECK_EXAMPLE.condition,
        baseline_hash: null,
      },
      inputSchema: CHECK_INPUT_SCHEMA,
      output: {
        example: CHECK_EXAMPLE,
        schema: CHECK_OUTPUT_SCHEMA,
      },
    }),
  );
}

export const CHECK_ROUTE_DESCRIPTION = CHECK_DESCRIPTION;

export const WATCH_EXAMPLE = {
  id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC",
  tier: "standard",
  status: "active",
  owner_token: "owt_01J8Z0K3N4P5Q6R7S8T9V0WOWT",
  expires_at: "2026-10-10T18:00:00Z",
  checks_remaining: 2880,
  interval_s: 900,
  first_check_at: "2026-09-10T18:00:00Z",
  next_check_at: "2026-09-10T18:15:00Z",
  baseline: {
    captured: true,
    hash: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    summary: "live 2xx (200); apply form present, no closure banner",
  },
  target: CHECK_EXAMPLE.target,
  condition: CHECK_EXAMPLE.condition,
  price_usd: WATCH_PRICE_USD,
  run: "none",
  receipt: {
    hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    verify_url: "https://livecheck.fly.dev/v1/receipt/wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC",
  },
} as const;

export const WATCH_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Stable watcher id (wtc_ + ULID)." },
    tier: { type: "string", enum: ["standard"] },
    status: { type: "string", enum: ["active", "stopped", "expired"] },
    owner_token: { type: "string", description: "Returned once on create. Send as X-Livecheck-Owner-Token." },
    expires_at: { type: "string" },
    checks_remaining: { type: "number" },
    interval_s: { type: "number" },
    first_check_at: { type: "string" },
    next_check_at: { type: "string" },
    baseline: {
      type: "object",
      properties: {
        captured: { type: "boolean" },
        hash: { type: "string" },
        summary: { type: "string" },
      },
      required: ["captured"],
    },
    target: CHECK_OUTPUT_SCHEMA.properties.target,
    condition: CHECK_OUTPUT_SCHEMA.properties.condition,
    price_usd: { type: "number" },
    run: { type: "string", enum: ["none", "verify", "confirm"] },
    on_change: {
      type: "object",
      properties: {
        run: { type: "string", enum: ["none", "verify", "confirm"] },
        intent: { type: "string", enum: ["lead_submit", "listing_published", "order_placed"] },
        url: { type: "string" },
      },
    },
    chain_budget_usd: { type: ["number", "null"] },
    chain_balance_usd: { type: "number" },
    receipt: CHECK_OUTPUT_SCHEMA.properties.receipt,
  },
  required: [
    "id",
    "tier",
    "owner_token",
    "expires_at",
    "checks_remaining",
    "interval_s",
    "first_check_at",
    "baseline",
    "price_usd",
    "receipt",
  ],
} as const;

export const WATCH_INPUT_SCHEMA = {
  properties: {
    target: {
      type: "object",
      description: "URL target. type=url, render=never. render=always is 400 render_not_available.",
    },
    condition: {
      type: "object",
      description: "detector status_change, keyword, text_diff, or numeric_threshold. Same as POST /v1/check.",
    },
    callback: {
      type: "object",
      description: "url + secret. deliver=on_change or every_check. HMAC-SHA256 over the raw JSON body (X-Sentinel-Signature).",
    },
    interval_s: {
      type: "number",
      description: "Seconds between observations. Min 300, default 900.",
    },
    label: { type: "string" },
    context: { type: "object" },
    chain_budget_usd: {
      type: "number",
      description:
        "Spend cap for chained Verify ($0.01) and Confirm ($0.10 / $0.25). Funding is POST /v1/watch/{id}/chain/topup ($0.50), not bundled into $2.50.",
    },
    on_change: {
      type: "object",
      description:
        "run=none (default), verify, or confirm. confirm default intent=lead_submit ($0.10 internal). Optional intent/url/claim.",
    },
  },
  required: ["target", "condition", "callback"],
} as const;

export const CHAIN_TOPUP_EXAMPLE = {
  id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC",
  added_usd: CHAIN_TOPUP_PRICE_USD,
  chain_balance_usd: CHAIN_TOPUP_PRICE_USD,
  chain_budget_usd: 5,
  price_usd: CHAIN_TOPUP_PRICE_USD,
  run: "verify",
} as const;

export const CHAIN_TOPUP_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Watcher id (wtc_ + ULID)." },
    added_usd: { type: "number" },
    chain_balance_usd: { type: "number" },
    chain_budget_usd: { type: ["number", "null"] },
    price_usd: { type: "number" },
    run: { type: "string", enum: ["none", "verify", "confirm"] },
  },
  required: ["id", "added_usd", "chain_balance_usd", "price_usd", "run"],
} as const;

export const CHAIN_TOPUP_INPUT_SCHEMA = {
  properties: {},
  required: [] as string[],
} as const;

/** Slim verify-shaped Bazaar. Hold Bazaar GA — not a marketing listing. */
export function chainTopupBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: {},
      inputSchema: CHAIN_TOPUP_INPUT_SCHEMA,
      output: {
        example: CHAIN_TOPUP_EXAMPLE,
        schema: CHAIN_TOPUP_OUTPUT_SCHEMA,
      },
    }),
  );
}

export const WATCH_RENEW_EXAMPLE = {
  id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC",
  tier: "standard",
  status: "active",
  expires_at: "2026-11-09T18:00:00Z",
  checks_remaining: 5760,
  interval_s: 900,
  first_check_at: "2026-09-10T18:00:00Z",
  next_check_at: "2026-09-10T18:15:00Z",
  baseline: WATCH_EXAMPLE.baseline,
  target: WATCH_EXAMPLE.target,
  condition: WATCH_EXAMPLE.condition,
  price_usd: WATCH_PRICE_USD,
  run: "none",
  on_change: { run: "none" },
  chain_budget_usd: null,
  chain_balance_usd: 0,
  receipt: {
    hash: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    verify_url: "https://livecheck.fly.dev/v1/receipt/wrn_01J8Z0K3N4P5Q6R7S8T9V0WWRN",
  },
} as const;

export const WATCH_RENEW_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "Watcher id (wtc_ + ULID). Unchanged on renew." },
    tier: { type: "string", enum: ["standard"] },
    status: { type: "string", enum: ["active", "stopped", "expired"] },
    expires_at: { type: "string" },
    checks_remaining: { type: "number" },
    interval_s: { type: "number" },
    first_check_at: { type: "string" },
    next_check_at: { type: "string" },
    baseline: WATCH_OUTPUT_SCHEMA.properties.baseline,
    target: CHECK_OUTPUT_SCHEMA.properties.target,
    condition: CHECK_OUTPUT_SCHEMA.properties.condition,
    price_usd: { type: "number" },
    run: { type: "string", enum: ["none", "verify"] },
    on_change: WATCH_OUTPUT_SCHEMA.properties.on_change,
    chain_budget_usd: { type: ["number", "null"] },
    chain_balance_usd: { type: "number" },
    receipt: CHECK_OUTPUT_SCHEMA.properties.receipt,
  },
  required: [
    "id",
    "tier",
    "expires_at",
    "checks_remaining",
    "interval_s",
    "first_check_at",
    "baseline",
    "price_usd",
    "receipt",
  ],
} as const;

export const WATCH_RENEW_INPUT_SCHEMA = {
  properties: {
    id: {
      type: "string",
      description: "Watcher id (wtc_ + ULID). In the JSON body so the well-known URL stays concrete.",
    },
  },
  required: ["id"],
} as const;

/** Slim verify-shaped Bazaar for renew. Does not change watch-create bazaar copy. */
export function watchRenewBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: { id: WATCH_RENEW_EXAMPLE.id },
      inputSchema: WATCH_RENEW_INPUT_SCHEMA,
      output: {
        example: WATCH_RENEW_EXAMPLE,
        schema: WATCH_RENEW_OUTPUT_SCHEMA,
      },
    }),
  );
}

/**
 * Rich watch discovery declaration. Not attached to the POST /v1/watch 402 or
 * the facilitator verify/settle envelope until settle is proven — the fat
 * schema breaks purl→CDP the same way Confirm did before b7ab919.
 * OpenAPI still uses WATCH_OUTPUT_SCHEMA.
 */
export function watchBazaarExtensions(): Record<string, unknown> {
  return withPostJsonMethod(
    declareDiscoveryExtension({
      bodyType: "json",
      input: {
        target: WATCH_EXAMPLE.target,
        condition: WATCH_EXAMPLE.condition,
        callback: {
          url: "https://example.com/hooks/livecheck",
          secret: "whsec_example",
          deliver: "on_change",
        },
        interval_s: 900,
      },
      inputSchema: WATCH_INPUT_SCHEMA,
      output: {
        example: WATCH_EXAMPLE,
        schema: WATCH_OUTPUT_SCHEMA,
      },
    }),
  );
}
