import { USER_AGENT } from "./config.js";
import { DeadlineError } from "./deadline.js";
import type { VerifyVerdict } from "./types.js";

/**
 * Variant-aware product availability.
 *
 * Rules (Craig, Nov 11, 2026):
 * 1. A link that names a variant (`?variant=<id>`, or an option param such as
 *    `?color=White` that maps to a variant) is judged on that variant only.
 * 2. A link with no variant is sold out only when every variant is unavailable.
 * 3. When the backup lookup fails (product.js 404 on a headless store and no
 *    per-variant schema.org offers), an HTML sold-out reading is can't tell,
 *    never closed. One out-of-stock swatch must not close the whole product.
 */

export type ProductVariant = {
  id?: string;
  sku?: string;
  url?: string;
  /** true = can be bought, false = out of stock, null = no clear reading. */
  available: boolean | null;
  /** Lower-cased option name -> value, e.g. { color: "White", size: "30" }. */
  options: Record<string, string>;
};

export type VariantSelector = {
  variantId?: string;
  options: Array<{ name: string; value: string }>;
};

export type VariantDecision = {
  status: "live" | "closed" | "unknown";
  signal: string;
};

export type ShopifyProduct = {
  available: boolean;
  title?: string;
  variants: ProductVariant[];
};

const OPTION_PARAMS = new Set([
  "color",
  "colour",
  "size",
  "style",
  "material",
  "finish",
  "pattern",
  "flavor",
  "flavour",
  "scent",
  "width",
  "length",
  "fit",
]);

function optionKey(name: string): string {
  const key = name.trim().toLowerCase();
  if (key === "colour") return "color";
  if (key === "flavour") return "flavor";
  return key;
}

function sameValue(a: string, b: string): boolean {
  const norm = (value: string) => value.replace(/\+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return norm(a) === norm(b);
}

/** Read the linked variant id and option params (color, size, ...) from a product URL. */
export function linkedVariantSelector(raw: string): VariantSelector {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { options: [] };
  }
  const selector: VariantSelector = { options: [] };
  const variant = url.searchParams.get("variant")?.trim();
  if (variant && /^\d+$/.test(variant)) selector.variantId = variant;
  for (const [name, value] of url.searchParams) {
    const key = optionKey(name);
    if (!OPTION_PARAMS.has(key) || !value.trim()) continue;
    if (selector.options.some((option) => option.name === key)) continue;
    selector.options.push({ name: key, value: value.trim() });
  }
  return selector;
}

function variantParam(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, "https://x.invalid/").searchParams.get("variant") ?? undefined;
  } catch {
    return undefined;
  }
}

