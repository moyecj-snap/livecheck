import { ATS_FETCH_TIMEOUT_MS, MAX_BODY_BYTES, PRICE_USD, USER_AGENT } from "./config.js";
import { DeadlineError, linkedAbort, resolveDeadlineMs } from "./deadline.js";
import type { VerifyVerdict } from "./types.js";

/**
 * Public job-board lookups for POST /v1/verify and POST /v1/verify/job.
 *
 * Build order follows unknowns cleared on the Oct 1 plate:
 * 1. Ashby board API (JS shells)
 * 2. Workday CXS (JS shells; some tenants block this endpoint)
 * 3. Lever postings API
 * 4. Greenhouse Job Board API (posted date + higher confidence; HTML already worked)
 *
 * No API keys. These are the vendors' public board endpoints.
 * Network errors, timeouts, and HTTP 5xx are "unavailable", never "missing".
 * A bot-challenge page is not promoted to live. No Cloudflare or reCAPTCHA bypass.
 */

export const ATS_API_LISTED = "ats_api_listed";
export const ATS_API_MISSING = "ats_api_missing";
/** Equivalent to listed_in_ats_api: true. */
export const ATS_LISTED_CONFIDENCE = 0.96;
/** Greenhouse (and any board that returns a posted timestamp) when the API agrees the job is live. */
export const ATS_LISTED_WITH_POSTED_AT_CONFIDENCE = 0.97;
export const ATS_MISSING_CONFIDENCE = 0.95;
/** Page says closed and the API still lists the posting. */
export const ATS_DISAGREE_CONFIDENCE = 0.4;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCALE = /^[a-z]{2}-[a-z]{2}$/i;

export type AtsVendor = "ashby" | "workday" | "lever" | "greenhouse";

export type AtsJobRef = {
  vendor: AtsVendor;
  /** Public board request. GET, no credentials. */
  apiUrl: string;
  jobId: string;
  board: string;
};

export type AtsLookup =
  | {
      outcome: "listed";
      httpStatus: number;
      title?: string;
      canonicalUrl?: string;
      /** ISO-8601 from the board payload (Greenhouse first_published / updated_at, etc.). */
      postedAt?: string;
    }
  | { outcome: "missing"; httpStatus: number }
  | { outcome: "unavailable" };

type LookupOptions = {
  timeoutMs?: number;
  maxBytes?: number;
  /** Outer verify/check abort. A parent abort is a deadline, not "API unavailable". */
  signal?: AbortSignal;
};

function pathParts(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean);
}

function httpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return parsed.href;
  } catch {
    return undefined;
  }
}

function encodeSegments(segments: string[]): string {
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

export function parseAtsJobUrl(raw: string): AtsJobRef | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  return parseAshby(host, url) ?? parseWorkday(host, url) ?? parseLever(host, url) ?? parseGreenhouse(host, url);
}

