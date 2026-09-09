import type { ConfirmNextStep, ConfirmVerdictStatus, EvidenceLevel } from "./types.js";
import { parseEbayItemUrl } from "./ebay.js";

export const CONFIRMED_MIN_CONFIDENCE = 0.9;
export const CONFIRMED_MIN_EVIDENCE_LEVEL = 2;

export const HUMAN_REVIEW_NEXT_STEP: ConfirmNextStep = {
  action: "human_review",
  endpoint: "/v1/judge",
  est_price_usd: 1.0,
};

const GENERIC_LISTING_TOKENS = new Set([
  "job",
  "jobs",
  "product",
  "products",
  "item",
  "items",
  "apply",
  "new",
  "all",
  "index",
  "search",
  "careers",
  "collection",
  "collections",
  "category",
  "catalog",
  "shop",
  "store",
]);

function pathOf(url: string): { host: string; path: string; parts: string[] } | undefined {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "") || "/";
    return {
      host: parsed.hostname.toLowerCase(),
      path,
      parts: path.split("/").filter(Boolean),
    };
  } catch {
    return undefined;
  }
}

export function isListingToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 3 || trimmed.length > 80) return false;
  if (GENERIC_LISTING_TOKENS.has(trimmed.toLowerCase())) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return false;
  return true;
}

/** Extract a caller-provided listing identity from the URL. Never invents an id. */
export function extractListingIdFromUrl(url: string): string | undefined {
  const ebay = parseEbayItemUrl(url);
  if (ebay?.itemId) return ebay.itemId;

  const parsed = pathOf(url);
  if (!parsed) return undefined;
  const { host, path, parts } = parsed;

  const jobNum = path.match(/\/jobs\/(\d{3,})/i);
  if (jobNum?.[1]) return jobNum[1];

  const product = path.match(/\/products\/([A-Za-z0-9][A-Za-z0-9._-]{1,80})/i);
  if (product?.[1] && isListingToken(product[1])) return product[1];

  if (host.endsWith("lever.co") || host.endsWith("ashbyhq.com")) {
    const token = parts[parts.length - 1];
    if (token && isListingToken(token) && parts.length >= 2) return token;
  }

  const genericJob = path.match(/\/(?:jobs?|positions?|postings?|requisitions?)\/([^/]+)/i);
  if (genericJob?.[1] && isListingToken(genericJob[1])) return genericJob[1];

  const itm = path.match(/\/itm\/(?:[^/]+\/)?(\d{8,19})/i);
  if (itm?.[1]) return itm[1];

  return undefined;
}

export function isSpecificListingUrl(url: string): boolean {
  if (extractListingIdFromUrl(url)) return true;
  const parsed = pathOf(url);
  if (!parsed) return false;
  const { host, path } = parsed;
  if (host.endsWith("greenhouse.io") && /\/jobs\/\d+/.test(path)) return true;
  if (host.endsWith("lever.co") && parsed.parts.length >= 2) return true;
  if (host.endsWith("ashbyhq.com") && parsed.parts.length >= 2 && !/\/jobs\/?$/.test(path)) return true;
  if (/\/products?\/[^/]+/i.test(path)) return true;
  if (/\/(job|jobs|position|posting|requisition)s?\/[^/]+/i.test(path)) return true;
  return false;
}

/** New Confirm logic: confirmed requires confidence ≥ 0.90 and evidence_level ≥ 2. */
export function applyConfirmedGate(
  verdict: ConfirmVerdictStatus,
  confidence: number,
  evidenceLevel: EvidenceLevel,
): ConfirmVerdictStatus {
  if (verdict !== "confirmed") return verdict;
  if (confidence >= CONFIRMED_MIN_CONFIDENCE && evidenceLevel >= CONFIRMED_MIN_EVIDENCE_LEVEL) {
    return "confirmed";
  }
  return "unknown";
}
