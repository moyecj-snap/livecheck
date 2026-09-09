import { randomUUID } from "node:crypto";
import { CONFIRM_PRICE_USD } from "./config.js";
import { HUMAN_REVIEW_NEXT_STEP, applyConfirmedGate } from "./confirm-shared.js";
import { classifyListingPublished, LISTING_PUBLISHED_INTENT } from "./listing-published.js";
import { classifyOrderPlaced, ORDER_PLACED_INTENT } from "./order-placed.js";
import type { ConfirmIntent, ConfirmResult, ConfirmVerdictStatus, EvidenceLevel, FetchedPage } from "./types.js";
import { classify } from "./classify.js";
import { isEbayAdapterEnabled, parseEbayItemUrl, verifyEbayItem } from "./ebay.js";
import { VerifyError, fetchPage, parseTargetUrl } from "./verify.js";

export {
  CONFIRMED_MIN_CONFIDENCE,
  CONFIRMED_MIN_EVIDENCE_LEVEL,
  HUMAN_REVIEW_NEXT_STEP,
  applyConfirmedGate,
} from "./confirm-shared.js";

/** lead_submit L2 confirmed — at/above the confirmed gate; do not downgrade existing L2. */
export const LEAD_SUBMIT_L2_CONFIDENCE = 0.92;

export class UnsupportedIntentError extends VerifyError {
  readonly code = "unsupported_intent" as const;
  readonly intent: unknown;

  constructor(intent: unknown) {
    super(
      'unsupported_intent: only "lead_submit", "listing_published", and "order_placed" are accepted.',
      400,
    );
    this.name = "UnsupportedIntentError";
    this.intent = intent;
  }
}

export const LEAD_SUBMIT_INTENT = "lead_submit" as const;
export const PAYABLE_CONFIRM_INTENTS = [
  LEAD_SUBMIT_INTENT,
  LISTING_PUBLISHED_INTENT,
  ORDER_PLACED_INTENT,
] as const;
export type PayableConfirmIntent = (typeof PAYABLE_CONFIRM_INTENTS)[number];

function isPayableConfirmIntent(value: unknown): value is PayableConfirmIntent {
  return (
    value === LEAD_SUBMIT_INTENT ||
    value === LISTING_PUBLISHED_INTENT ||
    value === ORDER_PLACED_INTENT
  );
}

const FAILED_PHRASES = [
  "submission failed",
  "failed to submit",
  "unable to submit",
  "could not submit",
  "couldn't submit",
  "could not process your",
  "couldn't process your",
  "we were unable to process",
  "there was an error",
  "an error occurred",
  "something went wrong",
  "form could not be",
  "invalid submission",
  "your submission was rejected",
  "please try again",
];

const THANK_YOU_PHRASES = [
  "thank you",
  "thanks for",
  "we've received",
  "we have received",
  "your request has been received",
  "we'll be in touch",
  "submission received",
  "successfully submitted",
];

const ID_LABEL_PATTERNS = [
  /(?:confirmation|reference|ticket|lead)\s*(?:number|id|code|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i,
  /(?:confirmation|reference|ticket|lead)\s+(?:number|id|code)\s+is\s+([A-Z0-9][A-Z0-9-]{4,24})\b/i,
  /\b(?:ref|conf|ticket)\s*#\s*([A-Z0-9][A-Z0-9-]{4,24})\b/i,
];

const URL_TOKEN_KEYS = [
  "confirmation",
  "confirmation_id",
  "confirm",
  "ref",
  "reference",
  "ticket",
  "ticket_id",
  "lead_id",
  "leadid",
  "rid",
  "cid",
  "request_id",
  "submission_id",
];

const PATH_MARKERS = new Set(["thank-you", "thanks", "confirmation", "confirm", "submitted", "success"]);

const GENERIC_TOKENS = new Set([
  "thank-you",
  "thankyou",
  "thanks",
  "success",
  "successful",
  "welcome",
  "true",
  "false",
  "yes",
  "no",
  "lead",
  "submit",
  "submitted",
  "confirmation",
  "confirm",
  "reference",
  "ticket",
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

export function isUniqueToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 48) return false;
  if (GENERIC_TOKENS.has(trimmed.toLowerCase())) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return false;
  if (/^thank-?you/i.test(trimmed)) return false;
  // Prefer unknown over a hyphenated slug with no digits.
  return /\d/.test(trimmed);
}

export function extractUrlConfirmationToken(href: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }
  for (const key of URL_TOKEN_KEYS) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value && isUniqueToken(value)) return value;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (PATH_MARKERS.has(parts[i].toLowerCase()) && isUniqueToken(parts[i + 1])) {
      return parts[i + 1];
    }
  }
  return undefined;
}

