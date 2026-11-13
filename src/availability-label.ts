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

/** Product copy that means the listing itself is gone, not merely sold out. */
export const NO_LONGER_AVAILABLE_SIGNAL = "no_longer_available";

const PRODUCT_NO_LONGER_AVAILABLE = [
  "this product is no longer available",
  "product is no longer available",
];

function stripScriptsAndStyles(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, " ");
}

/** Drop elements marked hidden so a template "no longer available" line is ignored. */
function stripHiddenElements(html: string): string {
  let previous = "";
  let current = html;
  // Repeat so nested hidden wrappers are removed.
  for (let i = 0; i < 4 && current !== previous; i++) {
    previous = current;
    current = current
      .replace(/<([a-zA-Z][\w:-]*)\b[^>]*\shidden(?:\s|\/|=|>)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<([a-zA-Z][\w:-]*)\b[^>]*class=["'][^"']*\bhidden\b[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<([a-zA-Z][\w:-]*)\b[^>]*aria-hidden=["']true["'][^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<([a-zA-Z][\w:-]*)\b[^>]*style=["'][^"']*display\s*:\s*none[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi, " ");
  }
  return current;
}


const WOO_NON_SUMMARY_ATTR =
  /\b(?:related[\s_-]*products?|upsells?|cross-?sells?|you-may-also|mini-cart|shopping-cart|widget_shopping_cart|wc-block-mini-cart|wc-block-cart(?:-item|-items)?\b|woocommerce-mini-cart|woocommerce-tabs|\bwc-tabs\b|product-tabs|wp-block-woocommerce-related-products)\b/i;

function findMatchingClose(html: string, from: number, tag: string): number {
  const openRe = new RegExp(`<${tag}\\b[^>]*>`, "gi");
  const closeRe = new RegExp(`</${tag}\\s*>`, "gi");
  let depth = 1;
  let i = from;
  while (i < html.length && depth > 0) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const open = openRe.exec(html);
    const close = closeRe.exec(html);
    if (!close) return html.length;
    if (open && open.index < close.index) {
      if (!open[0].endsWith("/>")) depth += 1;
      i = open.index + open[0].length;
    } else {
      depth -= 1;
      i = close.index + close[0].length;
    }
  }
  return i;
}

