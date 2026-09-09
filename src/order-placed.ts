import { randomUUID } from "node:crypto";
import { ORDER_PLACED_PRICE_USD } from "./config.js";
import { HUMAN_REVIEW_NEXT_STEP, applyConfirmedGate } from "./confirm-shared.js";
import type { ConfirmResult, ConfirmVerdictStatus, EvidenceLevel, FetchedPage } from "./types.js";

export const ORDER_PLACED_INTENT = "order_placed" as const;
export const ORDER_PLACED_L2_CONFIDENCE = 0.92;

const FAILED_PHRASES = [
  "payment failed",
  "payment declined",
  "card declined",
  "transaction declined",
  "transaction failed",
  "your payment was declined",
  "we could not process your payment",
  "unable to process your payment",
  "could not process your payment",
  "checkout failed",
  "order cancelled",
  "order canceled",
  "your order has been cancelled",
  "your order has been canceled",
  "this order was cancelled",
  "this order was canceled",
  "payment was not successful",
  "order could not be completed",
  "unable to complete your order",
  "your order could not be placed",
];

const THANK_YOU_PHRASES = [
  "thank you for your order",
  "thanks for your order",
  "thanks for shopping",
  "your order has been placed",
  "your order has been received",
  "we've received your order",
  "we have received your order",
  "order confirmed",
  "order received",
  "thanks for your purchase",
  "thank you for your purchase",
];

const CHALLENGE_PHRASES = [
  "verify you are human",
  "checking your browser",
  "just a moment...",
  "attention required! | cloudflare",
  "enable javascript to view this application",
];

const LOGINWALL_PHRASES = [
  "sign in to continue",
  "log in to view",
  "log in to see",
  "sign in to view",
  "please log in",
  "please sign in",
  "login required",
  "sign in to see",
  "authenticate to continue",
  "create an account to view",
  "log in to view your order",
  "sign in to view your order",
];

const ID_LABEL_PATTERNS = [
  /(?:order|confirmation|receipt|booking|reference|ticket)\s*(?:number|id|code|#)?\s*[:#]\s*([A-Z0-9][A-Z0-9-]{4,32})\b/i,
  /(?:order|confirmation|receipt|booking|reference|ticket)\s+(?:number|id|code)\s+is\s+([A-Z0-9][A-Z0-9-]{4,32})\b/i,
  /\byour\s+order\s+([A-Z0-9][A-Z0-9-]{4,32})\b/i,
  /\b(?:order|ord|conf|cnf|receipt|rcpt|ref|ticket)\s*#\s*([A-Z0-9][A-Z0-9-]{4,32})\b/i,
  /\border\s+(?:id|number)\s+([A-Z0-9][A-Z0-9-]{4,32})\b/i,
];

const URL_TOKEN_KEYS = [
  "order",
  "order_id",
  "orderid",
  "order_number",
  "ordernumber",
  "confirmation",
  "confirmation_id",
  "confirm",
  "receipt",
  "receipt_id",
  "ref",
  "reference",
  "ticket",
  "ticket_id",
  "booking",
  "booking_id",
];

const PATH_MARKERS = new Set([
  "thank-you",
  "thanks",
  "confirmation",
  "confirm",
  "success",
  "orders",
  "order",
  "receipt",
  "checkout",
]);

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
  "order",
  "orders",
  "checkout",
  "cart",
  "payment",
  "confirm",
  "confirmation",
  "receipt",
  "reference",
  "ticket",
  "placed",
  "complete",
  "completed",
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

export function isOrderToken(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 5 || trimmed.length > 48) return false;
  if (GENERIC_TOKENS.has(trimmed.toLowerCase())) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(trimmed)) return false;
  if (/^thank-?you/i.test(trimmed)) return false;
  return /\d/.test(trimmed);
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_#]+/g, "");
}