export function extractLabeledConfirmationId(text: string): string | undefined {
  for (const pattern of ID_LABEL_PATTERNS) {
    const match = text.match(pattern);
    const id = match?.[1]?.trim();
    if (id && isUniqueToken(id)) return id;
  }
  return undefined;
}

export type ConfirmRequest = {
  url: string;
  intent: PayableConfirmIntent;
  claim?: Record<string, unknown>;
};

export function parseConfirmRequest(body: unknown): ConfirmRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new VerifyError(
      'JSON body must include { "url": "https://...", "intent": "lead_submit" | "listing_published" | "order_placed" }.',
    );
  }
  const record = body as { url?: unknown; intent?: unknown; claim?: unknown };
  const url = parseTargetUrl(record.url);
  if (!isPayableConfirmIntent(record.intent)) {
    throw new UnsupportedIntentError(record.intent);
  }
  if (record.claim !== undefined) {
    if (!record.claim || typeof record.claim !== "object" || Array.isArray(record.claim)) {
      throw new VerifyError("claim must be a JSON object when provided.");
    }
  }
  const parsed: ConfirmRequest = { url, intent: record.intent };
  if (record.claim && typeof record.claim === "object" && !Array.isArray(record.claim)) {
    parsed.claim = record.claim as Record<string, unknown>;
  }
  return parsed;
}

export function evidenceLevelFor(input: {
  verdict: ConfirmVerdictStatus;
  evidence_strength: 1 | 2;
  independent_evidence: boolean;
  signals: string[];
}): EvidenceLevel {
  if (input.verdict === "confirmed" && input.evidence_strength >= 2 && input.independent_evidence) {
    return 2;
  }
  if (
    input.independent_evidence &&
    input.signals.some((s) => s === "level_2" || s === "confirmation_id" || s === "confirmation_url_token")
  ) {
    return 2;
  }
  if (
    input.signals.some(
      (s) =>
        s.startsWith("failure_banner:") ||
        s === "thank_you_copy" ||
        s === "level_2_not_independent" ||
        s === "no_confirmation_id",
    )
  ) {
    return 1;
  }
  return 0;
}

export function confidenceFor(verdict: ConfirmVerdictStatus, evidenceLevel: EvidenceLevel): number {
  if (verdict === "confirmed") return LEAD_SUBMIT_L2_CONFIDENCE;
  if (verdict === "failed") return 0.8;
  if (evidenceLevel >= 1) return 0.48;
  return 0.22;
}

function finishResult(
  partial: Omit<ConfirmResult, "evidence_level" | "confidence" | "next_step">,
): ConfirmResult {
  const evidence_level = evidenceLevelFor(partial);
  let verdict = applyConfirmedGate(partial.verdict, confidenceFor(partial.verdict, evidence_level), evidence_level);
  const confidence = confidenceFor(verdict, evidence_level);
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

function cookielessFetch(fetcher: typeof fetch): { fetchImpl: typeof fetch; cookiesUsed: () => boolean } {
  let cookiesUsed = false;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    if (headers.has("cookie")) cookiesUsed = true;
    headers.delete("cookie");
    return fetcher(input, { ...init, headers });
  }) as typeof fetch;
  return { fetchImpl, cookiesUsed: () => cookiesUsed };
}

