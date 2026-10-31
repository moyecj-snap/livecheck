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
 * caller's page timeout and the whole-check deadline. If robots.txt cannot be
 * fetched (network error, that 500ms, HTTP 5xx, 429, or any other status that
 * is not handled below), the check proceeds. A down robots.txt must not turn
 * a real posting into "can't tell".
 *
 * Strict is for audits and pilots that promised robots.txt compliance. The
 * lookup waits at most 5s, still inside those same budgets. Timeout, network
 * error, HTTP 5xx, 429, and any other status that is not a robots file skip
 * the page and the ATS lookup. The verdict is unknown, signal
 * robots_unavailable, message "robots.txt unavailable".
 *
 * Both modes: HTTP 404 means there is no file, so the URL is allowed and that
 * is cached. Strict mode treats HTTP 410 the same way (gone, no rules) and
 * caches the allow. Lenient mode leaves 410 on the fail-open path, uncached.
 * HTTP 401 and 403 are disallow-all for that origin, matching RFC 9309: a
 * forbidden robots.txt means do not fetch the site. That decision is cached
 * for the same hour in both modes.
 */

export type RobotsMode = "strict" | "lenient";

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
  const pending = fetcher(robotsUrl, {
    method: "GET",
    redirect: "follow",
    signal: controller.signal,
    headers: { accept: "text/plain,*/*;q=0.8", "user-agent": USER_AGENT },
  });
  // The race may settle on the timer first. A later abort rejection must not
  // surface as an unhandled rejection.
  pending.catch(() => undefined);
  try {
    const response = await Promise.race([pending, timed]);
    if (response.status === 404 || (mode === "strict" && response.status === 410)) {
      cacheSet(key, "allow");
      return { allowed: true };
    }
    if (response.status === 401 || response.status === 403) {
      cacheSet(key, "disallow");
      return disallowedVerdict();
    }
    if (response.status < 200 || response.status >= 300) {
      // Lenient: 5xx, 429, 410, and anything else unexpected fail open, uncached.
      // Strict: no rules file, so skip. Do not cache that as an allow.
      if (mode === "strict") return unavailableVerdict();
      return { allowed: true };
    }
    const text = await response.text();
    const groups = parseRobots(text);
    cacheSet(key, groups);
    return fromDecision(groups, url);
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (mode === "strict") return unavailableVerdict();
    return { allowed: true };
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
