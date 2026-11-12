import type { VerifyVerdict } from "./types.js";

/**
 * Marketplace listings: read the listing's own availability field, never
 * other listings shown on the same page (Poshmark; eBay HTML fallback below).
 *
 * Poshmark listing pages carry the listing's own availability in two places:
 * the schema.org Product JSON-LD in <head> (offers.availability, with
 * productID / sku set to the listing id) and the embedded page state
 * (`$_listing_details.listingDetails.inventory.status`).
 *
 * The same page also embeds "similar listings" and "Sold Listings" for other
 * items, with their titles, descriptions, and inventory. Livecheck reads at
 * most MAX_BODY_BYTES of the page, which can cut the state script before its
 * closing tag, so that other-listing text leaks into what the HTML classifier
 * treats as visible. A similar item described as "sold out" then turned a live
 * listing closed (Nov 12, 2026, UGG Adirondack boots).
 *
 * For a Poshmark listing URL, the listing's own field decides. Text from the
 * similar-items or Sold Listings blocks is never read.
 */

export type PoshmarkOwnReading = "available" | "sold" | "other";

export type PoshmarkOwnAvailability = {
  listingId: string;
  /** schema.org Product node whose productID/sku is this listing. */
  schema?: "available" | "sold";
  /** listingDetails.inventory.status for this listing id. */
  inventory?: string;
};

const POSHMARK_HOST = /(^|\.)poshmark\.(com|ca|com\.au|in)$/i;

