import { USER_AGENT } from "./config.js";

/**
 * robots.txt for the page URLs Livecheck fetches (posting and listing HTML).
 *
 * Public ATS JSON that vendors document for public use is not checked here.
 * Those calls go through the ATS client, not fetchPage: api.ashbyhq.com,
 * api.lever.co, api.eu.lever.co, boards-api.greenhouse.io,
 * boards-api.eu.greenhouse.io, and Workday `/wday/cxs/`.
 *
 * Cache: one parsed file per origin, kept for one hour. The cache is shared
 * by both modes. A failure is never stored, so a strict miss is not remembered
 * as an allow and the next check tries again.
 *
 * Lenient is the public API. The lookup waits at most 500ms, inside the
 * caller's page timeout and the whole-check deadline. Strict is for audits
 * and pilots that promised robots.txt compliance. It waits at most 5s, still
 * inside those same budgets.
 *
 * RFC 9309 §2.3.1.3: an HTTP 4xx other than 429 means robots.txt is
 * unavailable, in both modes, so the URL is allowed and that allow is cached
 * for an hour. This includes 401, 403, 404, and 410.
 *
 * RFC 9309 §2.3.1.2: follow at least five redirects, even across hosts.
 * More than five is §2.3.1.3 unavailable (allowed, cached), not a fetch of
 * the next hop. The rules of a file reached within five redirects apply to
 * the original host. Every hop is a separate fetch so the caller's SSRF
 * guard runs before connect. The whole chain stays inside the 500ms lenient
 * budget or the 5s strict budget.
 *
 * RFC 9309 §2.3.1.4: 5xx, 429, a timeout, or a network error (including DNS)
 * means robots.txt is unreachable. A crawler must assume complete disallow,
 * and Google keeps that disallow for up to about 30 days. See the comment
 * on the unreachable branch. Lenient mode fails open on purpose. Strict mode
 * skips the page and the ATS lookup and returns unknown with signal
 * robots_unavailable.
 *
 * HTTP 200 is parsed and the matching rule is followed. A Disallow still
 * skips the page.
 */

export type RobotsMode = "strict" | "lenient";

/** RFC 9309 §2.3.1.2: follow at least five consecutive redirects. */
export const ROBOTS_MAX_REDIRECTS = 5;

export const ROBOTS_CACHE_TTL_MS = 60 * 60 * 1000;
/** Lenient upper bound. The page timeout and check deadline can cut it shorter. */
export const ROBOTS_FETCH_TIMEOUT_MS = 500;
/** Strict upper bound. The page timeout and check deadline can cut it shorter. */
export const ROBOTS_STRICT_FETCH_TIMEOUT_MS = 5_000;
export const ROBOTS_DISALLOWED_SIGNAL = "robots_disallowed";
export const ROBOTS_DISALLOWED_MESSAGE =
  "This site's robots.txt disallows Livecheck from fetching this URL, so we can't tell if it's live.";
export const ROBOTS_UNAVAILABLE_SIGNAL = "robots_unavailable";
export const ROBOTS_UNAVAILABLE_MESSAGE = "robots.txt unavailable";

const PRODUCT_TOKEN = "livecheck";

type Rule = { allow: boolean; path: string };
type Group = { agents: string[]; rules: Rule[] };

type CacheEntry = {
  expiresAt: number;
  decision: "allow" | "disallow" | Group[];
};

let clock: () => number = () => Date.now();
let strictTimeoutOverride: number | null = null;
const cache = new Map<string, CacheEntry>();

export function setRobotsClockForTests(fn: (() => number) | null): void {
  clock = fn ?? (() => Date.now());
}

/** Shorten the strict robots.txt wait in tests. Production stays at 5s. */
export function setRobotsStrictTimeoutForTests(ms: number | null): void {
  strictTimeoutOverride = ms;
}

export function robotsStrictTimeoutMs(): number {
  return strictTimeoutOverride ?? ROBOTS_STRICT_FETCH_TIMEOUT_MS;
}

export function clearRobotsCacheForTests(): void {
  cache.clear();
}

export function robotsCacheSizeForTests(): number {
  return cache.size;
}

/** Product token of the Livecheck user agent, lowercased, without the version. */
export function robotsProductToken(userAgent = USER_AGENT): string {
  const token = userAgent.trim().split(/[\s/]/)[0] ?? "";
  return token.toLowerCase();
}

function originKey(url: URL): string {
  return url.origin;
}

/**
 * Documented public ATS JSON. Page fetches never use these URLs; the helper
 * is here so a later caller can skip them without re-listing the hosts.
 */
