import { lookupAtsJob, combinePageAndAts, parseAtsJobUrl, verdictFromAtsWithoutPage } from "./ats-api.js";
import { FETCH_TIMEOUT_MS, MAX_BODY_BYTES, USER_AGENT } from "./config.js";
import { classify } from "./classify.js";
import { isEbayAdapterEnabled, logEbayAdapterDisabled, parseEbayItemUrl, verifyEbayItem } from "./ebay.js";
import type { FetchedPage, VerifyVerdict } from "./types.js";

export type VerifyUrlOptions = {
  /**
   * Consult public Ashby, Workday, Lever, and Greenhouse board APIs.
   * POST /v1/verify and POST /v1/verify/job set this. Sentinel check and
   * watch-chain verify leave it off.
   */
  atsApi?: boolean;
};

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

export async function fetchPage(url: string, fetcher: typeof fetch = fetch): Promise<FetchedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const redirectChain: string[] = [];
  try {
    const response = await fetcher(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        "user-agent": USER_AGENT,
      },
    });

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
    if (error instanceof Error && error.name === "AbortError") {
      throw new VerifyError(`Timed out fetching ${url} after ${FETCH_TIMEOUT_MS}ms.`, 504);
    }
    const message = error instanceof Error ? error.message : "fetch failed";
    throw new VerifyError(`Could not fetch URL: ${message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

export async function verifyUrl(
  url: string,
  fetcher: typeof fetch = fetch,
  now = new Date(),
  options: VerifyUrlOptions = {},
): Promise<VerifyVerdict> {
  const ebay = parseEbayItemUrl(url);
  if (ebay) {
    if (isEbayAdapterEnabled()) {
      return verifyEbayItem(ebay, fetcher, now);
    }
    logEbayAdapterDisabled();
  }
  const ats = options.atsApi ? parseAtsJobUrl(url) : null;
  if (!ats) {
    const page = await fetchPage(url, fetcher);
    return classify(page, now);
  }

  const pagePromise = fetchPage(url, fetcher).then(
    (page) => ({ ok: true as const, page }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  const [pageResult, atsLookup] = await Promise.all([pagePromise, lookupAtsJob(ats, fetcher)]);
  if (pageResult.ok) return combinePageAndAts(classify(pageResult.page, now), atsLookup);
  if (atsLookup.outcome === "unavailable") throw pageResult.error;
  return verdictFromAtsWithoutPage(url, atsLookup, now);
}
