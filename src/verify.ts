import { lookupAtsJob, combinePageAndAts, feedMissIsNotClosed, parseAtsJobUrl, verdictFromAtsWithoutPage } from "./ats-api.js";
import { roleRefFor } from "./free-job-role.js";
import { resolveGuessedGreenhouseMiss } from "./gh-jid-board.js";
import { CHECK_TIMEOUT_SIGNAL, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, PRICE_USD, USER_AGENT } from "./config.js";
import { classify } from "./classify.js";
import { ROBOTS_FETCH_TIMEOUT_MS, robotsAllows, robotsStrictTimeoutMs, type RobotsMode } from "./robots.js";
import { DeadlineError, isAbortLike, linkedAbort, resolveDeadlineMs, withDeadline } from "./deadline.js";
import { isEbayAdapterEnabled, logEbayAdapterDisabled, parseEbayItemUrl, verifyEbayItem } from "./ebay.js";
import {
  applyOwnListingAvailability,
  applyPoshmarkAvailability,
  ebayOwnHtmlReading,
  poshmarkListingId,
  poshmarkOwnAvailability,
  poshmarkOwnReading,
} from "./own-listing.js";
import { shopifyProductJsUrl } from "./shopify.js";
import {
  applyVariantDecision,
  backupFailed,
  decideVariants,
  linkedVariantSelector,
  lookupShopifyProduct,
  schemaVariants,
} from "./product-variants.js";
import { stripTrackingParams } from "./tracking-params.js";
import { readCappedBody } from "./capped-body.js";
import { guardTruncatedVerdict, hasStructuredAvailability, logPageTruncated } from "./page-truncation.js";
import type { FetchedPage, VerifyVerdict } from "./types.js";
import { AGE_CONFLICT_SIGNAL, DEFAULT_STALE_AFTER_DAYS, jsonLdJobPosting, resolvePostingAge, type AgeEvidence } from "./posting-age.js";

export type VerifyUrlOptions = {
  /**
   * Consult public Ashby, Workday, Lever, and Greenhouse board APIs.
   * POST /v1/verify and POST /v1/verify/job set this. Sentinel check and
   * watch-chain verify leave it off.
   */
  atsApi?: boolean;
  /** Whole-check budget. Defaults to VERIFY_DEADLINE_MS. */
  deadlineMs?: number;
  /** Outer abort. When it fires, verify returns unknown + check_timeout. */
  signal?: AbortSignal;
  /**
   * robots.txt when the file cannot be fetched.
   * `lenient` (default): wait 500ms, then fetch the page. Public paid routes,
   * free /job, checks, and watches leave this unset and do not accept it from
   * callers.
   * `strict`: wait 5s. No robots file means unknown + robots_unavailable, with
   * no page fetch and no ATS lookup. Audits and pilots pass this.
   */
  robotsMode?: RobotsMode;
  /**
   * Add the posting `age` object. `job`: always (POST /v1/verify/job).
   * `auto`: only when the link is an ATS job or the page has a JobPosting
   * (POST /v1/verify). Context only: status and confidence never change.
   */
  age?: { mode: "job" | "auto"; staleAfterDays?: number };
};

/** What the check learned about the posting date, filled in as it runs. */
type AgeContext = { atsRef: boolean; ats?: AgeEvidence; jobPosting: boolean; jsonLdDatePosted?: unknown };

function withAge(verdict: VerifyVerdict, ctx: AgeContext, now: Date, options: VerifyUrlOptions): VerifyVerdict {
  const age = options.age;
  if (!age) return verdict;
  if (age.mode === "auto" && !ctx.atsRef && !ctx.jobPosting) return verdict;
  const resolved = resolvePostingAge({
    ats: ctx.ats,
    jsonLdDatePosted: ctx.jsonLdDatePosted,
    now,
    staleAfterDays: age.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS,
    status: verdict.status,
  });
  // HARD RULE (Craig, Nov 3, 2026): dates never change status or confidence.
  return {
    ...verdict,
    status: verdict.status,
    confidence: verdict.confidence,
    signals: resolved.conflict && !verdict.signals.includes(AGE_CONFLICT_SIGNAL) ? [...verdict.signals, AGE_CONFLICT_SIGNAL] : verdict.signals,
    age: resolved.age,
  };
}