function urlOptions(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  try {
    for (const [name, value] of new URL(raw, "https://x.invalid/").searchParams) {
      const key = optionKey(name);
      if (OPTION_PARAMS.has(key) && value.trim()) out[key] = value.trim();
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Decide availability from per-variant data.
 * `productAvailable` is the product-level flag (Shopify `.js` `available`),
 * used only when there is no variant list.
 */
export function decideVariants(
  variants: ProductVariant[],
  selector: VariantSelector,
  productAvailable?: boolean,
): VariantDecision | null {
  if (selector.variantId) {
    const id = selector.variantId;
    const match = variants.find((v) => v.id === id || variantParam(v.url) === id);
    if (!match) return variants.length ? { status: "unknown", signal: "linked_variant_not_found" } : null;
    if (match.available === true) return { status: "live", signal: "linked_variant_available" };
    if (match.available === false) return { status: "closed", signal: "linked_variant_unavailable" };
    return { status: "unknown", signal: "linked_variant_unclear" };
  }
  let unresolved = false;
  if (selector.options.length && variants.length) {
    const known = selector.options.filter((option) =>
      variants.some((v) => option.name in v.options || option.name in urlOptions(v.url)),
    );
    if (known.length) {
      const matches = variants.filter((v) =>
        known.every((option) => {
          const value = v.options[option.name] ?? urlOptions(v.url)[option.name];
          return value !== undefined && sameValue(value, option.value);
        }),
      );
      if (matches.length) {
        if (matches.some((v) => v.available === true)) return { status: "live", signal: "linked_option_available" };
        if (matches.every((v) => v.available === false)) return { status: "closed", signal: "linked_option_unavailable" };
        return { status: "unknown", signal: "linked_option_unclear" };
      }
    }
    unresolved = true;
  }
  if (!variants.length) {
    if (productAvailable === undefined) return null;
    return productAvailable
      ? { status: "live", signal: unresolved ? "variant_param_unresolved" : "product_available" }
      : { status: "closed", signal: "all_variants_unavailable" };
  }
  if (variants.some((v) => v.available === true)) {
    return { status: "live", signal: unresolved ? "variant_param_unresolved" : "some_variants_available" };
  }
  if (variants.every((v) => v.available === false)) return { status: "closed", signal: "all_variants_unavailable" };
  return { status: "unknown", signal: "variants_unclear" };
}

/** Shopify `/products/<handle>.js` with its variant list. Null when missing or not Shopify JSON. */
export async function lookupShopifyProduct(
  jsUrl: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<ShopifyProduct | null> {
  try {
    const response = await fetcher(jsUrl, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      available?: unknown;
      title?: unknown;
      options?: unknown;
      variants?: unknown;
    };
    if (typeof data.available !== "boolean") return null;
    const names: string[] = Array.isArray(data.options)
      ? data.options.map((option) =>
          typeof option === "string"
            ? option
            : option && typeof option === "object" && typeof (option as { name?: unknown }).name === "string"
              ? ((option as { name: string }).name)
              : "",
        )
      : [];
    const variants: ProductVariant[] = [];
    if (Array.isArray(data.variants)) {
      for (const raw of data.variants) {
        if (!raw || typeof raw !== "object") continue;
        const v = raw as Record<string, unknown>;
        const options: Record<string, string> = {};
        ["option1", "option2", "option3"].forEach((key, index) => {
          const value = v[key];
          const name = names[index];
          if (typeof value === "string" && name) options[optionKey(name)] = value;
        });
        variants.push({
          ...(v.id !== undefined && v.id !== null ? { id: String(v.id) } : {}),
          ...(typeof v.sku === "string" && v.sku ? { sku: v.sku } : {}),
          available: typeof v.available === "boolean" ? v.available : null,
          options,
        });
      }
    }
    return {
      available: data.available,
      ...(typeof data.title === "string" && data.title.trim() ? { title: data.title.trim() } : {}),
      variants,
    };
  } catch (error) {
    if (error instanceof DeadlineError || signal?.aborted) throw error;
    return null;
  }
}

const IN_STOCK = /(InStock|InStoreOnly|OnlineOnly|LimitedAvailability|PreOrder|PreSale|BackOrder)$/i;
const OUT_OF_STOCK = /(OutOfStock|SoldOut|Discontinued)$/i;

function availabilityOf(value: unknown): boolean | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (OUT_OF_STOCK.test(v)) return false;
  if (IN_STOCK.test(v)) return true;
  return null;
}

function typeIs(node: Record<string, unknown>, name: string): boolean {
  const type = node["@type"];
  return Array.isArray(type) ? type.includes(name) : type === name;
}

function offerList(offers: unknown): Record<string, unknown>[] {
  const list = Array.isArray(offers) ? offers : offers ? [offers] : [];
  return list.filter((o): o is Record<string, unknown> => Boolean(o) && typeof o === "object");
}

function nodeOptions(node: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ["color", "size", "material", "pattern", "style"]) {
    const value = node[key];
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (value && typeof value === "object" && typeof (value as { name?: unknown }).name === "string") {
      out[key] = (value as { name: string }).name.trim();
    }
  }
  return out;
}

function variantFromProduct(node: Record<string, unknown>): ProductVariant | null {
  const offers = offerList(node.offers).filter((o) => !typeIs(o, "AggregateOffer"));
  if (!offers.length) return null;
  const readings = offers.map((o) => availabilityOf(o.availability));
  const available = readings.some((r) => r === true) ? true : readings.every((r) => r === false) ? false : null;
  const url = typeof node.url === "string" ? node.url : typeof offers[0].url === "string" ? (offers[0].url as string) : undefined;
  const id = variantParam(url);
  const sku = typeof node.sku === "string" ? node.sku : typeof offers[0].sku === "string" ? (offers[0].sku as string) : undefined;
  return { ...(id ? { id } : {}), ...(sku ? { sku } : {}), ...(url ? { url } : {}), available, options: nodeOptions(node) };
}

function variantFromOffer(offer: Record<string, unknown>, parent: Record<string, string>): ProductVariant {
  const item = offer.itemOffered && typeof offer.itemOffered === "object" ? (offer.itemOffered as Record<string, unknown>) : {};
  const url = typeof offer.url === "string" ? offer.url : undefined;
  const id = variantParam(url);
  const sku = typeof offer.sku === "string" ? offer.sku : undefined;
  return {
    ...(id ? { id } : {}),
    ...(sku ? { sku } : {}),
    ...(url ? { url } : {}),
    available: availabilityOf(offer.availability),
    options: { ...parent, ...nodeOptions(item) },
  };
}

function collectNodes(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectNodes(item, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  const node = value as Record<string, unknown>;
  out.push(node);
  if (node["@graph"]) collectNodes(node["@graph"], out);
}

/**
 * Per-variant offers from schema.org JSON-LD: ProductGroup.hasVariant,
 * sibling Product nodes with isVariantOf, or one Product with several Offers.
 * An AggregateOffer is never read as a variant.
 */
export function schemaVariants(html: string): ProductVariant[] {
  const nodes: Record<string, unknown>[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      collectNodes(JSON.parse(match[1].trim()), nodes);
    } catch {
      /* skip bad block */
    }
  }
  const variants: ProductVariant[] = [];
  for (const node of nodes) {
    if (typeIs(node, "ProductGroup") && Array.isArray(node.hasVariant)) {
      for (const child of node.hasVariant) {
        if (child && typeof child === "object") {
          const v = variantFromProduct(child as Record<string, unknown>);
          if (v) variants.push(v);
        }
      }
    }
  }
  for (const node of nodes) {
    if (!typeIs(node, "Product")) continue;
    if (node.isVariantOf) {
      const v = variantFromProduct(node);
      if (v) variants.push(v);
      continue;
    }
    const offers = offerList(node.offers).filter((o) => !typeIs(o, "AggregateOffer"));
    if (!offers.length) continue;
    const parent = nodeOptions(node);
    for (const offer of offers) variants.push(variantFromOffer(offer, parent));
  }
  return variants;
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

/** Apply a variant decision. `source` is "shopify" (product.js) or "schema" (JSON-LD offers). */
export function applyVariantDecision(
  page: VerifyVerdict,
  decision: VariantDecision,
  source: "shopify" | "schema",
  title?: string,
): VerifyVerdict {
  const rest = page.signals.filter((signal) => !REPLACED.has(signal));
  const sourceSignal = source === "shopify" ? "shopify" : "schema_variant";
  if (decision.status === "live") {
    return {
      ...page,
      status: "live",
      confidence: Math.max(page.confidence, 0.9),
      ...(title ? { title } : {}),
      signals: dedupe([`${sourceSignal}_available`, "in-stock", decision.signal, ...rest]),
    };
  }
  if (decision.status === "closed") {
    return {
      ...page,
      status: "closed",
      confidence: Math.max(page.confidence, 0.9),
      ...(title ? { title } : {}),
      signals: dedupe([`${sourceSignal}_unavailable`, "sold-out", decision.signal, ...rest]),
    };
  }
  // Can't tell. Keep a closed verdict that came from something other than a
  // sold-out reading (HTTP 404, closure banner, redirect).
  if (page.status === "closed" && !page.signals.includes("sold-out")) return page;
  return {
    ...page,
    status: "unknown",
    confidence: 0.5,
    ...(title ? { title } : {}),
    signals: dedupe([decision.signal, ...rest]),
  };
}

/**
 * Rule 3: the product.js backup failed and the page has no per-variant offers.
 * A sold-out reading from HTML alone (it can be one swatch) becomes can't tell.
 */
export function backupFailed(page: VerifyVerdict): VerifyVerdict {
  if (page.status !== "closed" || !page.signals.includes("sold-out")) return page;
  return {
    ...page,
    status: "unknown",
    confidence: 0.5,
    signals: dedupe(["variant_check_unavailable", ...page.signals.filter((signal) => signal !== "sold-out")]),
  };
}