function parseAshby(host: string, url: URL): AtsJobRef | null {
  if (host !== "jobs.ashbyhq.com") return null;
  const parts = pathParts(url);
  if (parts.length < 2 || parts.length > 3) return null;
  const [board, jobId, tail] = parts;
  if (!board || !jobId || !UUID.test(jobId)) return null;
  if (tail && tail.toLowerCase() !== "application") return null;
  return {
    vendor: "ashby",
    board,
    jobId,
    apiUrl: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`,
  };
}

function parseLever(host: string, url: URL): AtsJobRef | null {
  if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;
  const parts = pathParts(url);
  if (parts.length < 2 || parts.length > 3) return null;
  const [board, jobId, tail] = parts;
  if (!board || !jobId || !UUID.test(jobId)) return null;
  if (tail && tail.toLowerCase() !== "apply") return null;
  const origin = host === "jobs.eu.lever.co" ? "https://api.eu.lever.co" : "https://api.lever.co";
  return {
    vendor: "lever",
    board,
    jobId,
    apiUrl: `${origin}/v0/postings/${encodeURIComponent(board)}/${encodeURIComponent(jobId)}`,
  };
}

function parseGreenhouse(host: string, url: URL): AtsJobRef | null {
  if (!host.endsWith("greenhouse.io")) return null;
  const parts = pathParts(url);
  let board: string | undefined;
  let jobId: string | undefined;
  if (parts[0]?.toLowerCase() === "embed" && parts[1]?.toLowerCase() === "job_app") {
    board = url.searchParams.get("for")?.trim() || undefined;
    jobId = url.searchParams.get("token")?.trim() || undefined;
  } else if (parts.length >= 3 && parts[parts.length - 2]?.toLowerCase() === "jobs") {
    jobId = parts[parts.length - 1];
    board = parts[parts.length - 3];
  }
  if (!board || !jobId || !/^[A-Za-z0-9_-]+$/.test(board) || !/^\d+$/.test(jobId)) return null;
  if (board.toLowerCase() === "embed") return null;
  const origin = host.endsWith(".eu.greenhouse.io")
    ? "https://boards-api.eu.greenhouse.io"
    : "https://boards-api.greenhouse.io";
  return {
    vendor: "greenhouse",
    board,
    jobId,
    apiUrl: `${origin}/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`,
  };
}

function workdayJob(parts: string[]): { site: string; jobPath: string } | null {
  const jobAt = parts.findIndex((part) => part.toLowerCase() === "job");
  if (jobAt < 0) return null;
  const jobSegments = parts.slice(jobAt + 1);
  if (jobSegments.length === 0) return null;
  let siteSegments = parts.slice(0, jobAt);
  if (siteSegments[0] && LOCALE.test(siteSegments[0])) siteSegments = siteSegments.slice(1);
  if (siteSegments.length === 0) return null;
  return { site: siteSegments.join("/"), jobPath: jobSegments.join("/") };
}

function parseWorkday(host: string, url: URL): AtsJobRef | null {
  const parts = pathParts(url);
  const hosted = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (hosted) {
    const tenant = hosted[1];
    if (!tenant) return null;
    const job = workdayJob(parts);
    if (!job) return null;
    const apiUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeSegments(job.site.split("/"))}/job/${encodeSegments(job.jobPath.split("/"))}`;
    return { vendor: "workday", board: job.site, jobId: job.jobPath, apiUrl };
  }
  if (!/^wd\d+\.myworkdaysite\.com$/.test(host)) return null;
  if (parts[0]?.toLowerCase() !== "recruiting" || !parts[1]) return null;
  const tenant = parts[1];
  const job = workdayJob(parts.slice(2));
  if (!job) return null;
  const apiUrl = `https://${host}/wday/cxs/${encodeURIComponent(tenant)}/${encodeSegments(job.site.split("/"))}/job/${encodeSegments(job.jobPath.split("/"))}`;
  return { vendor: "workday", board: `${tenant}/${job.site}`, jobId: job.jobPath, apiUrl };
}