export function isPublicAtsApiUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "api.ashbyhq.com" ||
    host === "api.lever.co" ||
    host === "api.eu.lever.co" ||
    host === "boards-api.greenhouse.io" ||
    host === "boards-api.eu.greenhouse.io"
  ) {
    return true;
  }
  if (
    (host.endsWith(".myworkdayjobs.com") || host.endsWith(".myworkdaysite.com")) &&
    url.pathname.includes("/wday/cxs/")
  ) {
    return true;
  }
  return false;
}

export function parseRobots(text: string): Group[] {
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const split = line.indexOf(":");
    if (split < 0) continue;
    const field = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      continue;
    }
    if (field !== "allow" && field !== "disallow") continue;
    if (!current) {
      current = { agents: ["*"], rules: [] };
      groups.push(current);
    }
    current.rules.push({ allow: field === "allow", path: value });
  }
  return groups;
}

function specificity(group: Group, token: string): number {
  let best = -1;
  for (const agent of group.agents) {
    if (agent === "*") best = Math.max(best, 0);
    else if (agent.length > 0 && token.startsWith(agent)) best = Math.max(best, agent.length);
  }
  return best;
}

/** Longest matching rule. An empty Disallow matches nothing. `$` anchors the end. `*` is a wildcard. */
export function ruleMatches(pattern: string, pathAndMaybeQuery: string): boolean {
  if (pattern === "") return false;
  const end = pattern.endsWith("$");
  const body = end ? pattern.slice(0, -1) : pattern;
  const parts = body.split("*");
  let index = 0;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i] ?? "";
    if (part.length === 0) continue;
    const found = pathAndMaybeQuery.indexOf(part, index);
    if (found < 0) return false;
    if (i === 0 && !body.startsWith("*") && found !== 0) return false;
    index = found + part.length;
  }
  if (end && index !== pathAndMaybeQuery.length) return false;
  return true;
}

export function robotsAllowsGroups(groups: Group[], url: URL, userAgent = USER_AGENT): boolean {
  const token = robotsProductToken(userAgent);
  let best = -1;
  let chosen: Group | null = null;
  for (const group of groups) {
    const score = specificity(group, token);
    if (score > best) {
      best = score;
      chosen = group;
    }
  }
  if (!chosen || best < 0) return true;
  const path = url.pathname || "/";
  const withQuery = `${path}${url.search}`;
  let winner: { allow: boolean; length: number } | null = null;
  for (const rule of chosen.rules) {
    const target = rule.path.includes("?") ? withQuery : path;
    if (!ruleMatches(rule.path, target)) continue;
    const length = rule.path.length;
    if (!winner || length > winner.length || (length === winner.length && rule.allow && !winner.allow)) {
      winner = { allow: rule.allow, length };
    }
  }
  return winner ? winner.allow : true;
}

export type RobotsVerdict =
  | { allowed: true }
  | { allowed: false; reason: "disallowed"; message: string; signal: typeof ROBOTS_DISALLOWED_SIGNAL }
  | { allowed: false; reason: "unavailable"; message: string; signal: typeof ROBOTS_UNAVAILABLE_SIGNAL };

function disallowedVerdict(): RobotsVerdict {
  return { allowed: false, reason: "disallowed", message: ROBOTS_DISALLOWED_MESSAGE, signal: ROBOTS_DISALLOWED_SIGNAL };
}

function unavailableVerdict(): RobotsVerdict {
  return { allowed: false, reason: "unavailable", message: ROBOTS_UNAVAILABLE_MESSAGE, signal: ROBOTS_UNAVAILABLE_SIGNAL };
}

function cacheGet(key: string): CacheEntry | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (clock() >= hit.expiresAt) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key: string, decision: CacheEntry["decision"]): void {
  cache.set(key, { decision, expiresAt: clock() + ROBOTS_CACHE_TTL_MS });
}

