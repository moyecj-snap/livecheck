import { lookupAtsJob, combinePageAndAts, parseAtsJobUrl, verdictFromAtsWithoutPage } from "./ats-api.js";
import { roleRefFor } from "./free-job-role.js";
import { CHECK_TIMEOUT_SIGNAL, FETCH_TIMEOUT_MS, MAX_BODY_BYTES, PRICE_USD, USER_AGENT } from "./config.js";
import { classify } from "./classify.js";
import { ROBOTS_FETCH_TIMEOUT_MS, robotsAllows } from "./robots.js";
import { DeadlineError, isAbortLike, linkedAbort, resolveDeadlineMs, withDeadline } from "./deadline.js";
import { isEbayAdapterEnabled, logEbayAdapterDisabled, parseEbayItemUrl, verifyEbayItem } from "./ebay.js";
import { applyShopifyAvailability, lookupShopifyAvailable, shopifyProductJsUrl } from "./shopify.js";
import { stripTrackingParams } from "./tracking-params.js";
import type { FetchedPage, VerifyVerdict } from "./types.js";

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
};

export type FetchPageOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  /**
   * Posting and listing checks only. Confirm and other fetchPage callers
   * leave this off so they do not request robots.txt.
   */
  robots?: boolean;
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
  const redirectChain: string[] = [];
  try {
    if (options.robots) {
      const robotsTimeout = Math.min(ROBOTS_FETCH_TIMEOUT_MS, timeoutMs);
      let robots: Awaited<ReturnType<typeof robotsAllows>>;
      try {
        robots = await robotsAllows(url, fetcher, { signal: linked.signal, timeoutMs: robotsTimeout });
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
          robotsDisallowed: true,
        };
      }
    }
    options.afterRobots?.();

    const fetchInit = {
      method: "GET" as const,
      redirect: "follow" as const,
      signal: linked.signal,
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

    const buffer = await response.arrayBuffer();
    const bytes = buffer.byteLength > MAX_BODY_BYTES ? buffer.slice(0, MAX_BODY_BYTES) : buffer;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

    return {
      requestedUrl: url,
      canonicalUrl,
      httpStatus: response.status,
      title: extractTitle(html),
      html,
      text: stripTags(html),
      redirected: canonicalUrl.replace(/\/$/, "") !== url.replace(/\/$/, ""),
      redirectChain,
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
  fetcher: typeof fetch,
  signal: AbortSignal,
): Promise<VerifyVerdict> {
  const jsUrl = shopifyProductJsUrl(verdict.canonical_url) ?? shopifyProductJsUrl(requested);
  if (!jsUrl) return verdict;
  const found = await lookupShopifyAvailable(jsUrl, fetcher, signal);
  if (!found) return verdict;
  return applyShopifyAvailability(verdict, found);
}

export async function verifyUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  options: VerifyUrlOptions = {},
): Promise<VerifyVerdict> {
  const deadlineMs = resolveDeadlineMs(options.deadlineMs);
  const target = stripTrackingParams(url);
  try {
    return await withDeadline(deadlineMs, (deadlineSignal) => {
      const signal = options.signal ? AbortSignal.any([deadlineSignal, options.signal]) : deadlineSignal;
      return verifyUrlWithin(target, fetcher, now, options, signal);
    });
  } catch (error) {
    if (error instanceof DeadlineError) return timeoutUnknownVerdict(url, now);
    throw error;
  }
}

async function verifyUrlWithin(
  url: string,
  fetcher: typeof fetch,
  now: Date,
  options: VerifyUrlOptions,
  signal: AbortSignal,
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
  const ats = options.atsApi ? parseAtsJobUrl(url) ?? roleRefFor(url) : null;
  let atsLookup: Promise<Awaited<ReturnType<typeof lookupAtsJob>>> | undefined;
  const page = await fetchPage(url, fetcher, {
    signal,
    robots: true,
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
  if (page.ok && page.page.robotsDisallowed) return classify(page.page, now);
  if (!ats || !atsLookup) {
    if (!page.ok) throw page.error;
    return withShopify(url, classify(page.page, now), fetcher, signal);
  }
  const api = await atsLookup;
  if (page.ok) return combinePageAndAts(classify(page.page, now), api, ats.vendor);
  if (api.outcome === "unavailable") throw page.error;
  return verdictFromAtsWithoutPage(url, api, now, ats.vendor);
}
