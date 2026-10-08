import { lookupAtsJob, parseAtsJobUrl, type AtsJobRef } from "./ats-api.js";
import type { VerifyVerdict } from "./types.js";

/**
 * Which role a free check was about, for the result card.
 *
 * When a job link now redirects to a job board, search page, or careers home,
 * the page we land on has the board's title ("Stripe Careers | Open Roles"),
 * not the job's. That title must never be shown as the role. Instead:
 *   1. the hiring platform's own API, if it still knows the job (direct
 *      Greenhouse / Lever / Ashby / Workday links, and `?gh_jid=` links on a
 *      company's own careers site, which are Greenhouse jobs), or
 *   2. "Original posting no longer available" on a Closed card.
 *
 * About "the page before the redirect": a dead link's earlier hops are bare
 * 30x responses with no body (Stripe: 307 → 307 → board), so there's no title
 * to read there. Only the final page and the API carry one.
 */

export const NO_LONGER_AVAILABLE = "Original posting no longer available";

/** Signals meaning the final page is a board/search/careers page, not the posting. */
const LANDED_ON_BOARD = new Set([
  "redirected_to_board",
  "redirected_away_from_job",
  "careers_homepage",
  "collection_or_category",
  "not_a_specific_posting",
  "ats_empty_state",
]);

export type RoleInfo = { title: string; company?: string; platform?: string };

const TWO_PART_SUFFIX = new Set(["co", "com", "org", "net", "ac", "gov", "edu"]);

/** Guess the Greenhouse board token from a company domain: careers.stripe.com → "stripe". */
export function boardTokenFromHost(host: string): string | undefined {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length < 2) return undefined;
  let index = labels.length - 2;
  if (labels.length >= 3 && TWO_PART_SUFFIX.has(labels[index]!) && labels[labels.length - 1]!.length === 2) index -= 1;
  const token = labels[index];
  return token && /^[a-z0-9][a-z0-9-]{0,63}$/.test(token) ? token : undefined;
}

/**
 * ATS reference for a job link: a direct ATS URL, or `gh_jid=<digits>` on a
 * company's own site (Greenhouse embeds use that parameter).
 */
export function roleRefFor(url: string): AtsJobRef | null {
  const direct = parseAtsJobUrl(url);
  if (direct) return direct;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const jobId = parsed.searchParams.get("gh_jid")?.trim();
  if (!jobId || !/^\d{1,20}$/.test(jobId)) return null;
  const board = boardTokenFromHost(parsed.hostname);
  if (!board) return null;
  return {
    vendor: "greenhouse",
    board,
    jobId,
    apiUrl: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`,
  };
}

const VENDOR_NAME = { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday" } as const;

/**
 * Role from the platform API, or undefined. Uses the shared ATS response
 * cache (a direct ATS link was already fetched by verifyUrl, so this is
 * usually a cache hit). Only a positive "listed" answer is used: a 404 for a
 * guessed board token says nothing.
 */
export async function lookupRole(
  url: string,
  fetcher: typeof fetch,
  options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<RoleInfo | undefined> {
  const ref = roleRefFor(url);
  if (!ref) return undefined;
  try {
    const found = await lookupAtsJob(ref, fetcher, { timeoutMs: options.timeoutMs ?? 5_000, maxBytes: 2_000_000, signal: options.signal });
    if (found.outcome !== "listed" || !found.title?.trim()) return undefined;
    return {
      title: found.title.trim(),
      ...(found.company?.trim() ? { company: found.company.trim() } : {}),
      platform: VENDOR_NAME[ref.vendor],
    };
  } catch {
    return undefined;
  }
}

export function landedOnBoard(verdict: Pick<VerifyVerdict, "signals">): boolean {
  return verdict.signals.some((signal) => LANDED_ON_BOARD.has(signal));
}

function samePosting(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.hostname.replace(/^www\./, "") === y.hostname.replace(/^www\./, "") && x.pathname.replace(/\/+$/, "") === y.pathname.replace(/\/+$/, "");
  } catch {
    return a === b;
  }
}

/**
 * The title line for the card.
 * - Role from the API wins ("Program Manager · Stripe").
 * - The page title is used only when it's the posting's own page: not a
 *   board/search/careers landing page, and on a Closed card only when the
 *   link wasn't redirected and answered 2xx (a page that itself says closed).
 * - Closed with nothing trustworthy → "Original posting no longer available".
 */
export function roleLine(
  target: string,
  verdict: Pick<VerifyVerdict, "status" | "title" | "signals" | "canonical_url" | "http_status">,
  role: RoleInfo | undefined,
): { text?: string; unavailable: boolean } {
  if (role) return { text: role.company ? `${role.title} · ${role.company}` : role.title, unavailable: false };
  const onBoard = landedOnBoard(verdict);
  if (verdict.status === "closed") {
    const ownPage =
      !onBoard &&
      samePosting(target, verdict.canonical_url || target) &&
      verdict.http_status >= 200 &&
      verdict.http_status < 300;
    if (ownPage && verdict.title?.trim()) return { text: verdict.title.trim(), unavailable: false };
    return { text: NO_LONGER_AVAILABLE, unavailable: true };
  }
  if (onBoard) return { unavailable: false };
  return verdict.title?.trim() ? { text: verdict.title.trim(), unavailable: false } : { unavailable: false };
}