function fromDecision(decision: CacheEntry["decision"], url: URL): RobotsVerdict {
  if (decision === "allow") return { allowed: true };
  if (decision === "disallow") return disallowedVerdict();
  if (robotsAllowsGroups(decision, url)) return { allowed: true };
  return disallowedVerdict();
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

/**
 * RFC 9309 §2.3.1.4 says that when robots.txt is unreachable (5xx, 429,
 * timeout, or a network error such as DNS), a crawler MUST assume complete
 * disallow. The same section's example is to keep that answer for a
 * reasonably long period (for example, 30 days). Google does that, for up
 * to about 30 days.
 *
 * The live API is not a crawler. It makes one on-demand fetch of the single
 * URL an agent asked about. Treating an unreachable robots.txt as disallow
 * would turn a blip into "can't tell" for that check. Lenient mode therefore
 * fails open on purpose: the page is fetched, and this miss is not cached.
 * Do not "fix" the live API to assume disallow.
 *
 * Audits and pilots are batch fetches. They use strict mode, which follows
 * §2.3.1.4 and skips the page (unknown, signal robots_unavailable).
 */
function unreachableRobots(mode: RobotsMode): RobotsVerdict {
  if (mode === "strict") return unavailableVerdict();
  return { allowed: true };
}

/**
 * Whether Livecheck may fetch this page URL.
 * Lenient: unreachable robots.txt fails open.
 * Strict: unreachable robots.txt is unavailable and is not cached.
 * A parent abort (page timeout or check deadline) is rethrown so that budget
 * is not turned into an allow or an unavailable verdict, and is not followed
 * by another full wait.
 * The fetcher is raced against the timeout so a caller that ignores the
 * abort signal still cannot hold the check longer than timeoutMs.
 */
export async function robotsAllows(
  rawUrl: string,
  fetcher: typeof fetch = fetch,
  options: { signal?: AbortSignal; timeoutMs?: number; mode?: RobotsMode } = {},
): Promise<RobotsVerdict> {
  if (isPublicAtsApiUrl(rawUrl)) return { allowed: true };
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: true };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { allowed: true };
  const key = originKey(url);
  const cached = cacheGet(key);
  if (cached) return fromDecision(cached.decision, url);
  if (options.signal?.aborted) throw abortError();

  const robotsUrl = `${url.origin}/robots.txt`;
  const mode = options.mode ?? "lenient";
  const timeoutMs = options.timeoutMs ?? (mode === "strict" ? robotsStrictTimeoutMs() : ROBOTS_FETCH_TIMEOUT_MS);
  const controller = new AbortController();
  const onParent = () => controller.abort();
  options.signal?.addEventListener("abort", onParent, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timed = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(abortError());
    }, timeoutMs);
  });
  timed.catch(() => undefined);
  try {
    let currentUrl = robotsUrl;
    let redirectsFollowed = 0;
    let response: Response;
    for (;;) {
      const pending = fetcher(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: "text/plain,*/*;q=0.8", "user-agent": USER_AGENT },
      });
      // The race may settle on the timer first. A later abort rejection must not
      // surface as an unhandled rejection.
      pending.catch(() => undefined);
      response = await Promise.race([pending, timed]);
      if (response.status < 300 || response.status >= 400) break;
      if (redirectsFollowed >= ROBOTS_MAX_REDIRECTS) {
        // RFC 9309 §2.3.1.2: more than five redirects. §2.3.1.3 unavailable:
        // allow, and cache that allow. Do not request another hop.
        try {
          await response.body?.cancel();
        } catch {
          // ignore
        }
        cacheSet(key, "allow");
        return { allowed: true };
      }
      const location = response.headers.get("location");
      try {
        await response.body?.cancel();
      } catch {
        // ignore
      }
      if (!location) return unreachableRobots(mode);
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        return unreachableRobots(mode);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") return unreachableRobots(mode);
      currentUrl = next.href;
      redirectsFollowed += 1;
    }
    if (response.status >= 400 && response.status <= 499 && response.status !== 429) {
      // RFC 9309 §2.3.1.3. 429 is unreachable, with the 5xx branch below.
      cacheSet(key, "allow");
      return { allowed: true };
    }
    if (response.status < 200 || response.status >= 300) {
      // 429 and 5xx. Same decision as a timeout or DNS failure, below.
      return unreachableRobots(mode);
    }
    const text = await response.text();
    const groups = parseRobots(text);
    cacheSet(key, groups);
    return fromDecision(groups, url);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    // Timeout (our timer) and network errors, including DNS, land here.
    return unreachableRobots(mode);
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onParent);
  }
}

function requireRobotsMode(value: string | undefined, label: string): RobotsMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "strict" || normalized === "lenient") return normalized;
  throw new Error(`${label} must be strict or lenient`);
}

/**
 * Audit and accuracy runner. CLI `--robots-mode` wins over
 * `LIVECHECK_ROBOTS_MODE`. Unset means strict. A blank env var means strict.
 * An unknown value throws so a typo cannot silently change the mode.
 */
export function parseAuditRunnerArgs(
  argv: readonly string[],
  envValue: string | undefined,
): { robotsMode: RobotsMode; platePath?: string } {
  let cliMode: RobotsMode | undefined;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--robots-mode") {
      cliMode = requireRobotsMode(argv[i + 1], "--robots-mode");
      i += 1;
    } else if (arg.startsWith("--robots-mode=")) {
      cliMode = requireRobotsMode(arg.slice("--robots-mode=".length), "--robots-mode");
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown argument ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 1) throw new Error("Pass at most one plate path.");
  const robotsMode = cliMode ?? (envValue === undefined || envValue.trim() === "" ? "strict" : requireRobotsMode(envValue, "LIVECHECK_ROBOTS_MODE"));
  return { robotsMode, platePath: positional[0] };
}
