import { lookupAtsJob, type AtsJobRef, type AtsLookup } from "./ats-api.js";
import { ATS_FETCH_TIMEOUT_MS, USER_AGENT } from "./config.js";
import { DeadlineError, resolveDeadlineMs } from "./deadline.js";
import { boardTokenFromHost } from "./free-job-role.js";

/**
 * Greenhouse board resolution for `?gh_jid=` links on a company's own domain.
 *
 * roleRefFor guesses the board token from the host (careers.stripe.com →
 * "stripe"). That guess is wrong for some companies: Datadog's careers site is
 * careers.datadoghq.com but its Greenhouse board is "datadog". With a wrong
 * guess the posting API answers 404 "Job not found" for every job, and that
 * 404 used to be read as "Greenhouse no longer lists it" → closed (Nov 4,
 * 2026 Dreamwork audit, gh_jid=8210323). The #65 rule (company page 404 +
 * Greenhouse lists the id → live) never ran.
 *
 * When the guessed board misses, this resolves the real board from, in order:
 *   1. a Greenhouse board token embedded in the page HTML,
 *   2. a small known host → board mapping,
 *   3. host-label variants (datadoghq → datadog), only when Greenhouse says
 *      that board exists.
 * If the guessed board itself does not exist on Greenhouse and nothing else
 * resolves, the miss says nothing about the job: return "unavailable" so the
 * page decides alone. If the guessed board exists (or its existence can't be
 * read), the miss stands, as before.
 *
 * Greenhouse's own posting pages (boards.greenhouse.io, job-boards.greenhouse.io)
 * never come through here: parseAtsJobUrl handles them and their 404 stays
 * closed (#58).
 */

/** Registrable domain (or full host) → Greenhouse board token, where the host guess is wrong. */
export const KNOWN_GREENHOUSE_BOARDS: Readonly<Record<string, string>> = {
  "datadoghq.com": "datadog",
};

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST_LABEL_SUFFIXES = ["hq", "inc", "careers", "jobs", "app", "corp", "labs", "co"];
const MAX_CANDIDATES = 4;

