import { USER_AGENT } from "./config.js";
import { DeadlineError } from "./deadline.js";
import type { VerifyVerdict } from "./types.js";

/**
 * Shopify product JSON. `https://store/products/{handle}.js` is public and
 * includes `available`, which is true when any variant can be bought.
 * A missing or non-Shopify response leaves the HTML verdict alone.
 */

export function shopifyProductJsUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const match = url.pathname.match(/\/products\/([^/]+?)(?:\.js)?\/?$/i);
  const handle = match?.[1];
  if (!handle) return null;
  let decoded = handle;
  try {
    decoded = decodeURIComponent(handle);
  } catch {
    decoded = handle;
  }
  if (!decoded || decoded === "." || decoded === "..") return null;
  return `${url.origin}/products/${encodeURIComponent(decoded)}.js`;
}

export type ShopifyAvailability = { available: boolean; title?: string };

export async function lookupShopifyAvailable(
  jsUrl: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ShopifyAvailability | null> {
  try {
    const response = await fetcher(jsUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { available?: unknown; title?: unknown };
    if (typeof data.available !== "boolean") return null;
    return {
      available: data.available,
      ...(typeof data.title === "string" && data.title.trim() ? { title: data.title.trim() } : {}),
    };
  } catch (error) {
    if (error instanceof DeadlineError || signal?.aborted) throw error;
    return null;
  }
}

function dedupe(signals: string[]): string[] {
  const out: string[] = [];
  for (const signal of signals) if (!out.includes(signal)) out.push(signal);
  return out;
}

const REPLACED = new Set([
  "sold-out",
  "in-stock",
  "ambiguous_html",
  "js_shell",
  "challenge_page",
  "shopify_available",
  "shopify_unavailable",
]);

/** The .js `available` field decides. HTML sold-out / in-stock signals are replaced. */
export function applyShopifyAvailability(page: VerifyVerdict, found: ShopifyAvailability): VerifyVerdict {
  const rest = page.signals.filter((signal) => !REPLACED.has(signal));
  if (found.available) {
    return {
      ...page,
      status: "live",
      confidence: Math.max(page.confidence, 0.9),
      ...(found.title ? { title: found.title } : {}),
      signals: dedupe(["shopify_available", "in-stock", ...rest]),
    };
  }
  return {
    ...page,
    status: "closed",
    confidence: Math.max(page.confidence, 0.9),
    ...(found.title ? { title: found.title } : {}),
    signals: dedupe(["shopify_unavailable", "sold-out", ...rest]),
  };
}