function isVoidOrSelfClosing(tag: string, open: string): boolean {
  return (
    open.endsWith("/>") ||
    /^(?:area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i.test(tag)
  );
}

/** Drop cart, related, tab, and footer regions so only the product's own summary remains. */
function stripWooNonSummaryRegions(html: string): string {
  let i = 0;
  let out = "";
  while (i < html.length) {
    const match = html.slice(i).match(/<([a-zA-Z][\w:-]*)\b[^>]*>/);
    if (!match || match.index === undefined) {
      out += html.slice(i);
      break;
    }
    const tag = match[1];
    const open = match[0];
    const start = i + match.index;
    out += html.slice(i, start);
    const drop =
      /^(?:footer|aside)$/i.test(tag) ||
      (!/add-to-cart-form/i.test(open) && WOO_NON_SUMMARY_ATTR.test(open));
    if (drop) {
      if (isVoidOrSelfClosing(tag, open)) {
        i = start + open.length;
      } else {
        i = findMatchingClose(html, start + open.length, tag);
      }
      out += " ";
      continue;
    }
    out += open;
    i = start + open.length;
  }
  return out;
}

const WOO_SUMMARY_BACKORDER_ELEMENT =
  /<p\b[^>]*class=["'][^"']*\bstock\b[^"']*\bavailable-on-backorder\b[^"']*["'][^>]*>|<p\b[^>]*class=["'][^"']*\bavailable-on-backorder\b[^"']*\bstock\b[^"']*["'][^>]*>|product-stock-indicator--available-on-backorder/i;

/**
 * True when WooCommerce's own stock-status element, inside the main product
 * summary, marks the product as available on backorder. Loose "Available on
 * backorder" text in related products, tabs, footers, cart badges, or scripts
 * does not count.
 */
export function hasWooProductSummaryBackorder(html: string): boolean {
  const region = stripWooNonSummaryRegions(stripScriptsAndStyles(html));
  return WOO_SUMMARY_BACKORDER_ELEMENT.test(region);
}

/** An explicit, visible "this product is no longer available" message. Hidden templates do not count. */
export function hasVisibleProductNoLongerAvailable(html: string): boolean {
  const visible = stripHiddenElements(stripScriptsAndStyles(html))
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|#160|#x0*a0);/gi, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return PRODUCT_NO_LONGER_AVAILABLE.some((phrase) => visible.includes(phrase));
}


const HIDDEN_NLA_BOX =
  /<(?:div|section|aside)\b[^>]*class=["'][^"']*(?:\bhidden\b[^"']*\boutofstock-cta\b|\boutofstock-cta\b[^"']*\bhidden\b)[^"']*["'][^>]*>[\s\S]{0,2000}?(?:this product is no longer available|product is no longer available)/i;

/** A hidden "no longer available" box (for example div.outofstock-cta.hidden). */
export function hasHiddenProductNoLongerAvailableBox(html: string): boolean {
  return HIDDEN_NLA_BOX.test(stripScriptsAndStyles(html));
}

/** The product's own visible price (not schema/meta, not hidden templates). */
export function hasOwnVisibleProductPrice(html: string): boolean {
  const visible = stripHiddenElements(stripScriptsAndStyles(html));
  return /<(?:div|span|section)\b[^>]*class=["'][^"']*(?:productView-price|productPrice)[^"']*["'][^>]*>[\s\S]{0,500}?(?:£|&pound;|\$|€)\s*\d/i.test(
    visible,
  );
}

/**
 * A product-level buy or in-store purchase path that is not inside a hidden
 * box. A Check store availability control still counts when it is disabled,
 * because that is how some in-store clearance pages render a real CTA.
 */
export function hasOwnVisibleBuyPath(html: string): boolean {
  const visible = stripHiddenElements(stripScriptsAndStyles(html));
  if (/check store availability/i.test(visible)) return true;
  if (/add to (?:basket|cart)/i.test(visible)) return true;
  if (/<(?:button|a|input)\b[^>]*>[\s\S]{0,80}\bbuy now\b/i.test(visible)) return true;
  return false;
}

/** Hidden "no longer available" box, and the product shows no price and no buy path. */
export function isHiddenNoLongerAvailableWithoutPurchasePath(html: string): boolean {
  return (
    hasHiddenProductNoLongerAvailableBox(html) &&
    !hasOwnVisibleProductPrice(html) &&
    !hasOwnVisibleBuyPath(html)
  );
}

/**
 * Hidden "no longer available" box is present, but pre-script HTML also has a
 * buy path and no visible price, so the page cannot be separated from an
 * in-store listing (the buy path may be removed only after JS). Do not guess.
 */
export function isHiddenNoLongerAvailableAmbiguous(html: string): boolean {
  return (
    hasHiddenProductNoLongerAvailableBox(html) &&
    !hasOwnVisibleProductPrice(html) &&
    hasOwnVisibleBuyPath(html)
  );
}

export const HIDDEN_NLA_AMBIGUOUS_SIGNAL = "hidden_nla_ambiguous";

export function applyHiddenNoLongerAvailableAmbiguous(page: VerifyVerdict): VerifyVerdict {
  if (page.signals.includes("redirected_away_from_product")) return page;
  const { label: _dropped, ...rest } = page;
  const signals = rest.signals.filter(
    (signal) =>
      !REPLACED.has(signal) &&
      signal !== "in_stores_only" &&
      signal !== NO_LONGER_AVAILABLE_SIGNAL &&
      signal !== HIDDEN_NLA_AMBIGUOUS_SIGNAL,
  );
  return {
    ...rest,
    status: "unknown",
    confidence: Math.min(page.confidence, 0.5),
    signals: dedupe([HIDDEN_NLA_AMBIGUOUS_SIGNAL, ...signals]),
  };
}

export function applyNoLongerAvailable(page: VerifyVerdict): VerifyVerdict {
  if (page.signals.includes("redirected_away_from_product")) return page;
  const { label: _dropped, ...rest } = page;
  const signals = rest.signals.filter(
    (signal) => !REPLACED.has(signal) && signal !== "in_stores_only" && signal !== NO_LONGER_AVAILABLE_SIGNAL,
  );
  return {
    ...rest,
    status: "closed",
    confidence: Math.max(page.confidence, 0.9),
    signals: dedupe([NO_LONGER_AVAILABLE_SIGNAL, ...signals]),
  };
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

  // An explicit visible "no longer available" message beats any in-store wording.
  if (hasVisibleProductNoLongerAvailable(html)) {
    return { verdict: applyNoLongerAvailable(verdict), ownFieldFound: true };
  }
  // A hidden "no longer available" box plus no price and no buy path is gone.
  // If the hidden box is present but pre-script HTML cannot separate a gone
  // page from an in-store page (no visible price, but a buy path remains),
  // return can't tell rather than guess.
  if (isHiddenNoLongerAvailableWithoutPurchasePath(html)) {
    return { verdict: applyNoLongerAvailable(verdict), ownFieldFound: true };
  }
  if (isHiddenNoLongerAvailableAmbiguous(html)) {
    return { verdict: applyHiddenNoLongerAvailableAmbiguous(verdict), ownFieldFound: true };
  }

  const apiUrl = wooStoreApiUrl(verdict.canonical_url) ?? wooStoreApiUrl(requested);
  const slug = wooSlugFromUrl(verdict.canonical_url) ?? wooSlugFromUrl(requested);
  let apiReading: Awaited<ReturnType<typeof lookupWooProduct>> = null;
  if (apiUrl && slug && looksLikeWooCommerce(html)) {
    apiReading = await lookupWooProduct(apiUrl, slug, fetcher, signal);
    if (apiReading?.backorder) {
      const next = applyAvailabilityLabel(verdict, "backorder");
      return {
        verdict: apiReading.title ? { ...next, title: apiReading.title } : next,
        ownFieldFound: true,
      };
    }
  }
  // Store API is preferred. When it yields no reading, trust Woo's own
  // stock-status element in the main product summary only.
  if (apiReading == null && hasWooProductSummaryBackorder(html)) {
    return { verdict: applyAvailabilityLabel(verdict, "backorder"), ownFieldFound: true };
  }

  if (detectInStoresOnly(html, requested) || detectInStoresOnly(html, verdict.canonical_url)) {
    return { verdict: applyAvailabilityLabel(verdict, "in_stores_only"), ownFieldFound: true };
  }

  return { verdict, ownFieldFound: false };
}
