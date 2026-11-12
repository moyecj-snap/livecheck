import type { VerifyVerdict } from "./types.js";

/**
 * Pages larger than MAX_BODY_BYTES are cut at the limit (Nov 12, 2026:
 * Poshmark listing pages are ~1.7 MB and the 1.5 MB cut landed inside their
 * similar-items data). Two guards:
 *
 * 1. One structured stdout line per truncated page, with the store's hostname
 *    only (no path, query string, or caller data), searchable in Fly logs.
 * 2. When a page was cut and the listing's own availability field was not
 *    found in the part that was read, the check is can't tell, never live or
 *    closed.
 */
export const PAGE_TRUNCATED_EVENT = "livecheck.page_truncated" as const;
export const PAGE_TRUNCATED_SIGNAL = "page_truncated";

let defaultWriter: (line: string) => void = (line) => console.log(line);

/** Test seam: capture truncation log lines. */
export function setPageTruncationWriterForTests(writer: ((line: string) => void) | null): void {
  defaultWriter = writer ?? ((line) => console.log(line));
}

/** Hostname only. Never the path or query string. */
export function truncationDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return "invalid";
  }
}

export function logPageTruncated(
  entry: { url: string; bodyBytes: number; limitBytes: number; httpStatus: number },
  writer: (line: string) => void = defaultWriter,
): void {
  writer(
    JSON.stringify({
      event: PAGE_TRUNCATED_EVENT,
      domain: truncationDomain(entry.url),
      body_bytes: entry.bodyBytes,
      limit_bytes: entry.limitBytes,
      http_status: entry.httpStatus,
      ts: new Date().toISOString(),
    }),
  );
}

/**
 * schema.org availability for the item in JSON-LD / embedded JSON or
 * microdata (the same sources the HTML classifier reads).
 */
export function hasStructuredAvailability(html: string): boolean {
  return (
    /["']availability["']\s*:\s*["'](?:https?:\/\/schema\.org\/)?(?:InStock|OutOfStock|SoldOut|Discontinued|LimitedAvailability|PreOrder|BackOrder|OnlineOnly|InStoreOnly)["']/i.test(
      html,
    ) || /itemprop=["']availability["']/i.test(html)
  );
}

const READING_SIGNALS = new Set(["sold-out", "in-stock"]);

/**
 * Guard 2. `ownFieldFound`: the listing's own availability decided (Poshmark
 * inventory / JSON-LD for its id, eBay item offer, Shopify product.js or
 * per-variant schema offers, a board API answer, or structured availability in
 * the read portion). HTTP 404/410 and other non-2xx answers, robots blocks,
 * challenge pages, and login walls are not page-content readings and are kept.
 */
export function guardTruncatedVerdict(verdict: VerifyVerdict, truncated: boolean | undefined, ownFieldFound: boolean): VerifyVerdict {
  if (!truncated || ownFieldFound) return verdict;
  if (verdict.http_status < 200 || verdict.http_status >= 300) return verdict;
  const signals = verdict.signals;
  if (signals.some((s) => s === "challenge_page" || s === "loginwalled" || s.startsWith("robots_"))) return verdict;
  if (verdict.status === "unknown") {
    return signals.includes(PAGE_TRUNCATED_SIGNAL) ? verdict : { ...verdict, signals: [PAGE_TRUNCATED_SIGNAL, ...signals] };
  }
  return {
    ...verdict,
    status: "unknown",
    confidence: Math.min(verdict.confidence, 0.5),
    signals: [PAGE_TRUNCATED_SIGNAL, ...signals.filter((s) => !READING_SIGNALS.has(s) && s !== PAGE_TRUNCATED_SIGNAL)],
  };
}