function pickClaimString(claim: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  if (!claim) return undefined;
  for (const key of keys) {
    const value = claim[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

export function extractUrlOrderToken(href: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return undefined;
  }
  for (const key of URL_TOKEN_KEYS) {
    const value = parsed.searchParams.get(key)?.trim();
    if (value && isOrderToken(value)) return value;
  }
  const parts = parsed.pathname.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const marker = parts[i].toLowerCase();
    if ((PATH_MARKERS.has(marker) || marker === "order-status" || marker === "order-confirmation") && isOrderToken(parts[i + 1])) {
      return parts[i + 1];
    }
  }
  return undefined;
}

export function extractLabeledOrderId(text: string): string | undefined {
  for (const pattern of ID_LABEL_PATTERNS) {
    const matches = text.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
    for (const match of matches) {
      const id = match[1]?.trim();
      if (id && isOrderToken(id)) return id;
    }
  }
  return undefined;
}

function looksLikeLoginwall(text: string): boolean {
  return Boolean(includesPhrase(text, LOGINWALL_PHRASES));
}

function claimMismatch(
  claim: Record<string, unknown> | undefined,
  extractedId: string | undefined,
  pageText: string,
): string | undefined {
  if (!claim) return undefined;
  const claimedId = pickClaimString(claim, ["order_id", "order", "id", "confirmation", "receipt"]);
  const claimedTotal = pickClaimString(claim, ["total", "amount", "grand_total"]);
  const claimedDomain = pickClaimString(claim, ["email_domain", "domain"]);

  if (claimedId && extractedId && normalizeToken(claimedId) !== normalizeToken(extractedId)) {
    return "claim_order_id_mismatch";
  }
  if (claimedTotal) {
    const labeled = pageText.match(
      /(?:order\s+total|grand\s+total|amount\s+due|total)\s*[:$]\s*\$?\s*([0-9]{1,7}(?:\.[0-9]{2})?)/i,
    );
    if (labeled?.[1]) {
      const seen = labeled[1].replace(/[^0-9.]/g, "");
      const claimed = claimedTotal.replace(/[^0-9.]/g, "");
      if (seen && claimed && seen !== claimed) return "claim_total_mismatch";
    }
  }
  if (claimedDomain) {
    const emails = pageText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
    if (emails.length) {
      const domain = claimedDomain.replace(/^@/, "").toLowerCase();
      const anyMatch = emails.some((email) => email.toLowerCase().endsWith(`@${domain}`));
      if (domain && !anyMatch) return "claim_email_domain_mismatch";
    }
  }
  return undefined;
}

export function orderPlacedEvidenceLevel(input: {
  verdict: ConfirmVerdictStatus;
  independent_evidence: boolean;
  signals: string[];
}): EvidenceLevel {
  if (
    input.verdict === "confirmed" &&
    input.independent_evidence &&
    (input.signals.includes("level_2") ||
      input.signals.includes("order_id") ||
      input.signals.includes("order_url_token"))
  ) {
    return 2;
  }
  if (
    input.independent_evidence &&
    input.signals.includes("level_2") &&
    (input.signals.includes("order_id") || input.signals.includes("order_url_token"))
  ) {
    return 2;
  }
  if (
    input.signals.some(
      (s) =>
        s.startsWith("failure_banner:") ||
        s === "thank_you_copy" ||
        s === "loginwalled" ||
        s === "challenge_page" ||
        s === "level_2_not_independent" ||
        s === "no_order_id" ||
        s === "claim_mismatch" ||
        s === "ambiguous_status",
    )
  ) {
    return 1;
  }
  return 0;
}

export function orderPlacedConfidence(
  verdict: ConfirmVerdictStatus,
  evidenceLevel: EvidenceLevel,
): number {
  if (verdict === "confirmed") return ORDER_PLACED_L2_CONFIDENCE;
  if (verdict === "failed") return 0.8;
  if (evidenceLevel >= 1) return 0.48;
  return 0.22;
}

function finishOrderPlaced(
  partial: Omit<ConfirmResult, "evidence_level" | "confidence" | "next_step">,
): ConfirmResult {
  const evidence_level = orderPlacedEvidenceLevel(partial);
  let verdict = applyConfirmedGate(
    partial.verdict,
    orderPlacedConfidence(partial.verdict, evidence_level),
    evidence_level,
  );
  const confidence = orderPlacedConfidence(verdict, evidence_level);
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

export function classifyOrderPlaced(
  page: FetchedPage,
  options: {
    cookiesUsed?: boolean;
    now?: Date;
    evidenceId?: string;
    claim?: Record<string, unknown>;
  } = {},
): ConfirmResult {
  const now = options.now ?? new Date();
  const cookiesUsed = Boolean(options.cookiesUsed);
  const rawText = `${page.title ?? ""}\n${page.text}`;
  const text = rawText.toLowerCase();
  const signals: string[] = [];
  const independent = !cookiesUsed;
  if (independent) signals.push("cookieless_fetch");
  else signals.push("cookies_used");

  const failedPhrase = includesPhrase(text, FAILED_PHRASES);
  const thankYou = includesPhrase(text, THANK_YOU_PHRASES);
  const loginwall = looksLikeLoginwall(text);
  const challenge =
    Boolean(includesPhrase(text, CHALLENGE_PHRASES)) ||
    page.html.toLowerCase().includes("cf-challenge");
  const labeledId = extractLabeledOrderId(rawText);
  const urlToken = extractUrlOrderToken(page.canonicalUrl) ?? extractUrlOrderToken(page.requestedUrl);
  const level2Id = labeledId ?? urlToken;
  const mismatch = claimMismatch(options.claim, level2Id, rawText);

  if (labeledId) signals.push("order_id");
  if (urlToken) signals.push("order_url_token");
  if (thankYou) signals.push("thank_you_copy");
  if (loginwall) signals.push("loginwalled");
  if (challenge) signals.push("challenge_page");
  if (mismatch) {
    signals.push("claim_mismatch");
    signals.push(mismatch);
  }

  const base = {
    effect: {
      type: ORDER_PLACED_INTENT,
      ...(level2Id && independent && !mismatch ? { id: level2Id } : {}),
    },
    signals,
    independent_signals: independent ? 1 : 0,
    independent_evidence: independent,
    evidence_id: options.evidenceId ?? evidenceId(),
    http_status: page.httpStatus,
    fetched_at: isoNow(now),
    url: page.requestedUrl,
    canonical_url: page.canonicalUrl,
    price_usd: ORDER_PLACED_PRICE_USD,
  } as const;

  if (failedPhrase) {
    signals.push(`failure_banner:${failedPhrase}`);
    return finishOrderPlaced({
      ...base,
      effect: { type: ORDER_PLACED_INTENT },
      verdict: "failed",
      evidence_strength: 1,
      signals,
    });
  }

  // Honesty: thank-you fluff, login walls, cookies, or claim mismatch never confirm.
  // Confirmed only with an independent order/confirmation/ref/ticket id on the page or URL.
  const canConfirm = Boolean(level2Id) && independent && !loginwall && !challenge && !mismatch;

  if (canConfirm && level2Id) {
    signals.push("level_2");
    return finishOrderPlaced({
      ...base,
      effect: { type: ORDER_PLACED_INTENT, id: level2Id },
      verdict: "confirmed",
      evidence_strength: 2,
      signals,
    });
  }

  if (level2Id && !independent) signals.push("level_2_not_independent");
  if (!level2Id) signals.push("no_order_id");
  if (!thankYou && !loginwall && !level2Id) signals.push("ambiguous_status");

  return finishOrderPlaced({
    ...base,
    effect: { type: ORDER_PLACED_INTENT },
    verdict: "unknown",
    evidence_strength: 1,
    signals,
  });
}
