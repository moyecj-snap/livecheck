import { randomUUID } from "node:crypto";
import { CONFIRM_PRICE_USD } from "./config.js";
import {
  HUMAN_REVIEW_NEXT_STEP,
  applyConfirmedGate,
  extractListingIdFromUrl,
  isSpecificListingUrl,
} from "./confirm-shared.js";
import { parseEbayItemUrl } from "./ebay.js";
import type {
  ConfirmResult,
  ConfirmVerdictStatus,
  EvidenceLevel,
  FetchedPage,
  VerifyVerdict,
} from "./types.js";

export const LISTING_PUBLISHED_INTENT = "listing_published" as const;
export const LISTING_PUBLISHED_L2_CONFIDENCE = 0.92;

const STRONG_LIVE_SIGNALS = ["in-stock", "apply form present", "ebay-in-stock"] as const;

const THANK_YOU_PHRASES = [
  "thank you",
  "thanks for",
  "we've received",
  "we have received",
  "your request has been received",
  "we'll be in touch",
  "submission received",
  "successfully submitted",
  "your listing is now live",
  "your listing has been published",
  "successfully published",
];

const THANK_YOU_PATHS = new Set([
  "thank-you",
  "thanks",
  "confirmation",
  "confirm",
  "submitted",
  "success",
  "checkout/success",
  "order/confirmation",
]);

function includesPhrase(haystack: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function evidenceId(): string {
  return `ev_${randomUUID()}`;
}

function pickClaimString(claim: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!claim) return undefined;
  for (const key of keys) {
    const value = claim[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, "-");
}

function titlesCompatible(expected: string, observed: string): boolean {
  const a = normalizeToken(expected);
  const b = normalizeToken(observed);
  if (!a || !b) return true;
  return a.includes(b) || b.includes(a);
}

export function pageLooksLikeThankYou(page: FetchedPage | undefined, url: string): boolean {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.toLowerCase().split("/").filter(Boolean);
    if (parts.some((part) => THANK_YOU_PATHS.has(part))) return true;
    const joined = parts.join("/");
    if (joined.includes("thank-you") || joined.includes("checkout/success")) return true;
  } catch {
    // ignore
  }
  if (!page) return false;
  const text = `${page.title ?? ""}\n${page.text}`.toLowerCase();
  return Boolean(includesPhrase(text, THANK_YOU_PHRASES));
}

export function hasStrongLiveSignal(signals: readonly string[]): boolean {
  return STRONG_LIVE_SIGNALS.some((signal) => signals.includes(signal));
}

export function listingPublishedEvidenceLevel(input: {
  verdict: ConfirmVerdictStatus;
  independent_evidence: boolean;
  signals: string[];
}): EvidenceLevel {
  if (
    input.verdict === "confirmed" &&
    input.independent_evidence &&
    (input.signals.includes("level_2") ||
      input.signals.includes("listing_id") ||
      input.signals.includes("specific_listing_url"))
  ) {
    return 2;
  }
  if (
    input.independent_evidence &&
    input.signals.includes("level_2") &&
    (input.signals.includes("listing_id") || input.signals.includes("specific_listing_url"))
  ) {
    return 2;
  }
  if (
    input.signals.some(
      (s) =>
        s === "thank_you_copy" ||
        s === "verify_closed" ||
        s === "verify_unknown" ||
        s === "verify_live" ||
        s === "claim_mismatch" ||
        s === "not_a_specific_posting" ||
        s === "collection_or_category" ||
        s === "soft_live_signal" ||
        s.startsWith("http_"),
    )
  ) {
    return 1;
  }
  return 0;
}

export function listingPublishedConfidence(
  verdict: ConfirmVerdictStatus,
  evidenceLevel: EvidenceLevel,
  signals: readonly string[],
): number {
  if (verdict === "confirmed") return LISTING_PUBLISHED_L2_CONFIDENCE;
  if (verdict === "failed") {
    if (signals.some((s) => s === "http_404" || s === "http_410" || s === "sold-out" || s === "ebay-ended")) {
      return 0.9;
    }
    return 0.8;
  }
  if (evidenceLevel >= 1) return 0.48;
  return 0.22;
}

function finishListingPublished(
  partial: Omit<ConfirmResult, "evidence_level" | "confidence" | "next_step">,
): ConfirmResult {
  const evidence_level = listingPublishedEvidenceLevel(partial);
  let verdict = applyConfirmedGate(
    partial.verdict,
    listingPublishedConfidence(partial.verdict, evidence_level, partial.signals),
    evidence_level,
  );
  const confidence = listingPublishedConfidence(verdict, evidence_level, partial.signals);
  const result: ConfirmResult = {
    ...partial,
    verdict,
    evidence_level,
    confidence,
  };
  if (verdict === "unknown") {
    result.next_step = HUMAN_REVIEW_NEXT_STEP;
  }
  return result;
}

