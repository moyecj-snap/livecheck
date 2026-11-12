import type { VerifyVerdict } from "./types.js";
import {
  applyVariantDecision,
  decideVariants,
  linkedVariantSelector,
  type ProductVariant,
  type VariantDecision,
} from "./product-variants.js";

/**
 * HTML structured-data availability: WooCommerce form variations and
 * JSON-LD offers. Used when Shopify product.js did not already decide.
 * A conflict between structured sold-out and a working product-form
 * Add to cart is can't tell.
 */

function unescapeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function optionKey(name: string): string {
  const key = name.trim().toLowerCase().replace(/^attribute_(?:pa_)?/, "");
  if (key === "colour") return "color";
  if (key === "flavour") return "flavor";
  return key;
}

/** WooCommerce `data-product_variations` on the product form. */
export function parseWooFormVariations(html: string): ProductVariant[] {
  const match = /data-product_variations="([^"]*)"/.exec(html);
  if (!match) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(unescapeHtml(match[1]));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const variants: ProductVariant[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const row = item as { variation_id?: unknown; is_in_stock?: unknown; attributes?: unknown };
    if (typeof row.is_in_stock !== "boolean") continue;
    const options: Record<string, string> = {};
    if (row.attributes && typeof row.attributes === "object" && !Array.isArray(row.attributes)) {
      for (const [name, value] of Object.entries(row.attributes as Record<string, unknown>)) {
        if (typeof value === "string" && value.trim()) options[optionKey(name)] = value.trim();
      }
    }
    variants.push({
      ...(typeof row.variation_id === "number" || typeof row.variation_id === "string"
        ? { id: String(row.variation_id) }
        : {}),
      available: row.is_in_stock,
      options,
    });
  }
  return variants;
}

function collectJsonLd(html: string): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      walk(JSON.parse(match[1].trim()), nodes);
    } catch {
      /* skip */
    }
  }
  return nodes;
}

function walk(value: unknown, nodes: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, nodes);
    return;
  }
  if (!value || typeof value !== "object") return;
  const obj = value as Record<string, unknown>;
  nodes.push(obj);
  if (Array.isArray(obj["@graph"])) walk(obj["@graph"], nodes);
}

function typeIs(node: Record<string, unknown>, typ: string): boolean {
  const raw = node["@type"];
  if (typeof raw === "string") return raw === typ || raw.endsWith("/" + typ);
  if (Array.isArray(raw)) return raw.some((t) => t === typ || (typeof t === "string" && t.endsWith("/" + typ)));
  return false;
}