export function classifyLeadSubmit(
  page: FetchedPage,
  options: { cookiesUsed?: boolean; now?: Date; evidenceId?: string } = {},
): ConfirmResult {
  const now = options.now ?? new Date();
  const cookiesUsed = Boolean(options.cookiesUsed);
  const text = `${page.title ?? ""}\n${page.text}`.toLowerCase();
  const signals: string[] = [];
  const independent = !cookiesUsed;
  if (independent) signals.push("cookieless_fetch");
  else signals.push("cookies_used");

  const failedPhrase = includesPhrase(text, FAILED_PHRASES);
  const thankYou = includesPhrase(text, THANK_YOU_PHRASES);
  const labeledId = extractLabeledConfirmationId(`${page.title ?? ""}\n${page.text}`);
  const urlToken =
    extractUrlConfirmationToken(page.canonicalUrl) ?? extractUrlConfirmationToken(page.requestedUrl);
  const level2Id = labeledId ?? urlToken;

  if (failedPhrase) {
    signals.push(`failure_banner:${failedPhrase}`);
    return finishResult({
      verdict: "failed",
      effect: { type: "lead_submit" },
      evidence_strength: 1,
      signals,
      independent_signals: independent ? 1 : 0,
      independent_evidence: independent,
      evidence_id: options.evidenceId ?? evidenceId(),
      http_status: page.httpStatus,
      fetched_at: isoNow(now),
      url: page.requestedUrl,
      canonical_url: page.canonicalUrl,
      price_usd: CONFIRM_PRICE_USD,
    });
  }

  if (level2Id && independent) {
    if (labeledId) signals.push("confirmation_id");
    if (urlToken) signals.push("confirmation_url_token");
    signals.push("level_2");
    return finishResult({
      verdict: "confirmed",
      effect: { type: "lead_submit", id: level2Id },
      evidence_strength: 2,
      signals,
      independent_signals: 1,
      independent_evidence: true,
      evidence_id: options.evidenceId ?? evidenceId(),
      http_status: page.httpStatus,
      fetched_at: isoNow(now),
      url: page.requestedUrl,
      canonical_url: page.canonicalUrl,
      price_usd: CONFIRM_PRICE_USD,
    });
  }

  if (level2Id && !independent) {
    signals.push("level_2_not_independent");
  }
  if (thankYou) signals.push("thank_you_copy");
  if (!level2Id && !thankYou) signals.push("no_confirmation_id");

  return finishResult({
    verdict: "unknown",
    effect: { type: "lead_submit" },
    evidence_strength: 1,
    signals,
    independent_signals: independent ? 1 : 0,
    independent_evidence: independent,
    evidence_id: options.evidenceId ?? evidenceId(),
    http_status: page.httpStatus,
    fetched_at: isoNow(now),
    url: page.requestedUrl,
    canonical_url: page.canonicalUrl,
    price_usd: CONFIRM_PRICE_USD,
  });
}

export async function confirmListingPublishedUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  claim?: Record<string, unknown>,
): Promise<ConfirmResult> {
  const { fetchImpl, cookiesUsed } = cookielessFetch(fetcher);
  const ebay = parseEbayItemUrl(url);
  if (ebay && isEbayAdapterEnabled()) {
    const verify = await verifyEbayItem(ebay, fetchImpl, now);
    return classifyListingPublished(verify, { cookiesUsed: cookiesUsed(), now, claim });
  }
  const page = await fetchPage(url, fetchImpl);
  const verify = classify(page, now);
  return classifyListingPublished(verify, { cookiesUsed: cookiesUsed(), now, claim, page });
}

export async function confirmUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  options: { intent?: ConfirmIntent; claim?: Record<string, unknown> } = {},
): Promise<ConfirmResult> {
  const intent = options.intent ?? LEAD_SUBMIT_INTENT;
  if (intent === LISTING_PUBLISHED_INTENT) {
    return confirmListingPublishedUrl(url, fetcher, now, options.claim);
  }
  const { fetchImpl, cookiesUsed } = cookielessFetch(fetcher);
  const page = await fetchPage(url, fetchImpl);
  if (intent === ORDER_PLACED_INTENT) {
    return classifyOrderPlaced(page, { cookiesUsed: cookiesUsed(), now, claim: options.claim });
  }
  return classifyLeadSubmit(page, { cookiesUsed: cookiesUsed(), now });
}