/** Listing id (24 hex chars) from a poshmark.com/listing/<slug>-<id> URL. */
export function poshmarkListingId(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (!POSHMARK_HOST.test(url.hostname)) return null;
  const match = url.pathname.match(/^\/listing\/(?:[^/]*-)?([0-9a-f]{24})\/?$/i);
  return match ? match[1].toLowerCase() : null;
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

function isProduct(node: Record<string, unknown>): boolean {
  const type = node["@type"];
  return type === "Product" || (Array.isArray(type) && type.includes("Product"));
}

function schemaReading(availability: unknown): "available" | "sold" | undefined {
  if (typeof availability !== "string") return undefined;
  const value = availability.trim().replace(/^https?:\/\/schema\.org\//i, "").toLowerCase();
  if (value === "instock" || value === "limitedavailability" || value === "onlineonly" || value === "instoreonly") {
    return "available";
  }
  if (value === "outofstock" || value === "soldout" || value === "discontinued") return "sold";
  return undefined;
}

/** offers.availability on the JSON-LD Product for this listing id only. */
function ownSchemaAvailability(html: string, listingId: string): "available" | "sold" | undefined {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const readings = new Set<"available" | "sold">();
  for (const match of html.matchAll(re)) {
    const nodes: Record<string, unknown>[] = [];
    try {
      collectNodes(JSON.parse(match[1].trim()), nodes);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (!isProduct(node)) continue;
      const ids = [node.productID, node.sku].filter((v): v is string => typeof v === "string").map((v) => v.toLowerCase());
      if (!ids.includes(listingId)) continue;
      const offers = Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : [];
      for (const offer of offers) {
        if (!offer || typeof offer !== "object") continue;
        const reading = schemaReading((offer as Record<string, unknown>).availability);
        if (reading) readings.add(reading);
      }
    }
  }
  if (readings.size !== 1) return undefined;
  return [...readings][0];
}

/**
 * `"listingDetails":{"id":"<listingId>", ... "inventory":{"status":"..."}`.
 * Only the listing's own object: the first inventory after its id, and only
 * if no other listing object starts in between.
 */
function ownInventoryStatus(html: string, listingId: string): string | undefined {
  const anchor = html.indexOf(`"listingDetails":{"id":"${listingId}"`);
  if (anchor < 0) return undefined;
  const window = html.slice(anchor, anchor + 4_000);
  const inventory = window.match(/"inventory":\{"status":"([a-z_]+)"/i);
  if (!inventory || inventory.index === undefined) return undefined;
  const between = window.slice(`"listingDetails":{"id":"${listingId}"`.length, inventory.index);
  if (/"id":"[0-9a-f]{24}","creator_id"/i.test(between)) return undefined;
  return inventory[1].toLowerCase();
}

export function poshmarkOwnAvailability(html: string, listingId: string): PoshmarkOwnAvailability {
  const schema = ownSchemaAvailability(html, listingId);
  const inventory = ownInventoryStatus(html, listingId);
  return { listingId, ...(schema ? { schema } : {}), ...(inventory ? { inventory } : {}) };
}

function inventoryReading(status: string | undefined): PoshmarkOwnReading | undefined {
  if (!status) return undefined;
  if (status === "available") return "available";
  if (status === "sold_out" || status === "sold") return "sold";
  return "other";
}

/** One answer from the listing's own fields, or undefined when they are missing or disagree. */
export function poshmarkOwnReading(own: PoshmarkOwnAvailability): PoshmarkOwnReading | undefined {
  const inv = inventoryReading(own.inventory);
  const schema = own.schema;
  if (inv && schema && inv !== "other" && inv !== schema) return undefined;
  if (inv === "other") return "other";
  return inv ?? schema;
}

function dedupe(signals: string[]): string[] {
  const out: string[] = [];
  for (const signal of signals) if (!out.includes(signal)) out.push(signal);
  return out;
}

/** HTML readings the listing's own field replaces. */
const REPLACED = new Set(["sold-out", "in-stock", "ambiguous_html", "not_a_specific_posting"]);

/**
 * Apply a marketplace listing's own availability to the HTML verdict.
 * `prefix` names the source in signals (`poshmark`, `ebay_item`).
 * - Challenge, login wall, robots: verdict is kept.
 * - HTTP 404/410: stays closed (a sold reading is added as a signal).
 * - available -> live; sold -> closed.
 * - Own field missing, unclear, or another status (reserved, not_for_sale):
 *   a closed reading that came only from page text becomes can't tell.
 */
export function applyOwnListingAvailability(
  page: VerifyVerdict,
  reading: PoshmarkOwnReading | undefined,
  prefix: string,
  otherStatus?: string,
): VerifyVerdict {
  const blocked = page.signals.some((s) => s === "challenge_page" || s === "loginwalled" || s.startsWith("robots_"));
  if (blocked) return page;
  const soldSignal = prefix === "poshmark" ? "poshmark_sold_out" : `${prefix}_unavailable`;
  if (page.http_status === 404 || page.http_status === 410) {
    if (reading === "sold") return { ...page, signals: dedupe([...page.signals, soldSignal]) };
    return page;
  }
  if (page.http_status < 200 || page.http_status >= 300) return page;
  const rest = page.signals.filter((signal) => !REPLACED.has(signal));
  if (reading === "available") {
    return {
      ...page,
      status: "live",
      confidence: Math.max(page.confidence, 0.9),
      signals: dedupe([`${prefix}_available`, "in-stock", ...rest]),
    };
  }
  if (reading === "sold") {
    return {
      ...page,
      status: "closed",
      confidence: Math.max(page.confidence, 0.9),
      signals: dedupe([soldSignal, "sold-out", ...rest]),
    };
  }
  if (page.status === "closed" && page.signals.includes("sold-out")) {
    const signal = reading === "other" && otherStatus ? `${prefix}_inventory_${otherStatus}` : `${prefix}_availability_unavailable`;
    return {
      ...page,
      status: "unknown",
      confidence: 0.5,
      signals: dedupe([signal, ...rest]),
    };
  }
  return page;
}

export function applyPoshmarkAvailability(page: VerifyVerdict, own: PoshmarkOwnAvailability): VerifyVerdict {
  return applyOwnListingAvailability(page, poshmarkOwnReading(own), "poshmark", own.inventory);
}

/**
 * eBay item HTML (only read when the Browse API adapter is off): the item's
 * own schema.org Product, matched by the item id in its url / offers.url /
 * productID / sku. Products nested in "Similar sold items" ItemLists are not
 * top-level nodes and are never read.
 */
export function ebayOwnHtmlReading(html: string, itemId: string): PoshmarkOwnReading | undefined {
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const readings = new Set<"available" | "sold">();
  const idInUrl = new RegExp(`/itm/(?:[^/?#]*/)?${itemId}(?:[/?#]|$)`);
  for (const match of html.matchAll(re)) {
    const nodes: Record<string, unknown>[] = [];
    try {
      collectNodes(JSON.parse(match[1].trim()), nodes);
    } catch {
      continue;
    }
    for (const node of nodes) {
      if (!isProduct(node)) continue;
      const offers = (Array.isArray(node.offers) ? node.offers : node.offers ? [node.offers] : []).filter(
        (o): o is Record<string, unknown> => Boolean(o) && typeof o === "object",
      );
      const urls = [node.url, ...offers.map((o) => o.url)].filter((v): v is string => typeof v === "string");
      const ids = [node.productID, node.sku].filter((v): v is string => typeof v === "string");
      if (!urls.some((u) => idInUrl.test(u)) && !ids.includes(itemId)) continue;
      for (const offer of offers) {
        const reading = schemaReading(offer.availability);
        if (reading) readings.add(reading);
      }
    }
  }
  if (readings.size !== 1) return undefined;
  return [...readings][0];
}