/** Board tokens named by Greenhouse embed scripts and links in a page. */
export function greenhouseBoardTokensFromHtml(html: string | undefined): string[] {
  if (!html) return [];
  const out: string[] = [];
  const add = (token: string | undefined) => {
    const t = token?.trim();
    if (t && TOKEN.test(t) && t.toLowerCase() !== "embed" && !out.includes(t)) out.push(t);
  };
  const patterns = [
    /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_(?:board|app)(?:\/js)?\?(?:[^"'\s<>]*?&(?:amp;)?)?for=([A-Za-z0-9_-]+)/gi,
    /boards-api(?:\.eu)?\.greenhouse\.io\/v1\/boards\/([A-Za-z0-9_-]+)/gi,
    /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?!embed\b)([A-Za-z0-9_-]+)(?:\/jobs\b|["'?\s])/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) add(match[1]);
  }
  return out;
}

function knownBoardFor(host: string): string | undefined {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const [domain, board] of Object.entries(KNOWN_GREENHOUSE_BOARDS)) {
    if (h === domain || h.endsWith(`.${domain}`)) return board;
  }
  return undefined;
}

function hostVariants(guess: string): string[] {
  const out: string[] = [];
  const add = (t: string) => {
    if (t.length >= 2 && TOKEN.test(t) && t !== guess && !out.includes(t)) out.push(t);
  };
  for (const suffix of HOST_LABEL_SUFFIXES) {
    if (guess.endsWith(suffix)) add(guess.slice(0, -suffix.length).replace(/-$/, ""));
  }
  if (guess.includes("-")) add(guess.replace(/-/g, ""));
  return out;
}

function greenhouseRef(board: string, jobId: string, eu: boolean): AtsJobRef {
  const origin = eu ? "https://boards-api.eu.greenhouse.io" : "https://boards-api.greenhouse.io";
  return {
    vendor: "greenhouse",
    board,
    jobId,
    apiUrl: `${origin}/v1/boards/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}`,
  };
}

type BoardStatus = "found" | "not_found" | "unknown";

/** GET /v1/boards/<token>: 200 → found, 404 → not_found, anything else → unknown. */
export async function greenhouseBoardStatus(
  board: string,
  fetcher: typeof fetch,
  options: { signal?: AbortSignal; timeoutMs?: number; eu?: boolean } = {},
): Promise<BoardStatus> {
  const origin = options.eu ? "https://boards-api.eu.greenhouse.io" : "https://boards-api.greenhouse.io";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? ATS_FETCH_TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  try {
    const response = await fetcher(`${origin}/v1/boards/${encodeURIComponent(board)}`, {
      method: "GET",
      redirect: "follow",
      signal,
      headers: { accept: "application/json", "user-agent": USER_AGENT },
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 200) return "found";
    if (response.status === 404) return "not_found";
    return "unknown";
  } catch {
    if (options.signal?.aborted) throw new DeadlineError(resolveDeadlineMs());
    return "unknown";
  }
}

export type ResolvedGreenhouse = { ref: AtsJobRef; api: AtsLookup; resolvedFrom?: "page" | "mapping" | "host_variant" };

/**
 * Re-check a guessed gh_jid board after a miss. `guessed` is true only for
 * refs built by roleRefFor from a company host (never a greenhouse.io URL).
 */
export async function resolveGuessedGreenhouseMiss(
  url: string,
  ref: AtsJobRef,
  api: AtsLookup,
  fetcher: typeof fetch,
  options: { guessed: boolean; html?: string; signal?: AbortSignal },
): Promise<ResolvedGreenhouse> {
  if (!options.guessed || ref.vendor !== "greenhouse" || api.outcome !== "missing") return { ref, api };
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ref, api };
  }
  if (host.toLowerCase().endsWith("greenhouse.io")) return { ref, api };
  const eu = ref.apiUrl.includes("boards-api.eu.greenhouse.io");
  const guessStatus = await greenhouseBoardStatus(ref.board, fetcher, { signal: options.signal, eu });
  if (guessStatus === "found") return { ref, api };

  const guess = ref.board.toLowerCase();
  const trusted: Array<{ board: string; from: "page" | "mapping" }> = [];
  for (const board of greenhouseBoardTokensFromHtml(options.html)) trusted.push({ board, from: "page" });
  const mapped = knownBoardFor(host);
  if (mapped) trusted.push({ board: mapped, from: "mapping" });
  const seen = new Set<string>([guess]);
  const candidates: Array<{ board: string; from: "page" | "mapping" | "host_variant" }> = [];
  for (const c of trusted) {
    if (!seen.has(c.board.toLowerCase())) {
      seen.add(c.board.toLowerCase());
      candidates.push(c);
    }
  }
  const hostGuess = boardTokenFromHost(host) ?? guess;
  for (const board of hostVariants(hostGuess)) {
    if (!seen.has(board)) {
      seen.add(board);
      candidates.push({ board, from: "host_variant" });
    }
  }

  for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
    if (candidate.from === "host_variant") {
      const status = await greenhouseBoardStatus(candidate.board, fetcher, { signal: options.signal, eu });
      if (status !== "found") continue;
    }
    const candidateRef = greenhouseRef(candidate.board, ref.jobId, eu);
    const found = await lookupAtsJob(candidateRef, fetcher, { signal: options.signal });
    if (found.outcome === "unavailable") continue;
    // A real board answered for this exact job id: listed → live path,
    // missing → Greenhouse no longer lists it.
    return { ref: candidateRef, api: found, resolvedFrom: candidate.from };
  }
  // The guessed board doesn't exist on Greenhouse: its 404 is not about the job.
  if (guessStatus === "not_found") return { ref, api: { outcome: "unavailable" } };
  return { ref, api };
}