function hostOf(raw: string): string | null {
  try {
    return new URL(raw).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

const NOT_FOR_SALE = /\bnot available for sale on\s+(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*)/i;

/**
 * Product JSON-LD (or Offer) description says the item is not for sale on
 * this store's own host. Used only as structured product data, never page HTML.
 */
export function jsonLdNotForSaleOnStore(html: string, pageUrl: string): boolean {
  const host = hostOf(pageUrl);
  if (!host) return false;
  for (const node of collectJsonLd(html)) {
    if (!typeIs(node, "Product") && !typeIs(node, "Offer")) continue;
    const desc = typeof node.description === "string" ? node.description : "";
    const match = NOT_FOR_SALE.exec(desc);
    if (!match) continue;
    const mentioned = (match[1] ?? "").replace(/^www\./i, "").toLowerCase();
    if (mentioned === host || host.endsWith("." + mentioned) || mentioned.endsWith("." + host)) return true;
  }
  return false;
}

function applyDecision(
  page: VerifyVerdict,
  decision: VariantDecision,
  source: "schema" | "woo",
): VerifyVerdict {
  return applyVariantDecision(page, decision, source);
}

/**
 * Apply Woo form variations or JSON-LD offers when Shopify product.js did not
 * already decide. A link with no variant is sold out only when every variant
 * is unavailable.
 */
export function applyHtmlStructuredAvailability(
  requested: string,
  verdict: VerifyVerdict,
  html: string,
  alreadyDecided: boolean,
): { verdict: VerifyVerdict; ownFieldFound: boolean } {
  if (verdict.signals.includes("redirected_away_from_product") || alreadyDecided) {
    return { verdict, ownFieldFound: false };
  }
  const selector = linkedVariantSelector(requested);
  const woo = parseWooFormVariations(html);
  if (woo.length) {
    const decision = decideVariants(woo, selector);
    if (decision) return { verdict: applyDecision(verdict, decision, "woo"), ownFieldFound: true };
  }
  // JSON-LD offers are already applied in withShopify when product.js is
  // missing. Do not apply them as a standalone live overlay on every store:
  // a ProductGroup can list in-stock offers that are not this product.
  return { verdict, ownFieldFound: false };
}

const ATC_PHRASE = /\badd to (?:cart|bag|basket)\b/i;

function isDisabled(tag: string, text: string): boolean {
  if (/\sdisabled\b/i.test(tag) || /aria-disabled=["']true["']/i.test(tag)) return true;
  return /\bsold\s*out\b/i.test(text);
}

function insideProductForm(html: string, pos: number): boolean {
  const before = html.slice(Math.max(0, pos - 20000), pos);
  const lastOpen = before.toLowerCase().lastIndexOf("<form");
  const lastClose = before.toLowerCase().lastIndexOf("</form");
  if (lastOpen < 0 || lastOpen < lastClose) return false;
  const openTag = /<form\b[^>]*>/i.exec(before.slice(lastOpen))?.[0] ?? "";
  const after = before.slice(lastOpen);
  if (/id=["'][^"']*product|class=["'][^"']*(?:product|cart|variations)/i.test(openTag + after.slice(0, 500))) return true;
  if (/action=["'][^"']*\/cart\/add/i.test(openTag)) return true;
  if (/\bid=["']AddToCart\b|name=["']add["']/i.test(html.slice(pos, pos + 200)) || /id=["']AddToCart/i.test(before.slice(-500))) {
    return true;
  }
  // A form that itself contains a submit named add / AddToCart is a product form.
  return /name=["']add["']|id=["']AddToCart/i.test(html.slice(Math.max(0, pos - 200), pos + 400));
}

type FormControl = { start: number; tag: string; text: string; primary: boolean };

function enclosingFormStart(html: string, pos: number): number | null {
  const before = html.slice(Math.max(0, pos - 20000), pos);
  const lastOpen = before.toLowerCase().lastIndexOf("<form");
  const lastClose = before.toLowerCase().lastIndexOf("</form");
  if (lastOpen < 0 || lastOpen < lastClose) return null;
  return pos - before.length + lastOpen;
}

/** Hidden or select `name="id"` values inside a product form (Shopify variant ids). */
function variantIdsInForm(html: string, formStart: number): Set<string> {
  const fromForm = html.slice(formStart);
  const end = fromForm.toLowerCase().indexOf("</form");
  const chunk = end >= 0 ? fromForm.slice(0, end) : fromForm.slice(0, 20000);
  const ids = new Set<string>();
  for (const tag of chunk.matchAll(/<input\b[^>]*>/gi)) {
    if (!/\bname=["']id["']/i.test(tag[0])) continue;
    const value = /\bvalue=["']([^"']+)["']/i.exec(tag[0])?.[1]?.trim();
    if (value) ids.add(value);
  }
  for (const sel of chunk.matchAll(/<select\b[^>]*\bname=["']id["'][^>]*>([\s\S]*?)<\/select>/gi)) {
    for (const option of (sel[1] ?? "").matchAll(/<option\b[^>]*\bvalue=["']([^"']+)["']/gi)) {
      const value = option[1]?.trim();
      if (value) ids.add(value);
    }
  }
  return ids;
}

function formMatchesCurrentProduct(html: string, pos: number, currentIds: Set<string>): boolean {
  if (!currentIds.size) return true;
  const formStart = enclosingFormStart(html, pos);
  if (formStart === null) return false;
  for (const id of variantIdsInForm(html, formStart)) {
    if (currentIds.has(id)) return true;
  }
  return false;
}

function productFormControls(html: string, currentIds?: Iterable<string>): FormControl[] {
  const ids = currentIds ? new Set([...currentIds].map(String)) : new Set<string>();
  const out: FormControl[] = [];
  const re = /<(button|a)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of html.matchAll(re)) {
    const attrs = match[2] ?? "";
    const inner = (match[3] ?? "").replace(/<[^>]+>/g, " ");
    const aria = /aria-label=["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const text = `${aria} ${inner}`.replace(/\s+/g, " ").trim();
    const looksAtc = ATC_PHRASE.test(text) || /\bsold\s*out\b/i.test(text);
    if (!looksAtc) continue;
    if (!insideProductForm(html, match.index ?? 0)) continue;
    if (ids.size && !formMatchesCurrentProduct(html, match.index ?? 0, ids)) continue;
    const primary = /\bid=["']AddToCart\b|name=["']add["']/i.test(attrs) || /\bid=["']AddToCart\b/i.test(attrs);
    out.push({ start: match.index ?? 0, tag: attrs, text, primary });
  }
  return out;
}

/**
 * Enabled Add to cart on the *primary* product form (the first product CTA
 * in document order, optionally limited to forms whose variant id belongs
 * to this product). Later related-product Add to cart buttons are ignored.
 */
export function hasWorkingProductFormAddToCart(html: string, currentVariantIds?: Iterable<string>): boolean {
  const controls = productFormControls(html, currentVariantIds);
  const primary = controls.find((c) => c.primary) ?? controls[0];
  if (!primary) return false;
  if (isDisabled(primary.tag, primary.text)) return false;
  return ATC_PHRASE.test(primary.text);
}

export function applyStructuredPageConflict(
  page: VerifyVerdict,
  html: string,
  currentVariantIds?: Iterable<string>,
): VerifyVerdict {
  if (page.label) return page;
  if (page.status !== "closed" || !page.signals.includes("sold-out")) return page;
  if (page.signals.includes("redirected_away_from_product")) return page;
  // Paloma's case: product.js is sold out, but the product form still has Add to cart.
  // Do not undo a Woo/JSON-LD per-variant decision (a form ATC can stay enabled for other variants).
  if (!page.signals.includes("shopify_unavailable")) return page;
  if (!hasWorkingProductFormAddToCart(html, currentVariantIds)) return page;
  const rest = page.signals.filter(
    (signal) => signal !== "sold-out" && signal !== "shopify_unavailable" && signal !== "in-stock",
  );
  return {
    ...page,
    status: "unknown",
    confidence: Math.min(page.confidence, 0.5),
    signals: ["structured_page_conflict", ...rest.filter((s) => s !== "structured_page_conflict")],
  };
}
