import { CONFIRM_PRICE_USD } from "./config.js";
import type { ConfirmEvidence, ConfirmIntent, ConfirmStatus, ConfirmVerdict, FetchedPage } from "./types.js";
import { VerifyError, fetchPage, parseTargetUrl } from "./verify.js";

export const LEAD_SUBMIT_INTENT: ConfirmIntent = "lead_submit";

const FAILED_PHRASES = [
  "submission failed",
  "form submission failed",
  "could not submit",
  "unable to submit",
  "failed to submit",
  "error submitting",
  "failed to send",
  "we could not process",
  "unable to send your",
  "invalid submission",
];

const THANK_YOU_PHRASES = [
  "thank you",
  "thanks for contacting",
  "thanks for your",
  "we received your",
  "we've received your",
  "your message has been sent",
  "your request has been received",
];

const LOGINWALL_PHRASES = [
  "sign in to continue",
  "log in to view",
  "please log in",
  "please sign in",
  "login required",
];

const CHALLENGE_PHRASES = [
  "verify you are human",
  "checking your browser",
  "cf-challenge",
  "enable javascript and cookies to continue",
];

/** Labeled confirmation / ref / ticket id with a real identifier value (Level-2). */
const LABELED_ID =
  /(?:(?:confirmation|reference|\bref\b|ticket|request|case)(?:\s*(?:number|no\.?|id|code))?|submission\s*(?:number|id|code))\s*[:#-]?\s*([A-Z0-9][-A-Z0-9]{3,})/i;

function includesPhrase(haystack: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

export function parseConfirmIntent(raw: unknown): ConfirmIntent {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new VerifyError('JSON body must include { "url": "https://...", "intent": "lead_submit" }.', 400);
  }
  const intent = raw.trim();
  if (intent !== LEAD_SUBMIT_INTENT) {
    throw new VerifyError("Day-1 Confirm accepts intent=lead_submit only.", 400);
  }
  return LEAD_SUBMIT_INTENT;
}

export function parseConfirmBody(body: unknown): { url: string; intent: ConfirmIntent } {
  if (typeof body !== "object" || body === null) {
    throw new VerifyError('JSON body must include { "url": "https://...", "intent": "lead_submit" }.', 400);
  }
  const record = body as { url?: unknown; intent?: unknown };
  return {
    url: parseTargetUrl(record.url),
    intent: parseConfirmIntent(record.intent),
  };
}

export function extractConfirmationId(text: string): { id: string; kind: string } | null {
  const match = text.match(LABELED_ID);
  if (!match?.[1]) return null;
  const id = match[1].replace(/[)\].,;]+$/, "");
  if (id.length < 4) return null;
  const label = match[0].toLowerCase();
  let kind = "confirmation_id";
  if (label.includes("ticket")) kind = "ticket_id";
  else if (label.includes("ref") || label.includes("reference")) kind = "ref_id";
  else if (label.includes("request") || label.includes("case")) kind = "request_id";
  return { id, kind };
}

export function classifyConfirm(page: FetchedPage, checkedAt = new Date()): ConfirmVerdict {
  const signals: string[] = [];
  const text = `${page.title ?? ""}\n${page.text}`;
  const lower = text.toLowerCase();
  const html = page.html.toLowerCase();

  const extracted = extractConfirmationId(text);
  const thankYou = includesPhrase(lower, THANK_YOU_PHRASES);
  const failedPhrase = includesPhrase(lower, FAILED_PHRASES);
  const challenge = includesPhrase(lower, CHALLENGE_PHRASES) || includesPhrase(html, CHALLENGE_PHRASES);
  const loginwall = includesPhrase(lower, LOGINWALL_PHRASES);

  let status: ConfirmStatus = "unknown";
  let confidence = 0.35;
  let evidence: ConfirmEvidence = { level: 0 };

  if (thankYou) {
    signals.push(`thank_you_language:${thankYou}`);
    evidence = { level: 1 };
  }

  if (extracted) {
    signals.push(`level2_${extracted.kind}:${extracted.id}`);
    evidence = { level: 2, confirmation_id: extracted.id, kind: extracted.kind };
  }

  if (failedPhrase) {
    signals.push(`submit_failed:${failedPhrase}`);
  }
  if (challenge) signals.push("challenge_page");
  if (loginwall) signals.push("loginwalled");

  if (extracted && evidence.level >= 2 && evidence.confirmation_id && !failedPhrase && !challenge && !loginwall) {
    status = "confirmed";
    confidence = 0.9;
  } else if (failedPhrase && !extracted) {
    status = "failed";
    confidence = 0.82;
  } else {
    status = "unknown";
    if (thankYou && !extracted) {
      signals.push("not_a_thank_you_page_classifier");
      confidence = 0.55;
    } else if (challenge || loginwall) {
      confidence = 0.6;
    } else if (page.httpStatus === 404 || page.httpStatus === 410) {
      signals.push(`http_${page.httpStatus}`);
      confidence = 0.5;
    } else if (signals.length === 0) {
      signals.push("ambiguous_html");
    }
  }

  return {
    url: page.requestedUrl,
    canonical_url: page.canonicalUrl,
    status,
    intent: LEAD_SUBMIT_INTENT,
    http_status: page.httpStatus,
    checked_at: checkedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(page.title ? { title: page.title } : {}),
    signals,
    confidence,
    price_usd: CONFIRM_PRICE_USD,
    evidence,
  };
}

/** Cookieless independent fetch — no Cookie header, actor ≠ verifier. */
export async function confirmUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
): Promise<ConfirmVerdict> {
  const page = await fetchPage(url, fetcher);
  return classifyConfirm(page, now);
}
