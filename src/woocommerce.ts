import { USER_AGENT } from "./config.js";
import { DeadlineError } from "./deadline.js";

/**
 * WooCommerce Store API product lookup. The structured `is_on_backorder` flag
 * (or `stock_availability.class` = available-on-backorder) is the only
 * backorder signal we trust. HTML phrases such as "Available on backorder"
 * are ignored: they also appear in cart templates on in-stock products.
 */

const WOO_PATH = /\/(?:product|shop)\/([^/]+?)\/?$/i;

export function wooStoreApiUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const match = url.pathname.match(WOO_PATH);
  const slug = match?.[1];
  if (!slug) return null;
  let decoded = slug;
  try {
    decoded = decodeURIComponent(slug);
  } catch {
    decoded = slug;
  }
  if (!decoded || decoded === "." || decoded === "..") return null;
  return `${url.origin}/wp-json/wc/store/v1/products?slug=${encodeURIComponent(decoded)}`;
}

export function looksLikeWooCommerce(html: string): boolean {
  return /\bwoocommerce\b/i.test(html) || /wp-json\/wc(?:\/|")/i.test(html) || /\bwc-block(?:s|s-)/i.test(html);
}

export type WooBackorderReading = {
  backorder: boolean;
  title?: string;
};

type WooStockAvailability = { class?: unknown; text?: unknown };
type WooProduct = {
  slug?: unknown;
  name?: unknown;
  is_on_backorder?: unknown;
  stock_availability?: WooStockAvailability;
};

function isOnBackorder(product: WooProduct): boolean {
  if (product.is_on_backorder === true) return true;
  const cls = product.stock_availability?.class;
  return typeof cls === "string" && cls === "available-on-backorder";
}

/** Pick the Store API item that matches `slug`; require an exact slug when several are returned. */
export function readingFromWooProducts(data: unknown, slug: string): WooBackorderReading | null {
  if (!Array.isArray(data)) return null;
  const products = data.filter((item): item is WooProduct => item !== null && typeof item === "object");
  if (products.length === 0) return null;
  const exact = products.filter((p) => typeof p.slug === "string" && p.slug === slug);
  // Several hits: only an exact single slug match is used. A lone unmatched
  // item is used only when the list has exactly one product.
  const product = exact.length === 1 ? exact[0] : exact.length === 0 && products.length === 1 ? products[0] : null;
  if (!product) return null;
  const title = typeof product.name === "string" && product.name.trim() ? product.name.trim() : undefined;
  return { backorder: isOnBackorder(product), ...(title ? { title } : {}) };
}

export async function lookupWooProduct(
  apiUrl: string,
  slug: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<WooBackorderReading | null> {
  try {
    const response = await fetcher(apiUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!response.ok) return null;
    const data: unknown = await response.json();
    return readingFromWooProducts(data, slug);
  } catch (error) {
    if (error instanceof DeadlineError || signal?.aborted) throw error;
    return null;
  }
}

export function wooSlugFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    const match = url.pathname.match(WOO_PATH);
    const slug = match?.[1];
    if (!slug) return null;
    try {
      return decodeURIComponent(slug);
    } catch {
      return slug;
    }
  } catch {
    return null;
  }
}