export type FetchPageOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Posting and listing checks only. Confirm and other fetchPage callers
   * leave this off so they do not request robots.txt.
   */
  robots?: boolean;
  /** Defaults to lenient. Strict skips the page when robots.txt does not answer. */
  robotsMode?: RobotsMode;
  /** Called after robots.txt allows, before the page body is read. */
  afterRobots?: () => void;
};

/** One wait before a second LinkedIn fetch. Tests set this to 0. */
export const LINKEDIN_429_DELAY_MS = 1_000;
let linkedIn429DelayMs = LINKEDIN_429_DELAY_MS;

export function setLinkedIn429DelayForTests(ms: number | null): void {
  linkedIn429DelayMs = ms ?? LINKEDIN_429_DELAY_MS;
}

function isLinkedInPage(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "linkedin.com" || host.endsWith(".linkedin.com");
  } catch {
    return false;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      const error = new Error("aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class VerifyError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "VerifyError";
    this.status = status;
  }
}

export function parseTargetUrl(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new VerifyError('JSON body must include { "url": "https://..." }.');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new VerifyError("url must be an absolute http(s) URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new VerifyError("Only http and https URLs are accepted.");
  }
  return parsed.href;
}

function extractTitle(html: string): string | null {
  const og = html.match(
    /<meta[^>]+(?:property|name)=["']og:title["'][^>]+content=["']([^"']+)["']/i,
  );
  if (og?.[1]) return decode(og[1]).trim();
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (title?.[1]) return decode(title[1]).trim();
  return null;
}

function decode(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function timeoutUnknownVerdict(url: string, now = new Date()): VerifyVerdict {
  return {
    url,
    canonical_url: url,
    status: "unknown",
    http_status: 0,
    checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    signals: [CHECK_TIMEOUT_SIGNAL],
    confidence: 0,
    price_usd: PRICE_USD,
  };
}

export async function fetchPage(
  url: string,
  fetcher: typeof fetch = fetch,
  options: FetchPageOptions = {},
): Promise<FetchedPage> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS;
  // One clock for robots.txt and the page. A robots timeout cannot push the
  // page past this budget, and a 40ms page timeout still fails in about 40ms.
  const linked = linkedAbort(timeoutMs, options.signal);
  // Aborted once the body passes MAX_BODY_BYTES so the connection closes.
  const capStop = new AbortController();
  const redirectChain: string[] = [];
  try {
    if (options.robots) {
      const robotsMode = options.robotsMode ?? "lenient";
      const robotsCap = robotsMode === "strict" ? robotsStrictTimeoutMs() : ROBOTS_FETCH_TIMEOUT_MS;
      const robotsTimeout = Math.min(robotsCap, timeoutMs);
      let robots: Awaited<ReturnType<typeof robotsAllows>>;
      try {
        robots = await robotsAllows(url, fetcher, { signal: linked.signal, timeoutMs: robotsTimeout, mode: robotsMode });
      } catch (error) {
        if (error instanceof DeadlineError || options.signal?.aborted) {
          throw error instanceof DeadlineError ? error : new DeadlineError(resolveDeadlineMs());
        }
        if (linked.signal.aborted) {
          throw new VerifyError(`Timed out fetching ${url} after ${timeoutMs}ms.`, 504);
        }
        throw error;
      }
      if (!robots.allowed) {
        return {
          requestedUrl: url,
          canonicalUrl: url,
          httpStatus: 0,
          title: null,
          html: "",
          text: "",
          redirected: false,
          redirectChain: [],
          ...(robots.reason === "unavailable" ? { robotsUnavailable: true } : { robotsDisallowed: true }),
        };
      }
    }
    options.afterRobots?.();

    const fetchInit = {
      method: "GET" as const,
      redirect: "follow" as const,
      signal: AbortSignal.any([linked.signal, capStop.signal]),
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": USER_AGENT,
      },
    };
    let response = await fetcher(url, fetchInit);
    if (response.status === 429 && isLinkedInPage(url)) {
      await delay(linkedIn429DelayMs, options.signal);
      response = await fetcher(url, fetchInit);
    }

    const canonicalUrl = response.url || url;
    if (canonicalUrl !== url) redirectChain.push(canonicalUrl);

    // Stream the body and stop at MAX_BODY_BYTES; the rest is never downloaded.
    const body = await readCappedBody(response, MAX_BODY_BYTES, () => capStop.abort());
    const truncated = body.truncated;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(body.bytes);
    if (truncated) {
      logPageTruncated({ url: canonicalUrl, bodyBytes: body.received, limitBytes: MAX_BODY_BYTES, httpStatus: response.status });
    }

    return {
      requestedUrl: url,
      canonicalUrl,
      httpStatus: response.status,
      title: extractTitle(html),
      html,
      text: stripTags(html),
      redirected: canonicalUrl.replace(/\/$/, "") !== url.replace(/\/$/, ""),
      redirectChain,
  ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    if (error instanceof DeadlineError || options.signal?.aborted) {
      throw error instanceof DeadlineError ? error : new DeadlineError(resolveDeadlineMs());
    }
    if (isAbortLike(error) || linked.signal.aborted) {
      throw new VerifyError(`Timed out fetching ${url} after ${timeoutMs}ms.`, 504);
    }
    const message = error instanceof Error ? error.message : "fetch failed";
    throw new VerifyError(`Could not fetch URL: ${message}`, 502);
  } finally {
    linked.cancel();
  }
}

async function withShopify(
  requested: string,
  verdict: VerifyVerdict,
  html: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<{ verdict: VerifyVerdict; ownFieldFound: boolean }> {
  const jsUrl = shopifyProductJsUrl(verdict.canonical_url) ?? shopifyProductJsUrl(requested);
  if (!jsUrl) return { verdict, ownFieldFound: false };
  // The link the caller sent names the variant (?variant=, ?color=, ...).
  const selector = linkedVariantSelector(requested);
  const found = await lookupShopifyProduct(jsUrl, fetcher, signal);
  if (found) {
    const decision = decideVariants(found.variants, selector, found.available);
    if (decision) return { verdict: applyVariantDecision(verdict, decision, "shopify", found.title), ownFieldFound: true };
    return { verdict, ownFieldFound: false };
  }
  // product.js is missing (headless storefronts 404 it). Read per-variant
  // schema.org offers from the page; if there are none, can't tell.
  if (verdict.http_status >= 200 && verdict.http_status < 300) {
    const variants = schemaVariants(html);
    const decision = variants.length ? decideVariants(variants, selector) : null;
    if (decision) return { verdict: applyVariantDecision(verdict, decision, "schema"), ownFieldFound: true };
  }
  return { verdict: backupFailed(verdict), ownFieldFound: false };
}

export async function verifyUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  options: VerifyUrlOptions = {},
): Promise<VerifyVerdict> {
  const deadlineMs = resolveDeadlineMs(options.deadlineMs);
  const target = stripTrackingParams(url);
  const ageCtx: AgeContext = { atsRef: false, jobPosting: false };
  try {
    const verdict = await withDeadline(deadlineMs, (deadlineSignal) => {
      const signal = options.signal ? AbortSignal.any([deadlineSignal, options.signal]) : deadlineSignal;
      return verifyUrlWithin(target, fetcher, now, options, signal, ageCtx);
    });
    return withAge(verdict, ageCtx, now, options);
  } catch (error) {
    if (error instanceof DeadlineError) return withAge(timeoutUnknownVerdict(url, now), ageCtx, now, options);
    throw error;
  }
}

async function verifyUrlWithin(
  url: string,
  fetcher: typeof fetch,
  now: Date,
  options: VerifyUrlOptions,
  signal: AbortSignal,
  ageCtx: AgeContext = { atsRef: false, jobPosting: false },
): Promise<VerifyVerdict> {
  const ebay = parseEbayItemUrl(url);
  if (ebay) {
    if (isEbayAdapterEnabled()) {
      return verifyEbayItem(ebay, fetcher, now, signal);
    }
    logEbayAdapterDisabled();
  }
  // Company careers embeds (Figma and others) pass the Greenhouse id as gh_jid
  // instead of a boards.greenhouse.io URL. roleRefFor resolves that id.
  const direct = options.atsApi ? parseAtsJobUrl(url) : null;
  let ats = options.atsApi ? direct ?? roleRefFor(url) : null;
  // A board token guessed from the company host can be wrong (Datadog:
  // careers.datadoghq.com, board "datadog"). Its miss is re-checked below.
  const boardGuessed = Boolean(ats && !direct);
  if (ats) ageCtx.atsRef = true;
  let atsLookup: Promise<Awaited<ReturnType<typeof lookupAtsJob>>> | undefined;
  const page = await fetchPage(url, fetcher, {
    signal,
    robots: true,
    robotsMode: options.robotsMode,
    afterRobots: () => {
      if (ats) atsLookup = lookupAtsJob(ats, fetcher, { signal });
    },
  }).then(
    (fetched) => ({ ok: true as const, page: fetched }),
    (error: unknown) => {
      if (error instanceof DeadlineError) throw error;
      return { ok: false as const, error };
    },
  );
  if (page.ok && (page.page.robotsDisallowed || page.page.robotsUnavailable)) return classify(page.page, now);
  if (page.ok && options.age) {
    // JSON-LD datePosted is read for the age only, never for the verdict.
    const posting = jsonLdJobPosting(page.page.html);
    if (posting) {
      ageCtx.jobPosting = true;
      ageCtx.jsonLdDatePosted = posting.datePosted;
    }
  }
  if (!ats || !atsLookup) {
    if (!page.ok) throw page.error;
    if (ebay) {
      // HTML fallback (Browse adapter off): the item's own offer decides;
      // "Similar sold items" on the page is ignored.
      const verdict = classify(page.page, now);
      const reading = ebayOwnHtmlReading(page.page.html, ebay.itemId);
      return guardTruncatedVerdict(
        applyOwnListingAvailability(verdict, reading, "ebay_item"),
        page.page.truncated,
        reading !== undefined,
      );
    }
    const posh = poshmarkListingId(page.page.canonicalUrl) ?? poshmarkListingId(url);
    if (posh) {
      // The listing's own availability field decides; similar-items and
      // Sold Listings text on the page is ignored.
      const own = poshmarkOwnAvailability(page.page.html, posh);
      return guardTruncatedVerdict(
        applyPoshmarkAvailability(classify(page.page, now), own),
        page.page.truncated,
        poshmarkOwnReading(own) !== undefined,
      );
    }
    const shop = await withShopify(url, classify(page.page, now), page.page.html, fetcher, signal);
    // A page cut before the listing's own availability field is can't tell.
    return guardTruncatedVerdict(
      shop.verdict,
      page.page.truncated,
      shop.ownFieldFound || (page.page.truncated ? hasStructuredAvailability(page.page.html) : false),
    );
  }
  const firstApi = await atsLookup;
  const resolved = await resolveGuessedGreenhouseMiss(url, ats, firstApi, fetcher, {
    guessed: boardGuessed,
    html: page.ok ? page.page.html : undefined,
    signal,
  });
  ats = resolved.ref;
  const api = resolved.api;
  if (api.outcome === "listed") ageCtx.ats = api.age;
  if (page.ok) {
    // The board API answering for this posting is its own field; when it does
    // not (unavailable, or a Lever/Ashby feed miss the page decides), a cut
    // page is can't tell.
    const apiDecides = api.outcome === "listed" || (api.outcome === "missing" && !feedMissIsNotClosed(ats.vendor));
    return guardTruncatedVerdict(
      combinePageAndAts(classify(page.page, now), api, ats.vendor),
      page.page.truncated,
      apiDecides || (page.page.truncated ? hasStructuredAvailability(page.page.html) : false),
    );
  }
  if (api.outcome === "unavailable") throw page.error;
  return verdictFromAtsWithoutPage(url, api, now, ats.vendor);
}