function normalizePostedAt(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 0 && value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    if (Number.isNaN(date.getTime())) return undefined;
    const year = date.getUTCFullYear();
    if (year < 1990 || year > 2100) return undefined;
    return date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return undefined;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function firstPostedAt(values: unknown[]): string | undefined {
  for (const value of values) {
    const iso = normalizePostedAt(value);
    if (iso) return iso;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function looksLikeBotChallenge(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.includes("just a moment")) return true;
  if (lower.includes("cf-challenge") || lower.includes("cf-browser-verification")) return true;
  if (lower.includes("verify you are human") || lower.includes("checking your browser")) return true;
  if (lower.includes("attention required") && lower.includes("cloudflare")) return true;
  return false;
}

function listed(input: {
  httpStatus: number;
  title?: string;
  canonicalUrl?: string;
  postedAt?: string;
}): AtsLookup {
  return {
    outcome: "listed",
    httpStatus: input.httpStatus,
    ...(input.title ? { title: input.title } : {}),
    ...(input.canonicalUrl ? { canonicalUrl: input.canonicalUrl } : {}),
    ...(input.postedAt ? { postedAt: input.postedAt } : {}),
  };
}

function interpretAshby(status: number, text: string, truncated: boolean, jobId: string): AtsLookup {
  if (status === 404 || status === 410) return { outcome: "missing", httpStatus: status };
  if (status < 200 || status >= 300) return { outcome: "unavailable" };
  if (looksLikeBotChallenge(text)) return { outcome: "unavailable" };
  const needle = jobId.toLowerCase();
  if (truncated && !text.toLowerCase().includes(needle)) return { outcome: "unavailable" };
  const payload = asRecord(parseJson(text));
  const jobs = payload?.jobs;
  if (!Array.isArray(jobs)) {
    if (truncated && text.toLowerCase().includes(needle)) {
      return listed({ httpStatus: status });
    }
    return { outcome: "unavailable" };
  }
  for (const job of jobs) {
    const row = asRecord(job);
    if (!row) continue;
    const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
    const jobUrl = typeof row.jobUrl === "string" ? row.jobUrl : "";
    if (id !== needle && !jobUrl.toLowerCase().includes(`/${needle}`)) continue;
    // isListed false is still a published direct-link posting, not a removal.
    return listed({
      httpStatus: status,
      title: typeof row.title === "string" ? row.title : undefined,
      canonicalUrl: httpUrl(jobUrl),
      postedAt: firstPostedAt([row.publishedAt]),
    });
  }
  if (truncated) return { outcome: "unavailable" };
  return { outcome: "missing", httpStatus: status };
}

function interpretLever(status: number, text: string, jobId: string): AtsLookup {
  if (status === 404 || status === 410) return { outcome: "missing", httpStatus: status };
  if (status < 200 || status >= 300) return { outcome: "unavailable" };
  if (looksLikeBotChallenge(text)) return { outcome: "unavailable" };
  const row = asRecord(parseJson(text));
  if (!row) return { outcome: "unavailable" };
  if (typeof row.id === "string" && row.id.toLowerCase() !== jobId.toLowerCase()) {
    return { outcome: "unavailable" };
  }
  if (typeof row.id !== "string" && typeof row.text !== "string") return { outcome: "unavailable" };
  return listed({
    httpStatus: status,
    title: typeof row.text === "string" ? row.text : undefined,
    canonicalUrl: httpUrl(typeof row.hostedUrl === "string" ? row.hostedUrl : undefined),
    postedAt: firstPostedAt([row.createdAt]),
  });
}

function interpretGreenhouse(status: number, text: string, jobId: string): AtsLookup {
  if (status === 404 || status === 410) return { outcome: "missing", httpStatus: status };
  if (status < 200 || status >= 300) return { outcome: "unavailable" };
  if (looksLikeBotChallenge(text)) return { outcome: "unavailable" };
  const row = asRecord(parseJson(text));
  if (!row || row.id == null || String(row.id) !== jobId) return { outcome: "unavailable" };
  if (typeof row.title !== "string" && typeof row.absolute_url !== "string") return { outcome: "unavailable" };
  return listed({
    httpStatus: status,
    title: typeof row.title === "string" ? row.title : undefined,
    canonicalUrl: httpUrl(typeof row.absolute_url === "string" ? row.absolute_url : undefined),
    postedAt: firstPostedAt([row.first_published, row.published_at, row.updated_at]),
  });
}

function interpretWorkday(status: number, text: string): AtsLookup {
  if (looksLikeBotChallenge(text)) return { outcome: "unavailable" };
  if (status === 404 || status === 410) return { outcome: "missing", httpStatus: status };
  const row = asRecord(parseJson(text));
  // Undocumented CXS code for a requisition that is gone. Other 403s are blocks.
  if (status === 403 && row?.errorCode === "S22") return { outcome: "missing", httpStatus: status };
  if (status < 200 || status >= 300) return { outcome: "unavailable" };
  const info = asRecord(row?.jobPostingInfo);
  if (!info) return { outcome: "unavailable" };
  if (typeof info.title !== "string" && typeof info.id !== "string" && typeof info.jobReqId !== "string") {
    return { outcome: "unavailable" };
  }
  return listed({
    httpStatus: status,
    title: typeof info.title === "string" ? info.title : undefined,
    canonicalUrl: httpUrl(typeof info.externalUrl === "string" ? info.externalUrl : undefined),
    postedAt: firstPostedAt([info.postedOn, info.postedDate]),
  });
}

/** Pure response interpreter. 5xx / challenge HTML / bad JSON → unavailable, not missing. */
export function interpretAtsResponse(ref: AtsJobRef, status: number, text: string, truncated = false): AtsLookup {
  if (looksLikeBotChallenge(text)) return { outcome: "unavailable" };
  if (status >= 500 || status === 408 || status === 429) return { outcome: "unavailable" };
  switch (ref.vendor) {
    case "ashby":
      return interpretAshby(status, text, truncated, ref.jobId);
    case "workday":
      return interpretWorkday(status, text);
    case "lever":
      return interpretLever(status, text, ref.jobId);
    case "greenhouse":
      return interpretGreenhouse(status, text, ref.jobId);
    default:
      return { outcome: "unavailable" };
  }
}

async function readCappedText(response: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength <= maxBytes) return { text, truncated: false };
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(encoded.subarray(0, maxBytes)), truncated: true };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      const room = maxBytes - received;
      if (value.byteLength > room) {
        chunks.push(value.subarray(0, room));
        received += room;
        truncated = true;
        break;
      }
      chunks.push(value);
      received += value.byteLength;
    }
    if (!truncated && received >= maxBytes) {
      const extra = await reader.read();
      if (!extra.done && extra.value && extra.value.byteLength > 0) truncated = true;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const merged = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(merged), truncated };
}

