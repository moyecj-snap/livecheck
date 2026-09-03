import { PRICE_USD } from "./config.js";
import type { FetchedPage, SourceStatus, VerifyVerdict } from "./types.js";

const CLOSED_PHRASES = [
  "no longer accepting applications",
  "this job is closed to new applications",
  "this job is no longer available",
  "the job you are trying to apply for has been filled",
  "this position has been filled",
  "this job posting is no longer active",
  "no longer accepting applicants",
  "this requisition is closed",
  "sorry, this job is no longer available",
  "the job you are looking for is no longer available",
];

const APPLY_PHRASES = [
  "apply now",
  "apply for this job",
  "submit application",
  "start application",
  "apply for this position",
  "submit your application",
];

const LOGINWALL_PHRASES = [
  "sign in to continue",
  "log in to view",
  "please log in",
  "please sign in",
  "login required",
  "sign in to see",
  "authenticate to continue",
];

/** Real bot walls / interstitials — not a recaptcha widget on an apply or product form. */
const CHALLENGE_INTERSTITIAL_PHRASES = [
  "verify you are human",
  "checking your browser",
  "enable javascript and cookies to continue",
  "just a moment...",
  "attention required! | cloudflare",
];

const CHALLENGE_MARKERS = [
  "cf-challenge",
  "challenge-platform",
  "cf-browser-verification",
  "/cdn-cgi/challenge",
  "cf-turnstile-response",
];

const SOLD_OUT_PHRASES = [
  "sold out",
  "sold-out",
  "out of stock",
  "out-of-stock",
  "currently unavailable",
  "currently out of stock",
  "this item is unavailable",
  "this product is unavailable",
  "this item is currently unavailable",
  "this product is currently unavailable",
];

const BUY_PHRASES = ["add to cart", "add to bag", "add to basket", "buy now"];

function includesPhrase(haystack: string, phrases: string[]): string | null {
  for (const phrase of phrases) {
    if (haystack.includes(phrase)) return phrase;
  }
  return null;
}

function extractHostPath(url: string): { host: string; path: string; search: string } {
  try {
    const u = new URL(url);
    return {
      host: u.hostname.toLowerCase(),
      path: u.pathname.replace(/\/+$/, "") || "/",
      search: u.search,
    };
  } catch {
    return { host: "", path: "/", search: "" };
  }
}

function isAtsHost(host: string): boolean {
  return (
    host.endsWith("greenhouse.io") ||
    host.endsWith("lever.co") ||
    host.endsWith("ashbyhq.com") ||
    host.endsWith("myworkdayjobs.com") ||
    host.endsWith("icims.com")
  );
}

function looksLikeSpecificJobUrl(url: string): boolean {
  const { host, path } = extractHostPath(url);
  if (host.endsWith("greenhouse.io")) {
    return /\/jobs\/\d+/.test(path) || /\/embed\/job_app/.test(path);
  }
  if (host.endsWith("lever.co")) {
    return /\/[^/]+\/[0-9a-f-]{8,}/i.test(path) || /\/[^/]+\/[^/]+$/.test(path);
  }
  if (host.endsWith("ashbyhq.com")) {
    return /\/[^/]+\/[^/]+/.test(path) && !/\/jobs\/?$/.test(path);
  }
  return /\/(job|jobs|position|posting|requisition)s?\/[^/]+/i.test(path);
}

function looksLikeBoardOrSearchUrl(url: string): boolean {
  const { host, path, search } = extractHostPath(url);
  const q = search.toLowerCase();
  if (/[?&](q|query|search|keywords)=/.test(q)) return true;
  if (path.includes("/job_board") || path.includes("/embed/job_board")) return true;
  if (host.endsWith("greenhouse.io") && !/\/jobs\/\d+/.test(path)) return true;
  if (host.endsWith("lever.co") && path.split("/").filter(Boolean).length <= 1) return true;
  if (host.endsWith("ashbyhq.com") && (/\/jobs\/?$/.test(path) || path.split("/").filter(Boolean).length <= 1)) {
    return true;
  }
  if (/\/(careers|jobs)\/?$/.test(path)) return true;
  return false;
}