function claimMismatch(
  claim: Record<string, unknown> | undefined,
  verify: VerifyVerdict,
  listingId: string | undefined,
  page: FetchedPage | undefined,
): string | undefined {
  if (!claim) return undefined;
  const claimedId = pickClaimString(claim, ["id", "listing_id", "sku", "item_id", "job_id"]);
  const claimedTitle = pickClaimString(claim, ["title", "expected_title", "name"]);
  const claimedSku = pickClaimString(claim, ["sku"]);

  if (claimedId && listingId && normalizeToken(claimedId) !== normalizeToken(listingId)) {
    return "claim_id_mismatch";
  }
  if (claimedSku && listingId && normalizeToken(claimedSku) !== normalizeToken(listingId)) {
    const haystack = `${verify.title ?? ""}\n${page?.text ?? ""}`.toLowerCase();
    if (!haystack.includes(claimedSku.toLowerCase())) return "claim_sku_mismatch";
  }
  const observedTitle = verify.title ?? page?.title ?? "";
  if (claimedTitle && observedTitle && !titlesCompatible(claimedTitle, observedTitle)) {
    return "claim_title_mismatch";
  }
  return undefined;
}

export function classifyListingPublished(
  verify: VerifyVerdict,
  options: {
    cookiesUsed?: boolean;
    claim?: Record<string, unknown>;
    now?: Date;
    page?: FetchedPage;
    evidenceId?: string;
  } = {},
): ConfirmResult {
  const now = options.now ?? new Date();
  const cookiesUsed = Boolean(options.cookiesUsed);
  const independent = !cookiesUsed;
  const signals = [...verify.signals];
  if (independent) signals.push("cookieless_fetch");
  else signals.push("cookies_used");

  const listingId =
    extractListingIdFromUrl(verify.url) ??
    extractListingIdFromUrl(verify.canonical_url) ??
    parseEbayItemUrl(verify.url)?.itemId ??
    parseEbayItemUrl(verify.canonical_url)?.itemId;
  const specific =
    isSpecificListingUrl(verify.url) ||
    isSpecificListingUrl(verify.canonical_url) ||
    Boolean(listingId);
  const thankYou = pageLooksLikeThankYou(options.page, verify.url) || pageLooksLikeThankYou(options.page, verify.canonical_url);
  const mismatch = claimMismatch(options.claim, verify, listingId, options.page);
  const strong = hasStrongLiveSignal(verify.signals);

  if (listingId) signals.push("listing_id");
  if (specific) signals.push("specific_listing_url");
  if (thankYou) signals.push("thank_you_copy");
  if (mismatch) {
    signals.push("claim_mismatch");
    signals.push(mismatch);
  }
  if (verify.status === "live") signals.push("verify_live");
  else if (verify.status === "closed") signals.push("verify_closed");
  else signals.push("verify_unknown");

  const base = {
    effect: {
      type: LISTING_PUBLISHED_INTENT,
      ...(listingId ? { id: listingId } : {}),
    },
    signals,
    independent_signals: independent ? 1 : 0,
    independent_evidence: independent,
    evidence_id: options.evidenceId ?? evidenceId(),
    http_status: verify.http_status,
    fetched_at: isoNow(now),
    url: verify.url,
    canonical_url: verify.canonical_url,
    price_usd: CONFIRM_PRICE_USD,
  } as const;

  if (verify.status === "closed") {
    return finishListingPublished({
      ...base,
      verdict: "failed",
      evidence_strength: 1,
    });
  }

  // Honesty: thank-you fluff, cookies, claim mismatch, or soft/non-specific live never confirm.
  const canConfirm =
    independent &&
    !thankYou &&
    !mismatch &&
    verify.status === "live" &&
    strong &&
    specific &&
    !verify.signals.includes("not_a_specific_posting") &&
    !verify.signals.includes("collection_or_category") &&
    !verify.signals.includes("challenge_page") &&
    !verify.signals.includes("loginwalled");

  if (canConfirm) {
    signals.push("level_2");
    return finishListingPublished({
      ...base,
      verdict: "confirmed",
      evidence_strength: 2,
      signals,
    });
  }

  if (verify.status === "live" && !strong) signals.push("soft_live_signal");
  if (verify.status === "live" && !specific) signals.push("not_a_specific_posting");

  return finishListingPublished({
    ...base,
    verdict: "unknown",
    evidence_strength: 1,
    signals,
  });
}