export async function lookupAtsJob(
  ref: AtsJobRef,
  fetcher: typeof fetch = fetch,
  options: LookupOptions = {},
): Promise<AtsLookup> {
  const timeoutMs = options.timeoutMs ?? ATS_FETCH_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_BODY_BYTES;
  const linked = linkedAbort(timeoutMs, options.signal);
  try {
    const response = await fetcher(ref.apiUrl, {
      method: "GET",
      redirect: "follow",
      signal: linked.signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
      },
    });
    const { text, truncated } = await readCappedText(response, maxBytes);
    return interpretAtsResponse(ref, response.status, text, truncated);
  } catch (error) {
    if (error instanceof DeadlineError || options.signal?.aborted) {
      throw error instanceof DeadlineError ? error : new DeadlineError(resolveDeadlineMs());
    }
    return { outcome: "unavailable" };
  } finally {
    linked.cancel();
  }
}

function dedupe(signals: string[]): string[] {
  const out: string[] = [];
  for (const signal of signals) {
    if (!out.includes(signal)) out.push(signal);
  }
  return out;
}

function checkedAtIso(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function postedSignal(iso: string | undefined): string[] {
  return iso ? [`ats_posted_at:${iso}`] : [];
}

/**
 * Page × public API.
 * - live + listed → live, high confidence
 * - unknown without challenge_page (JS shell / blank) + listed → live + ats_api_listed
 * - any non-challenge page + missing → closed + ats_api_missing
 * - closed + listed → unknown, page closed signals and ats_api_listed
 * - challenge_page (status not already closed) stays unknown, listed or missing
 * - unavailable leaves the HTML verdict untouched
 */
export function combinePageAndAts(page: VerifyVerdict, api: AtsLookup): VerifyVerdict {
  if (api.outcome === "unavailable") return page;

  const challengeBlocked = page.status !== "closed" && page.signals.includes("challenge_page");
  if (challengeBlocked) return page;

  if (api.outcome === "missing") {
    return {
      ...page,
      status: "closed",
      confidence: ATS_MISSING_CONFIDENCE,
      signals: dedupe([ATS_API_MISSING, ...page.signals]),
    };
  }

  const posted = postedSignal(api.postedAt);
  if (page.status === "closed") {
    return {
      ...page,
      status: "unknown",
      confidence: ATS_DISAGREE_CONFIDENCE,
      signals: dedupe([ATS_API_LISTED, ...page.signals, ...posted]),
    };
  }

  return {
    ...page,
    status: "live",
    confidence: api.postedAt ? ATS_LISTED_WITH_POSTED_AT_CONFIDENCE : ATS_LISTED_CONFIDENCE,
    signals: dedupe([ATS_API_LISTED, ...posted, ...page.signals]),
    ...(api.title ? { title: api.title } : {}),
  };
}

/** No HTML body (fetch failed) and the board API still answered. Not a challenge page. */
export function verdictFromAtsWithoutPage(url: string, api: Exclude<AtsLookup, { outcome: "unavailable" }>, now: Date): VerifyVerdict {
  const posted = api.outcome === "listed" ? postedSignal(api.postedAt) : [];
  const title = api.outcome === "listed" ? api.title : undefined;
  return {
    url,
    canonical_url: (api.outcome === "listed" ? httpUrl(api.canonicalUrl) : undefined) ?? url,
    status: api.outcome === "listed" ? "live" : "closed",
    http_status: api.httpStatus,
    checked_at: checkedAtIso(now),
    ...(title ? { title } : {}),
    signals: api.outcome === "listed" ? dedupe([ATS_API_LISTED, ...posted]) : [ATS_API_MISSING],
    confidence:
      api.outcome === "missing"
        ? ATS_MISSING_CONFIDENCE
        : api.postedAt
          ? ATS_LISTED_WITH_POSTED_AT_CONFIDENCE
          : ATS_LISTED_CONFIDENCE,
    price_usd: PRICE_USD,
  };
}