/** Shopify `/collections/.../products/handle` is a product, not a collection. */
function looksLikeSpecificProductUrl(url: string): boolean {
  const { path } = extractHostPath(url);
  return /\/products?\/[^/]+/i.test(path);
}

function looksLikeCollectionOrCategoryUrl(url: string): boolean {
  const { path, search } = extractHostPath(url);
  if (looksLikeSpecificProductUrl(url)) return false;
  const q = search.toLowerCase();
  if (/[?&](q|query|search)=/.test(q)) return true;
  if (/\/search\/?$/i.test(path) || /\/search\//i.test(path)) return true;
  if (/\/(collections?|categor(y|ies)|catalog)(\/|$)/i.test(path)) return true;
  return false;
}

function hasApplyAffordance(html: string, text: string): boolean {
  if (includesPhrase(text, APPLY_PHRASES)) return true;
  if (/\bapply\b/i.test(text) && /<(button|a|input)\b[^>]*>/i.test(html)) {
    if (/<(a|button)[^>]*>[^<]*\bapply\b/i.test(html)) return true;
    if (/<input[^>]*(value|aria-label)=["'][^"']*\bapply\b/i.test(html)) return true;
  }
  if (/<form[^>]+action=["'][^"']*apply/i.test(html)) return true;
  return false;
}

function hasBuyAffordance(html: string, text: string): boolean {
  if (includesPhrase(text, BUY_PHRASES)) return true;
  if (includesPhrase(html, BUY_PHRASES)) return true;
  return false;
}

function countJobCards(html: string, text: string): number {
  const cards = html.match(/class=["'][^"']*(job-card|opening|posting-card|job-listing)[^"']*/gi);
  if (cards && cards.length >= 3) return cards.length;
  const headings = text.match(/\b(view job|see opening|learn more)\b/gi);
  return headings?.length ?? 0;
}

function countProductCards(html: string): number {
  const cards = html.match(
    /class=["'][^"']*(product-card|product-grid-item|grid-product|collection-product|product-item)[^"']*/gi,
  );
  return cards?.length ?? 0;
}

function isChallengeInterstitial(html: string, text: string): boolean {
  if (includesPhrase(text, CHALLENGE_INTERSTITIAL_PHRASES) || includesPhrase(html, CHALLENGE_INTERSTITIAL_PHRASES)) {
    return true;
  }
  for (const marker of CHALLENGE_MARKERS) {
    if (html.includes(marker)) return true;
  }
  if (text.includes("attention required") && html.includes("cloudflare")) return true;
  return false;
}

export function classify(page: FetchedPage, checkedAt = new Date()): VerifyVerdict {
  const signals: string[] = [];
  const text = `${page.title ?? ""}\n${page.text}`.toLowerCase();
  const html = page.html.toLowerCase();

  let status: SourceStatus = "unknown";
  let confidence = 0.35;

  if (page.httpStatus === 404 || page.httpStatus === 410) {
    signals.push(`http_${page.httpStatus}`);
    status = "closed";
    confidence = 0.95;
  }

  const closedPhrase = includesPhrase(text, CLOSED_PHRASES);
  if (closedPhrase) {
    signals.push(`close_language:${closedPhrase}`);
    status = "closed";
    confidence = Math.max(confidence, 0.9);
  }

  const redirectedToBoard =
    page.redirected &&
    looksLikeSpecificJobUrl(page.requestedUrl) &&
    looksLikeBoardOrSearchUrl(page.canonicalUrl);

  if (redirectedToBoard) {
    signals.push("redirected_to_board");
    if (isAtsHost(extractHostPath(page.canonicalUrl).host) || isAtsHost(extractHostPath(page.requestedUrl).host)) {
      signals.push("ats_empty_state");
    }
    if (status !== "closed") {
      status = "closed";
      confidence = Math.max(confidence, 0.86);
    }
  }

  const challenge = isChallengeInterstitial(html, text);
  const loginwall = includesPhrase(text, LOGINWALL_PHRASES);
  if (challenge) {
    signals.push("challenge_page");
    if (status !== "closed") {
      status = "unknown";
      confidence = 0.55;
    }
  }
  if (loginwall) {
    signals.push("loginwalled");
    if (status !== "closed") {
      status = "unknown";
      confidence = 0.6;
    }
  }

  const specificPosting = looksLikeSpecificJobUrl(page.canonicalUrl) || looksLikeSpecificJobUrl(page.requestedUrl);
  const boardOrSearch = looksLikeBoardOrSearchUrl(page.canonicalUrl);
  const apply = hasApplyAffordance(page.html, text);
  const manyCards = countJobCards(page.html, page.text) >= 3;
  const collectionOrCategory =
    looksLikeCollectionOrCategoryUrl(page.canonicalUrl) || looksLikeCollectionOrCategoryUrl(page.requestedUrl);
  const specificProduct =
    looksLikeSpecificProductUrl(page.canonicalUrl) || looksLikeSpecificProductUrl(page.requestedUrl);
  const buy = hasBuyAffordance(html, text);
  const soldOutPhrase = includesPhrase(text, SOLD_OUT_PHRASES) || includesPhrase(html, SOLD_OUT_PHRASES);
  const manyProductCards = countProductCards(html) >= 3;
  const productPage = specificProduct || (buy && !collectionOrCategory && !manyProductCards && !specificPosting);

  if (boardOrSearch && !specificPosting) {
    signals.push("not_a_specific_posting");
    if (/\/(careers|jobs)\/?$/.test(extractHostPath(page.canonicalUrl).path)) {
      signals.push("careers_homepage");
    }
    if (status === "unknown" && !closedPhrase) {
      status = "unknown";
      confidence = Math.max(confidence, 0.5);
    }
  } else if (manyCards && !apply && status !== "closed") {
    signals.push("not_a_specific_posting");
  }

  if (collectionOrCategory && !specificProduct) {
    signals.push("collection_or_category");
    if (status !== "closed") {
      status = "unknown";
      confidence = Math.max(confidence, 0.5);
    }
  }

  const singlePostingPage = apply && !boardOrSearch && !manyCards && !closedPhrase;

  if (
    status !== "closed" &&
    !challenge &&
    !loginwall &&
    page.httpStatus >= 200 &&
    page.httpStatus < 300 &&
    (specificPosting || singlePostingPage) &&
    apply &&
    !closedPhrase &&
    !boardOrSearch
  ) {
    signals.push("apply form present");
    signals.push("no closure banner");
    status = "live";
    confidence = specificPosting ? 0.82 : 0.78;
  } else if (status !== "closed" && apply && page.httpStatus === 200 && !boardOrSearch && !challenge && !loginwall) {
    signals.push("apply form present");
    if (!closedPhrase) signals.push("no closure banner");
    if (!specificPosting) {
      signals.push("not_a_specific_posting");
      status = "unknown";
      confidence = 0.45;
    }
  }

  if (status !== "closed" && status !== "live" && !challenge && !loginwall && productPage && soldOutPhrase) {
    signals.push("sold-out");
    status = "closed";
    confidence = Math.max(confidence, 0.88);
  } else if (
    status !== "closed" &&
    status !== "live" &&
    !challenge &&
    !loginwall &&
    page.httpStatus >= 200 &&
    page.httpStatus < 300 &&
    productPage &&
    buy &&
    !soldOutPhrase &&
    !collectionOrCategory
  ) {
    signals.push("in-stock");
    status = "live";
    confidence = specificProduct ? 0.8 : 0.74;
  }

  if (status === "unknown" && page.httpStatus >= 200 && page.httpStatus < 300 && signals.length === 0) {
    signals.push("ambiguous_html");
  }

  return {
    url: page.requestedUrl,
    canonical_url: page.canonicalUrl,
    status,
    http_status: page.httpStatus,
    checked_at: checkedAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(page.title ? { title: page.title } : {}),
    signals,
    confidence,
    price_usd: PRICE_USD,
  };
}
