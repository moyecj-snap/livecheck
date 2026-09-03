import { PRICE_USD, USER_AGENT } from "./config.js";
import type { SourceStatus, VerifyVerdict } from "./types.js";

export const EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token";
export const EBAY_OAUTH_SCOPE = "https://api.ebay.com/oauth/api_scope";
export const EBAY_BROWSE_BASE = "https://api.ebay.com/buy/browse/v1";

const HOST_MARKETPLACE: Record<string, string> = {
  "ebay.com": "EBAY_US",
  "ebay.co.uk": "EBAY_GB",
  "ebay.de": "EBAY_DE",
  "ebay.ca": "EBAY_CA",
  "ebay.com.au": "EBAY_AU",
  "ebay.fr": "EBAY_FR",
  "ebay.it": "EBAY_IT",
  "ebay.es": "EBAY_ES",
  "ebay.ie": "EBAY_IE",
  "ebay.at": "EBAY_AT",
  "ebay.ch": "EBAY_CH",
  "ebay.nl": "EBAY_NL",
  "ebay.be": "EBAY_BE",
  "ebay.pl": "EBAY_PL",
};

export type EbayItemRef = {
  href: string;
  itemId: string;
  marketplaceId: string;
};

export type EbayCreds = {
  clientId: string;
  clientSecret: string;
  marketplaceId?: string;
};

type TokenCache = { token: string; expiresAtMs: number };

let tokenCache: TokenCache | null = null;
let loggedDisabled = false;

export function resetEbayTokenCache(): void {
  tokenCache = null;
}

export function resetEbayDisabledLog(): void {
  loggedDisabled = false;
}

export function readEbayCreds(): EbayCreds | null {
  const clientId = process.env.EBAY_CLIENT_ID?.trim();
  const clientSecret = process.env.EBAY_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const marketplaceId = process.env.EBAY_MARKETPLACE_ID?.trim();
  return {
    clientId,
    clientSecret,
    ...(marketplaceId ? { marketplaceId } : {}),
  };
}

export function isEbayAdapterEnabled(): boolean {
  return readEbayCreds() !== null;
}

export function logEbayAdapterDisabled(): void {
  if (loggedDisabled) return;
  loggedDisabled = true;
  console.warn(
    "[livecheck] eBay adapter disabled: set EBAY_CLIENT_ID and EBAY_CLIENT_SECRET to use Browse availability. eBay item URLs fall back to the HTML classifier.",
  );
}

function ebayRegistrableHost(hostname: string): string | undefined {
  const host = hostname.toLowerCase().replace(/^www\./, "").replace(/^m\./, "").replace(/^motors\./, "");
  if (HOST_MARKETPLACE[host]) return host;
  const parts = host.split(".");
  if (parts.length >= 2 && parts[parts.length - 2] === "ebay") {
    const apex = parts.slice(-2).join(".");
    if (HOST_MARKETPLACE[apex]) return apex;
  }
  if (parts.length >= 3 && parts[parts.length - 3] === "ebay") {
    const apex = parts.slice(-3).join(".");
    if (HOST_MARKETPLACE[apex]) return apex;
  }
  return undefined;
}

export function parseEbayItemUrl(raw: string): EbayItemRef | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const host = ebayRegistrableHost(parsed.hostname);
  if (!host) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const itm = parts.findIndex((p) => p.toLowerCase() === "itm");
  if (itm < 0) return null;
  const after = parts.slice(itm + 1);
  let itemId: string | undefined;
  for (let i = after.length - 1; i >= 0; i -= 1) {
    const candidate = after[i].split("?")[0];
    if (/^\d{8,19}$/.test(candidate)) {
      itemId = candidate;
      break;
    }
  }
  if (!itemId) return null;
  const envMarket = process.env.EBAY_MARKETPLACE_ID?.trim();
  return {
    href: parsed.href,
    itemId,
    marketplaceId: envMarket || HOST_MARKETPLACE[host] || "EBAY_US",
  };
}

type BrowseItem = {
  title?: string;
  itemEndDate?: string;
  estimatedAvailabilities?: Array<{ estimatedAvailabilityStatus?: string }>;
};

function availabilityStatus(item: BrowseItem): string | undefined {
  for (const row of item.estimatedAvailabilities ?? []) {
    const status = row.estimatedAvailabilityStatus?.trim().toUpperCase();
    if (status) return status;
  }
  return undefined;
}

function listingEnded(item: BrowseItem, now: Date): boolean {
  if (!item.itemEndDate) return false;
  const end = Date.parse(item.itemEndDate);
  if (Number.isNaN(end)) return false;
  return end <= now.getTime();
}

