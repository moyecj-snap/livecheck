import { originOnly } from "./public-url.js";

export const DEFAULT_LIVECHECK_ORIGIN = "http://127.0.0.1:43127";
export const DEFAULT_LIVECHECK_URL = `${DEFAULT_LIVECHECK_ORIGIN}/v1/verify`;

export type PaymentRequiredChallenge = {
  paid: false;
  http: 402;
  [field: string]: unknown;
};

export type LivecheckRequestOptions = {
  origin?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  paymentSignature?: string;
  ownerToken?: string;
  env?: NodeJS.ProcessEnv;
};

export type CheckToolBody = {
  target: { type?: "url"; url: string; render?: "never"; selector?: string | null };
  condition: { detector: string; params?: Record<string, unknown> };
  baseline_hash?: string | null;
  baseline_text?: string | null;
  baseline_value?: number | null;
};

export type ConfirmToolBody = {
  url: string;
  intent: "lead_submit" | "listing_published" | "order_placed";
  claim?: Record<string, unknown>;
};

export type WatchToolBody = {
  target: CheckToolBody["target"];
  condition: CheckToolBody["condition"];
  callback: { url: string; secret: string; deliver?: "on_change" | "every_check" };
  interval_s?: number;
  label?: string;
  context?: Record<string, unknown>;
  on_change?: { run?: "none" | "verify" };
  chain_budget_usd?: number | null;
};

export function livecheckConfiguredUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.LIVECHECK_URL?.trim() || DEFAULT_LIVECHECK_URL;
}

/** Origin for check / confirm / watch. Existing mcp.json may still point at /v1/verify. */
export function livecheckOrigin(env: NodeJS.ProcessEnv = process.env): string {
  return originOnly(livecheckConfiguredUrl(env)) || DEFAULT_LIVECHECK_ORIGIN;
}

export function livecheckVerifyUrl(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.LIVECHECK_URL?.trim();
  if (!configured) return DEFAULT_LIVECHECK_URL;
  if (/\/v1\/verify\/?$/i.test(configured)) return configured.replace(/\/+$/, "");
  return `${originOnly(configured)}/v1/verify`;
}

export function livecheckPathUrl(path: string, env: NodeJS.ProcessEnv = process.env): string {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return `${livecheckOrigin(env)}${normalized}`;
}

/** order_placed is a separate Fly resource so the 402 stays one price. */
export function confirmRoutePath(intent: ConfirmToolBody["intent"]): "/v1/confirm" | "/v1/confirm/order" {
  return intent === "order_placed" ? "/v1/confirm/order" : "/v1/confirm";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function decodePaymentRequiredHeader(header: string | null): Record<string, unknown> | null {
  if (!header?.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function paymentRequiredResult(
  header: string | null,
  bodyText: string,
): PaymentRequiredChallenge {
  const decoded = decodePaymentRequiredHeader(header) ?? parseJsonObject(bodyText) ?? {};
  return { ...decoded, paid: false, http: 402 };
}

export function resolvePaymentSignature(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const fromArg = explicit?.trim();
  if (fromArg) return fromArg;
  const fromEnv = env.LIVECHECK_PAYMENT_SIGNATURE?.trim();
  return fromEnv || undefined;
}

function requestHeaders(options: LivecheckRequestOptions, env: NodeJS.ProcessEnv): Headers {
  const headers = new Headers({
    accept: "application/json",
    "content-type": "application/json",
  });
  const signature = resolvePaymentSignature(options.paymentSignature, env);
  if (signature) {
    headers.set("payment-signature", signature);
    headers.set("x-payment", signature);
  }
  const owner = options.ownerToken?.trim();
  if (owner) headers.set("x-livecheck-owner-token", owner);
  return headers;
}

export async function livecheckRequest(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, string | number | undefined>;
  } & LivecheckRequestOptions = {},
): Promise<unknown> {
  const env = init.env ?? process.env;
  const fetcher = init.fetchImpl ?? fetch;
  const endpoint =
    init.endpoint ??
    (() => {
      const url = new URL(livecheckPathUrl(path, env));
      for (const [key, value] of Object.entries(init.query ?? {})) {
        if (value === undefined || value === "") continue;
        url.searchParams.set(key, String(value));
      }
      return url.toString();
    })();

  const response = await fetcher(endpoint, {
    method: init.method ?? "POST",
    headers: requestHeaders(init, env),
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });

  const text = await response.text();

  if (response.status === 402) {
    return paymentRequiredResult(response.headers.get("payment-required"), text);
  }

  if (response.status === 200 || response.status === 201) {
    const json = parseJsonObject(text);
    if (!json) {
      throw new Error(`Livecheck returned HTTP ${response.status} with a non-JSON body.`);
    }
    return json;
  }

  const body = parseJsonObject(text);
  const error = new Error(`Livecheck returned HTTP ${response.status}.`);
  (error as Error & { http: number; body: unknown }).http = response.status;
  (error as Error & { http: number; body: unknown }).body = body ?? text;
  throw error;
}

export async function verifyListing(
  url: string,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest("/v1/verify", {
    ...options,
    endpoint: options.endpoint ?? livecheckVerifyUrl(options.env),
    body: { url },
  });
}

export async function checkListing(
  body: CheckToolBody,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest("/v1/check", { ...options, body });
}

export async function confirmListing(
  body: ConfirmToolBody,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest(confirmRoutePath(body.intent), { ...options, body });
}

export async function watchListing(
  body: WatchToolBody,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest("/v1/watch", { ...options, body });
}

export async function watchGet(
  id: string,
  ownerToken: string,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest(`/v1/watch/${encodeURIComponent(id)}`, {
    ...options,
    method: "GET",
    ownerToken,
  });
}

export async function watchEvents(
  id: string,
  ownerToken: string,
  query: { limit?: number; cursor?: string } = {},
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest(`/v1/watch/${encodeURIComponent(id)}/events`, {
    ...options,
    method: "GET",
    ownerToken,
    query,
  });
}

export async function watchStop(
  id: string,
  ownerToken: string,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest(`/v1/watch/${encodeURIComponent(id)}`, {
    ...options,
    method: "DELETE",
    ownerToken,
  });
}

export async function watchChainTopup(
  id: string,
  ownerToken: string,
  options: LivecheckRequestOptions = {},
): Promise<unknown> {
  return livecheckRequest(`/v1/watch/${encodeURIComponent(id)}/chain/topup`, {
    ...options,
    method: "POST",
    ownerToken,
    body: {},
  });
}
