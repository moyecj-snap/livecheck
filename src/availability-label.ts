import type { VerifyVerdict } from "./types.js";
import {
  looksLikeWooCommerce,
  lookupWooProduct,
  wooSlugFromUrl,
  wooStoreApiUrl,
} from "./woocommerce.js";
import { jsonLdNotForSaleOnStore } from "./structured-availability.js";

export const AVAILABILITY_LABELS = ["backorder", "in_stores_only"] as const;
export type AvailabilityLabel = (typeof AVAILABILITY_LABELS)[number];

export const AVAILABILITY_LABEL_DESCRIPTION =
  "Optional label adds detail to a live result. backorder: can be ordered now, ships later. in_stores_only: not purchasable online, so agents completing an online purchase should treat it as unavailable.";

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
  "schema_variant_available",
  "schema_variant_unavailable",
  "all_variants_unavailable",
  "linked_variant_unavailable",
  "page_truncated",
]);

const STORE_CTA =
  /\b(?:find\s+(?:a\s+)?stockist|find\s+in\s+store|check\s+store\s+availability)\b/i;

const CHROME_OPEN =
  /<(?:header|nav|footer)\b|id=["']Header(?:Drawer|Menu)-|class=["'][^"']*(?:site-header|header-menu|header-drawer|mega-menu|base-navigation|footer-menu|footer__|site-footer)[^"']*/gi;

/** Class tokens that mean "this control is on the product, not in the chrome." */
const PRODUCT_SCOPE_TOKENS = [
  "product-info",
  "product-info__block",
  "product-details",
  "productview",
  "product-form",
  "product__info",
  "product-single",
  "store-stock-checker",
  "product-main",
  "product-block",
  "js-product",
];

/** Wider product container used when looking for a working Add to cart. */
const PRODUCT_REGION_TOKENS = [
  "product-info",
  "product-details",
  "productview",
  "product-form",
  "product__info",
  "product-single",
  "product-main",
  "js-product",
  "product",
];

const OPEN_TAG = /<(div|section|form|article)\b([^>]*)>/gi;

function classTokens(attrs: string): string[] {
  const raw = /class=["']([^"']*)["']/i.exec(attrs)?.[1] ?? "";
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

function hasToken(attrs: string, tokens: readonly string[]): boolean {
  const set = new Set(classTokens(attrs));
  return tokens.some((token) => set.has(token));
}

function lastOpenWithTokens(html: string, tokens: readonly string[]): number {
  const copy = new RegExp(OPEN_TAG.source, "gi");
  let last = -1;
  for (const match of html.matchAll(copy)) {
    if (hasToken(match[2] ?? "", tokens)) last = match.index ?? last;
  }
  return last;
}

function elementSlice(html: string, openIndex: number): string {
  const open = /^<([a-zA-Z0-9]+)\b[^>]*>/.exec(html.slice(openIndex));
  if (!open) return html.slice(openIndex, openIndex + 12000);
  const tag = open[1];
  const re = new RegExp(`<(/?)(${tag})\\b[^>]*>`, "gi");
  let depth = 0;
  const window = html.slice(openIndex);
  for (const match of window.matchAll(re)) {
    if (match[1] === "/") {
      depth -= 1;
      if (depth === 0) return window.slice(0, (match.index ?? 0) + match[0].length);
    } else {
      depth += 1;
    }
  }
  return window.slice(0, 25000);
}

const ATC_PHRASE = /\badd to (?:cart|bag|basket)\b/i;

type Control = { start: number; tag: string; text: string };

function controls(html: string, tagName: "a" | "button"): Control[] {
  const out: Control[] = [];
  const re = new RegExp(`<${tagName}\\b([^>]*)>([\\s\\S]*?)</${tagName}>`, "gi");
  for (const match of html.matchAll(re)) {
    const attrs = match[1] ?? "";
    const inner = (match[2] ?? "").replace(/<[^>]+>/g, " ");
    const aria = /aria-label=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const text = `${aria} ${inner}`.replace(/\s+/g, " ").trim();
    out.push({ start: match.index ?? 0, tag: attrs, text });
  }
  return out;
}

function lastMatchIndex(re: RegExp, window: string): number {
  const copy = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let last = -1;
  for (const match of window.matchAll(copy)) last = match.index ?? last;
  return last;
}

function scopeBefore(html: string, pos: number): "product" | "chrome" | "unknown" {
  const window = html.slice(Math.max(0, pos - 5000), pos);
  const lastProduct = lastOpenWithTokens(window, PRODUCT_SCOPE_TOKENS);
  const lastChrome = lastMatchIndex(CHROME_OPEN, window);
  if (lastProduct >= 0 && lastProduct > lastChrome) return "product";
  if (lastChrome >= 0 && lastChrome > lastProduct) return "chrome";
  return "unknown";
}

function isDisabled(tag: string, text: string): boolean {
  if (/\sdisabled\b/i.test(tag) || /aria-disabled=["']true["']/i.test(tag)) return true;
  return /\bsold\s*out\b/i.test(text);
}

function hasWorkingAddToCart(region: string): boolean {
  for (const el of [...controls(region, "a"), ...controls(region, "button")]) {
    if (!ATC_PHRASE.test(el.text)) continue;
    if (isDisabled(el.tag, el.text)) continue;
    return true;
  }
  // Submit inputs with an Add to cart value.
  for (const match of region.matchAll(/<input\b([^>]*)>/gi)) {
    const attrs = match[1] ?? "";
    const value = /(?:value|aria-label)=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    if (ATC_PHRASE.test(value) && !isDisabled(attrs, value)) return true;
  }
  return false;
}

function productRegionAround(html: string, pos: number): string {
  const before = html.slice(Math.max(0, pos - 25000), pos);
  const open = lastOpenWithTokens(before, PRODUCT_REGION_TOKENS);
  if (open < 0) return html.slice(Math.max(0, pos - 8000), Math.min(html.length, pos + 4000));
  const start = Math.max(0, pos - 25000) + open;
  return elementSlice(html, start);
}

/** Product-level Find In Store / stockist / store-availability control; never a header or nav link. */
export function hasProductStoreCta(html: string): boolean {
  for (const el of [...controls(html, "a"), ...controls(html, "button")]) {
    if (!STORE_CTA.test(el.text)) continue;
    if (/id=["']Header(?:Drawer|Menu)-/i.test(el.tag)) continue;
    if (scopeBefore(html, el.start) !== "product") continue;
    if (hasWorkingAddToCart(productRegionAround(html, el.start))) continue;
    return true;
  }
  return false;
}

const PRODUCT_VIEW_OPEN = /<div\b[^>]*>/gi;

/** Product markup that marks the item as in-store / not available online. */
export function hasInStoreOnlyProductData(html: string): boolean {
  for (const match of html.matchAll(PRODUCT_VIEW_OPEN)) {
    const tag = match[0];
    const clearanceClass = /class=["'][^"']*productView--clearance-banner[^"']*/i.test(tag);
    const inStoreCategory = /data-product-category=["'][^"']*\bIn Store\b[^"']*/i.test(tag);
    const isProductView = /class=["'][^"']*productView\b[^"']*/i.test(tag);
    if (!isProductView) continue;
    if (!clearanceClass && !inStoreCategory) continue;
    const region = html.slice(match.index ?? 0, (match.index ?? 0) + 20000);
    if (hasWorkingAddToCart(region)) continue;
    return true;
  }
  // Structured offer availability, not a bare dictionary string.
  if (
    /["']availability["']\s*:\s*["']https?:\/\/schema\.org\/InStoreOnly["']/i.test(html) ||
    /availability["']?\s*:\s*["']https?:\/\/schema\.org\/InStoreOnly["']/i.test(html)
  ) {
    return true;
  }
  return false;
}

export function detectInStoresOnly(html: string, pageUrl?: string): boolean {
  if (hasProductStoreCta(html) || hasInStoreOnlyProductData(html)) return true;
  if (pageUrl && jsonLdNotForSaleOnStore(html, pageUrl)) return true;
  return false;
}

export function applyAvailabilityLabel(page: VerifyVerdict, label: AvailabilityLabel): VerifyVerdict {
  if (page.signals.includes("redirected_away_from_product")) return page;
  const rest = page.signals.filter((signal) => !REPLACED.has(signal) && signal !== label);
  return {
    ...page,
    status: "live",
    label,
    confidence: Math.max(page.confidence, 0.9),
    signals: dedupe([label, ...rest]),
  };
}

export async function withAvailabilityLabels(
  requested: string,
  verdict: VerifyVerdict,
  html: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ verdict: VerifyVerdict; ownFieldFound: boolean }> {
  if (verdict.signals.includes("redirected_away_from_product")) {
    return { verdict, ownFieldFound: false };
  }

  const apiUrl = wooStoreApiUrl(verdict.canonical_url) ?? wooStoreApiUrl(requested);
  const slug = wooSlugFromUrl(verdict.canonical_url) ?? wooSlugFromUrl(requested);
  if (apiUrl && slug && looksLikeWooCommerce(html)) {
    const found = await lookupWooProduct(apiUrl, slug, fetcher, signal);
    if (found?.backorder) {
      const next = applyAvailabilityLabel(verdict, "backorder");
      return {
        verdict: found.title ? { ...next, title: found.title } : next,
        ownFieldFound: true,
      };
    }
  }

  if (detectInStoresOnly(html, requested) || detectInStoresOnly(html, verdict.canonical_url)) {
    return { verdict: applyAvailabilityLabel(verdict, "in_stores_only"), ownFieldFound: true };
  }

  return { verdict, ownFieldFound: false };
}