export function verdictFromBrowseItem(
  ref: EbayItemRef,
  item: BrowseItem,
  httpStatus: number,
  now: Date,
): VerifyVerdict {
  const ended = listingEnded(item, now);
  const availability = availabilityStatus(item);
  const signals: string[] = [];
  let status: SourceStatus = "unknown";
  let confidence = 0.4;

  if (ended) {
    signals.push("ebay-ended");
    status = "closed";
    confidence = 0.92;
  } else if (availability === "OUT_OF_STOCK") {
    signals.push("sold-out");
    status = "closed";
    confidence = 0.9;
  } else if (availability === "IN_STOCK" || availability === "LIMITED_STOCK") {
    signals.push("ebay-in-stock");
    status = "live";
    confidence = availability === "IN_STOCK" ? 0.86 : 0.8;
  } else {
    signals.push("ebay_availability_unknown");
  }

  return {
    url: ref.href,
    canonical_url: ref.href,
    status,
    http_status: httpStatus,
    checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(item.title ? { title: item.title } : {}),
    signals,
    confidence,
    price_usd: PRICE_USD,
  };
}

function unknownEbayVerdict(ref: EbayItemRef, signal: string, httpStatus: number, now: Date): VerifyVerdict {
  return {
    url: ref.href,
    canonical_url: ref.href,
    status: "unknown",
    http_status: httpStatus,
    checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    signals: [signal],
    confidence: 0.4,
    price_usd: PRICE_USD,
  };
}

function closedMissingVerdict(ref: EbayItemRef, now: Date): VerifyVerdict {
  return {
    url: ref.href,
    canonical_url: ref.href,
    status: "closed",
    http_status: 404,
    checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    signals: ["http_404", "ebay-ended"],
    confidence: 0.93,
    price_usd: PRICE_USD,
  };
}

async function fetchApplicationToken(creds: EbayCreds, fetcher: typeof fetch): Promise<string> {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAtMs > now + 5_000) {
    return tokenCache.token;
  }
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`, "utf8").toString("base64");
  const response = await fetcher(EBAY_OAUTH_URL, {
    method: "POST",
    headers: {
      authorization: `Basic ${basic}`,
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
      "user-agent": USER_AGENT,
    },
    body: `grant_type=client_credentials&scope=${encodeURIComponent(EBAY_OAUTH_SCOPE)}`,
  });
  if (!response.ok) {
    throw new Error(`ebay_oauth_${response.status}`);
  }
  const body = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!body.access_token) {
    throw new Error("ebay_oauth_missing_token");
  }
  const ttlSec = typeof body.expires_in === "number" && body.expires_in > 90 ? body.expires_in : 7200;
  tokenCache = {
    token: body.access_token,
    expiresAtMs: now + (ttlSec - 60) * 1000,
  };
  return body.access_token;
}

async function readJson(response: Response): Promise<BrowseItem | null> {
  try {
    return (await response.json()) as BrowseItem;
  } catch {
    return null;
  }
}

export async function verifyEbayItem(
  ref: EbayItemRef,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<VerifyVerdict> {
  const creds = readEbayCreds();
  if (!creds) {
    logEbayAdapterDisabled();
    return unknownEbayVerdict(ref, "ebay_adapter_disabled", 200, now);
  }
  try {
    const token = await fetchApplicationToken(creds, fetcher);
    const marketplace = creds.marketplaceId || ref.marketplaceId || "EBAY_US";
    const headers = {
      authorization: `Bearer ${token}`,
      accept: "application/json",
      "user-agent": USER_AGENT,
      "x-ebay-c-marketplace-id": marketplace,
    };
    const legacyUrl = `${EBAY_BROWSE_BASE}/item/get_item_by_legacy_id?legacy_item_id=${encodeURIComponent(ref.itemId)}`;
    const legacy = await fetcher(legacyUrl, { method: "GET", headers });
    if (legacy.status === 404) {
      return closedMissingVerdict(ref, now);
    }
    if (legacy.ok) {
      const item = await readJson(legacy);
      if (!item) return unknownEbayVerdict(ref, "ebay_api_error", legacy.status, now);
      return verdictFromBrowseItem(ref, item, legacy.status, now);
    }
    if (legacy.status === 400) {
      const restfulId = encodeURIComponent(`v1|${ref.itemId}|0`);
      const direct = await fetcher(`${EBAY_BROWSE_BASE}/item/${restfulId}`, { method: "GET", headers });
      if (direct.status === 404) return closedMissingVerdict(ref, now);
      if (direct.ok) {
        const item = await readJson(direct);
        if (!item) return unknownEbayVerdict(ref, "ebay_api_error", direct.status, now);
        return verdictFromBrowseItem(ref, item, direct.status, now);
      }
      return unknownEbayVerdict(ref, "ebay_api_error", direct.status, now);
    }
    return unknownEbayVerdict(ref, "ebay_api_error", legacy.status, now);
  } catch {
    return unknownEbayVerdict(ref, "ebay_api_error", 200, now);
  }
}
