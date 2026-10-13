import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ATS_API_LISTED, ATS_API_MISSING, parseAtsJobUrl } from "./ats-api.js";
import { PRICE_USD } from "./config.js";
import { BlockedTargetError, DEFAULT_FETCH_POLICY, guardedFetch, vetTarget, type FetchPolicy } from "./free-job-guard.js";
import {
  bumpFreePageMetric,
  bumpFreePageSources,
  pacificDay,
  readFreePageSettings,
  readFreePageStats,
  type FreePageSettings,
} from "./free-job-store.js";
import { referrerSource, registrableDomain, uaClass, utmSource } from "./free-job-sources.js";
import { EXAMPLE_TTL_MS, ExampleCache, FREE_JOB_EXAMPLES, isExampleKey, type ExampleKey } from "./free-job-examples.js";
import { lookupRole, roleLine, type RoleInfo } from "./free-job-role.js";
import { queryRefundCandidateDailyFromStore } from "./paid-call-store.js";
import { publicOrigin } from "./public-url.js";
import type { VerifyVerdict } from "./types.js";
import { VerifyError, parseTargetUrl, verifyUrl } from "./verify.js";

/**
 * Free "Is this job still open?" page for the Product Hunt launch
 * (livecheck-gtm/product-hunt/LAUNCH-KIT-2026-10-27.md §1).
 *
 * - GET /job: one text box. POST /job: the same check as POST /v1/verify/job
 *   (`verifyUrl` with the ATS APIs on), no wallet, no signup.
 * - 5 free checks per visitor per Pacific day, counted by cookie AND by IP.
 *   A global hourly cap and a small concurrency pool of its own; when either
 *   is full the page says "Busy, try again in a few minutes". The paid API's
 *   verify slots are never used by the free page.
 * - Privacy: the link is held in memory for the length of the check only. It
 *   is not logged, not written to paid_calls, receipts, or any file. Visitor
 *   and IP limits are keyed by an HMAC under a random key that lives in
 *   memory and rotates every Pacific day, so raw IPs and cookies are never
 *   kept. Tracking is daily counts (`src/free-job-store.ts`).
 * - Not paid calls: nothing here calls recordSuccessfulPaidCheck, so /stats
 *   revenue buckets and reconciliation are untouched.
 * - HTML only (no JSON answer), so the free page is not a free API.
 */

export const FREE_JOB_PATH = "/job";
export const FREE_JOB_COOKIE = "lc_free";
export const DOCS_URL = "/llms.txt";
export const SKILL_URL = "https://github.com/moyecj-snap/livecheck-skills";
/** Same contact as the OpenAPI document (`info.contact.email` in src/discovery.ts). */
export const CONTACT_EMAIL = "moyecj@gmail.com";
export const OG_IMAGE_PATH = `${FREE_JOB_PATH}/og.png`;
export const OG_TITLE = "Is this job still open?";
/** Product Hunt description (LAUNCH-KIT-2026-10-27.md §2). */
export const OG_DESCRIPTION =
  "Paste a job link and Livecheck tells you if it's still open, closed, or can't tell, read from the posting and the hiring platform right now. Free for people. Building an AI agent? Same check by API for $0.01, no account or API key.";
export const HOW_IT_WORKS = "We read the posting and the hiring platform's own data at the moment you ask.";

/** 1200×630 share image (gallery image #1 from the launch kit). Read once at boot. */
export const OG_IMAGE_PNG: Buffer = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/og-job.png"));

export type FreeJobConfig = {
  perVisitorDaily: number;
  perIpDaily: number;
  hourlyCap: number;
  concurrency: number;
  enabled: boolean;
};

export const FREE_JOB_DEFAULTS: Omit<FreeJobConfig, "enabled"> = {
  perVisitorDaily: 5,
  perIpDaily: 15,
  hourlyCap: 300,
  concurrency: 2,
};

/** Whole-check budget for a free check (all hops, page + ATS API). */
export const FREE_JOB_TOTAL_TIMEOUT_MS = 15_000;
export const FREE_PAGE_STATS_TOKEN_ENV = "FREE_PAGE_STATS_TOKEN";

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Precedence: the `free_page_settings` table (live, `npm run free:set`, no
 * deploy or restart) > env var > default.
 * Env: LIVECHECK_FREE_PER_VISITOR_DAILY (5), LIVECHECK_FREE_PER_IP_DAILY (15),
 * LIVECHECK_FREE_HOURLY_CAP (300), LIVECHECK_FREE_CONCURRENCY (2),
 * LIVECHECK_FREE_PAGE=off hides the page.
 * Settings keys: per_visitor_daily, per_ip_daily, hourly_cap, concurrency, enabled.
 */
export function resolveFreeJobConfig(env: NodeJS.ProcessEnv = process.env, settings: FreePageSettings = {}): FreeJobConfig {
  const off = ["off", "0", "false", "none"].includes((env.LIVECHECK_FREE_PAGE ?? "").trim().toLowerCase());
  return {
    perVisitorDaily:
      settings.per_visitor_daily ??
      intEnv(env, "LIVECHECK_FREE_PER_VISITOR_DAILY", FREE_JOB_DEFAULTS.perVisitorDaily, 1, 1000),
    perIpDaily: settings.per_ip_daily ?? intEnv(env, "LIVECHECK_FREE_PER_IP_DAILY", FREE_JOB_DEFAULTS.perIpDaily, 1, 10_000),
    hourlyCap: settings.hourly_cap ?? intEnv(env, "LIVECHECK_FREE_HOURLY_CAP", FREE_JOB_DEFAULTS.hourlyCap, 0, 100_000),
    concurrency: settings.concurrency ?? intEnv(env, "LIVECHECK_FREE_CONCURRENCY", FREE_JOB_DEFAULTS.concurrency, 1, 16),
    enabled: settings.enabled !== undefined ? settings.enabled === 1 : !off,
  };
}

/** Config for this request: settings table read live, then env, then defaults. */
export function currentFreeJobConfig(): FreeJobConfig {
  return resolveFreeJobConfig(process.env, readFreePageSettings());
}

// ---------------------------------------------------------------------------
// Limiter (in memory, hashed keys, rotates every Pacific day)

type Admit =
  | { ok: true; release: () => void }
  | { ok: false; reason: "visitor_limit" | "hourly_cap" | "busy" };

const MAX_TRACKED_KEYS = 200_000;

class FreeJobLimiter {
  private day = "";
  private key: Buffer = randomBytes(32);
  private visitors = new Map<string, number>();
  private ips = new Map<string, number>();
  private hour = "";
  private hourCount = 0;
  private inFlight = 0;

  private rollover(now: Date): void {
    const day = pacificDay(now);
    if (day !== this.day) {
      this.day = day;
      this.key = randomBytes(32);
      this.visitors.clear();
      this.ips.clear();
    }
    const hour = now.toISOString().slice(0, 13);
    if (hour !== this.hour) {
      this.hour = hour;
      this.hourCount = 0;
    }
  }

  private hash(kind: string, value: string): string {
    return createHmac("sha256", this.key).update(`${kind}:${value}`).digest("base64url").slice(0, 22);
  }

  admit(ip: string, visitor: string | undefined, config: FreeJobConfig, now: Date): Admit {
    this.rollover(now);
    const ipKey = this.hash("ip", ip);
    const visitorKey = visitor ? this.hash("v", visitor) : undefined;
    const ipUsed = this.ips.get(ipKey) ?? 0;
    const visitorUsed = visitorKey ? (this.visitors.get(visitorKey) ?? 0) : 0;
    if (ipUsed >= config.perIpDaily || visitorUsed >= config.perVisitorDaily) {
      return { ok: false, reason: "visitor_limit" };
    }
    if (this.hourCount >= config.hourlyCap) return { ok: false, reason: "hourly_cap" };
    if (this.inFlight >= config.concurrency) return { ok: false, reason: "busy" };
    if (this.ips.size >= MAX_TRACKED_KEYS || this.visitors.size >= MAX_TRACKED_KEYS) {
      return { ok: false, reason: "hourly_cap" };
    }
    this.ips.set(ipKey, ipUsed + 1);
    if (visitorKey) this.visitors.set(visitorKey, visitorUsed + 1);
    this.hourCount += 1;
    this.inFlight += 1;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight = Math.max(0, this.inFlight - 1);
      },
    };
  }

  remaining(ip: string, visitor: string | undefined, config: FreeJobConfig, now: Date): number {
    this.rollover(now);
    const ipUsed = this.ips.get(this.hash("ip", ip)) ?? 0;
    const visitorUsed = visitor ? (this.visitors.get(this.hash("v", visitor)) ?? 0) : 0;
    return Math.max(0, Math.min(config.perIpDaily - ipUsed, config.perVisitorDaily - visitorUsed));
  }

  checksThisHour(now: Date): number {
    this.rollover(now);
    return this.hourCount;
  }

  inFlightNow(): number {
    return this.inFlight;
  }

  /** Audit seam: every key the limiter holds (hashes only). */
  snapshotKeys(): string[] {
    return [...this.ips.keys(), ...this.visitors.keys()];
  }
}

let limiter = new FreeJobLimiter();
let policy: FetchPolicy = DEFAULT_FETCH_POLICY;
let totalTimeoutMs = FREE_JOB_TOTAL_TIMEOUT_MS;
let clock: () => Date = () => new Date();
let exampleUrls: Record<ExampleKey, string> = { open: FREE_JOB_EXAMPLES.open.url, filled: FREE_JOB_EXAMPLES.filled.url };
let roleLookup: typeof lookupRole = lookupRole;
let examples = newExampleCache();

function newExampleCache(): ExampleCache<FreeJobView> {
  return new ExampleCache<FreeJobView>(
    async (key) => {
      const { view, ok } = await runCheck(exampleUrls[key], {});
      return { value: { ...view, example: key } as FreeJobView, ok };
    },
    () => clock().getTime(),
  );
}

export function resetFreeJobForTests(): void {
  limiter = new FreeJobLimiter();
  policy = DEFAULT_FETCH_POLICY;
  totalTimeoutMs = FREE_JOB_TOTAL_TIMEOUT_MS;
  clock = () => new Date();
  exampleUrls = { open: FREE_JOB_EXAMPLES.open.url, filled: FREE_JOB_EXAMPLES.filled.url };
  roleLookup = lookupRole;
  examples = newExampleCache();
}
/** Tests point the two examples at a local server. Production URLs are fixed. */
export function setFreeJobExampleUrlsForTests(urls: Record<ExampleKey, string>): void {
  exampleUrls = { ...urls };
  examples = newExampleCache();
}
export function setFreeJobRoleLookupForTests(fn: typeof lookupRole): void {
  roleLookup = fn;
}
export function freeJobExampleCacheForTests(): ExampleCache<FreeJobView> {
  return examples;
}
/** Tests point the fetch policy at a local server (e.g. allow 127.0.0.2 and its port). */
export function setFreeJobPolicyForTests(overrides: Partial<FetchPolicy>): void {
  policy = { ...DEFAULT_FETCH_POLICY, ...overrides };
}
export function setFreeJobTotalTimeoutForTests(ms: number): void {
  totalTimeoutMs = ms;
}
export function setFreeJobClockForTests(fn: () => Date): void {
  clock = fn;
}
export function freeJobLimiterKeysForTests(): string[] {
  return limiter.snapshotKeys();
}

// ---------------------------------------------------------------------------
// Presentation

export type FreeVerdictLabel = "Open" | "Closed" | "Can't tell";

const PLATFORM_HOSTS: Array<[RegExp, string]> = [
  [/(^|\.)greenhouse\.io$/, "Greenhouse"],
  [/(^|\.)lever\.co$/, "Lever"],
  [/(^|\.)ashbyhq\.com$/, "Ashby"],
  [/(^|\.)myworkdayjobs\.com$|(^|\.)myworkdaysite\.com$|(^|\.)workday\.com$/, "Workday"],
  [/(^|\.)smartrecruiters\.com$/, "SmartRecruiters"],
  [/(^|\.)workable\.com$/, "Workable"],
  [/(^|\.)icims\.com$/, "iCIMS"],
  [/(^|\.)jobvite\.com$/, "Jobvite"],
  [/(^|\.)bamboohr\.com$/, "BambooHR"],
  [/(^|\.)rippling\.com$|(^|\.)rippling-ats\.com$/, "Rippling"],
  [/(^|\.)linkedin\.com$/, "LinkedIn"],
  [/(^|\.)indeed\.com$/, "Indeed"],
  [/(^|\.)wellfound\.com$/, "Wellfound"],
];

export function platformFor(url: string): string {
  const ats = parseAtsJobUrl(url);
  if (ats) return { greenhouse: "Greenhouse", lever: "Lever", ashby: "Ashby", workday: "Workday" }[ats.vendor];
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "Careers page";
  }
  for (const [pattern, name] of PLATFORM_HOSTS) if (pattern.test(host)) return name;
  return "Company careers page";
}

export function verdictLabel(status: VerifyVerdict["status"] | "error"): FreeVerdictLabel {
  if (status === "live") return "Open";
  if (status === "closed") return "Closed";
  return "Can't tell";
}

const BLOCKED_COPY = "This site blocks automated checks or needs a login, so we won't guess.";
const UNCLEAR_COPY = "We couldn't get a clear answer from this page, so we won't guess.";
const UNREACHABLE_COPY = "We couldn't reach this site just now, so we won't guess.";

function formatDay(iso: string): string | undefined {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}

/** Signals in plain words. Unknown codes are skipped rather than shown raw. */
export function evidenceInPlainWords(signals: readonly string[], platform: string): string[] {
  const out: string[] = [];
  const add = (line: string) => {
    if (!out.includes(line)) out.push(line);
  };
  for (const signal of signals) {
    if (signal === ATS_API_LISTED) add(`Listed in ${platform}'s jobs API`);
    else if (signal === ATS_API_MISSING) add(`Removed from ${platform}'s jobs API`);
    else if (signal.startsWith("ats_posted_at:")) {
      const day = formatDay(signal.slice("ats_posted_at:".length));
      if (day) add(`Posted ${day}`);
    } else if (signal === "apply form present") add("Apply form is present");
    else if (signal === "no closure banner") add("No \"position closed\" notice on the page");
    else if (signal.startsWith("close_language:")) add(`Page says "${signal.slice("close_language:".length)}"`);
    else if (/^http_\d{3}$/.test(signal)) {
      const code = signal.slice(5);
      if (code === "404") add("Posting returns 404 (page not found)");
      else if (code === "410") add("Posting returns 410 (gone)");
      else add(`Posting returns HTTP ${code}`);
    } else if (signal === "redirected_to_board") add("Link now redirects to the job board, not the posting");
    else if (signal === "ats_empty_state") add("Job board shows no matching opening");
    else if (signal === "redirected_away_from_job") add("Link now redirects away from the posting");
    else if (signal === "careers_homepage") add("Link goes to a careers home page");
    else if (signal === "not_a_specific_posting") add("This link isn't one specific job posting");
    else if (signal === "collection_or_category") add("This is a list of jobs, not one posting");
    else if (signal === "challenge_page") add("Site showed a bot check (we don't bypass those)");
    else if (signal === "loginwalled") add("Site needs a login to show the posting");
    else if (signal === "js_shell") add("Page needs JavaScript to show the posting");
    else if (signal === "ambiguous_html") add("Page didn't clearly say open or closed");
    else if (signal === "check_timeout") add("The site took too long to answer");
  }
  return out;
}

const OPEN_LEANING = new Set(["Apply form is present", "No \"position closed\" notice on the page"]);

/**
 * Evidence shown under a verdict. On Closed, lines that point the other way
 * (a leftover apply button, no closed banner) are dropped so the card reads
 * as one answer. Open and Can't tell show everything.
 */
export function evidenceForVerdict(signals: readonly string[], platform: string, label: FreeVerdictLabel): string[] {
  const lines = evidenceInPlainWords(signals, platform);
  return label === "Closed" ? lines.filter((line) => !OPEN_LEANING.has(line)) : lines;
}

export function cantTellCopy(signals: readonly string[]): string {
  if (signals.some((s) => s === "challenge_page" || s === "loginwalled" || s === "js_shell")) return BLOCKED_COPY;
  return UNCLEAR_COPY;
}

function esc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export type FreeJobView =
  | { kind: "form" }
  | { kind: "invalid"; message: string; url?: string }
  | { kind: "limited"; perDay: number }
  | { kind: "busy" }
  | {
      kind: "result";
      url: string;
      label: FreeVerdictLabel;
      title?: string;
      /** The title line is the "no longer available" placeholder, not a role. */
      titleUnavailable?: boolean;
      platform: string;
      evidence: string[];
      explanation?: string;
      example?: ExampleKey;
    };

function priceLabel(): string {
  return `$${PRICE_USD.toFixed(2)}`;
}

function resultHtml(view: FreeJobView, remaining: number | undefined): string {
  if (view.kind === "form") return "";
  if (view.kind === "invalid") {
    return `<section class="note" role="alert"><p>${esc(view.message)}</p></section>`;
  }
  if (view.kind === "limited") {
    return `<section class="note" role="alert"><p><strong>You've used your ${view.perDay} free checks for today.</strong> Come back tomorrow, or have your agent use the API below.</p></section>`;
  }
  if (view.kind === "busy") {
    return `<section class="note" role="alert"><p><strong>Busy, try again in a few minutes.</strong></p></section>`;
  }
  const cls = view.label === "Open" ? "open" : view.label === "Closed" ? "closed" : "cant";
  const evidence = view.evidence.length
    ? `<ul class="evidence">${view.evidence.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`
    : "";
  return `<section class="result ${cls}" aria-live="polite">
    <p class="verdict">${esc(view.label)}</p>
    ${view.title ? `<p class="title${view.titleUnavailable ? " gone" : ""}">${esc(view.title)}</p>` : ""}
    <p class="platform">${esc(view.platform)}</p>
    ${view.explanation ? `<p class="explain">${esc(view.explanation)}</p>` : ""}
    ${evidence}
    ${
      view.example
        ? `<p class="muted small">Example: a real check of a Stripe posting, refreshed every ${Math.round(EXAMPLE_TTL_MS / 60_000)} minutes. It doesn't use your free checks.</p>`
        : ""
    }
    ${remaining !== undefined ? `<p class="muted small">${remaining} free check${remaining === 1 ? "" : "s"} left today.</p>` : ""}
  </section>`;
}

export function freeJobHtml(
  view: FreeJobView,
  options: { remaining?: number; perDay: number; origin?: string; formAction?: string },
): string {
  const action = esc(options.formAction ?? FREE_JOB_PATH);
  const value = view.kind === "result" || view.kind === "invalid" ? (view.url ?? "") : "";
  const origin = (options.origin ?? "https://livecheck.fly.dev").replace(/\/+$/, "");
  const pageUrl = `${origin}${FREE_JOB_PATH}`;
  const imageUrl = `${origin}${OG_IMAGE_PATH}`;
  const examplesForm = `<form class="examples" method="post" action="${action}">
    <span>Try one:</span>
    <button type="submit" name="example" value="open">${esc(FREE_JOB_EXAMPLES.open.label)}</button>
    <span aria-hidden="true">&middot;</span>
    <button type="submit" name="example" value="filled">${esc(FREE_JOB_EXAMPLES.filled.label)}</button>
  </form>`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Is this job still open? — Livecheck</title>
  <meta name="description" content="${esc(OG_DESCRIPTION)}" />
  <link rel="canonical" href="${esc(pageUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Livecheck" />
  <meta property="og:title" content="${esc(OG_TITLE)}" />
  <meta property="og:description" content="${esc(OG_DESCRIPTION)}" />
  <meta property="og:url" content="${esc(pageUrl)}" />
  <meta property="og:image" content="${esc(imageUrl)}" />
  <meta property="og:image:secure_url" content="${esc(imageUrl)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:image:alt" content="Livecheck showing Open for a real job posting: Is that job still open? Find out in one click." />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(OG_TITLE)}" />
  <meta name="twitter:description" content="${esc(OG_DESCRIPTION)}" />
  <meta name="twitter:image" content="${esc(imageUrl)}" />
  <meta name="twitter:image:alt" content="Livecheck showing Open for a real job posting." />
  <style>
    :root { --ink:#14211a; --paper:#f4efe4; --rule:#c9c0ae; --open:#1f7a46; --closed:#9b2c2c; --cant:#8a6d1b; --soft:#5c5346; }
    * { box-sizing: border-box; }
    html { -webkit-text-size-adjust:100%; text-size-adjust:100%; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:"Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif; font-size:17px; line-height:1.5; overflow-wrap:anywhere; }
    .wrap { max-width:42rem; margin:0 auto; padding-left:1.25rem; padding-right:1.25rem; }
    header.site { border-bottom:1px solid var(--rule); }
    header.site .wrap { padding-top:0.8rem; padding-bottom:0.8rem; }
    .brand { font-weight:700; font-size:1.05rem; letter-spacing:0.01em; text-decoration:none; color:var(--ink); }
    main.wrap { padding-top:2rem; padding-bottom:2.5rem; }
    h1 { font-size:2.2rem; line-height:1.15; letter-spacing:-0.02em; margin:0 0 0.4rem; }
    .lede { font-size:1.1rem; margin:0 0 1.4rem; }
    form.check { display:flex; gap:0.5rem; flex-wrap:wrap; }
    label { position:absolute; left:-9999px; }
    input[type=url] { flex:1 1 20rem; min-width:0; font-size:1.05rem; padding:0.75rem 0.85rem; border:2px solid var(--ink); border-radius:4px; background:#fffdf8; color:var(--ink); }
    form.check button { font-family:inherit; font-size:1.05rem; padding:0.75rem 1.4rem; border:2px solid var(--ink); border-radius:4px; background:var(--ink); color:var(--paper); cursor:pointer; }
    form.examples { margin:0.7rem 0 0; display:flex; flex-wrap:wrap; align-items:baseline; gap:0.35rem; font-size:1rem; color:var(--soft); }
    form.examples button { font:inherit; color:var(--ink); background:none; border:0; padding:0.35rem 0.1rem; text-decoration:underline; text-underline-offset:0.15em; cursor:pointer; }
    .result { margin:1.6rem 0; padding:1.2rem 1.3rem; border-left:8px solid var(--rule); background:#fffdf8; }
    .result.open { border-color:var(--open); } .result.closed { border-color:var(--closed); } .result.cant { border-color:var(--cant); }
    .verdict { font-size:2.6rem; font-weight:700; margin:0; line-height:1.1; }
    .open .verdict { color:var(--open); } .closed .verdict { color:var(--closed); } .cant .verdict { color:var(--cant); }
    .title { font-size:1.15rem; margin:0.5rem 0 0; } .title.gone { font-style:italic; color:var(--soft); }
    .platform { margin:0.1rem 0 0.6rem; color:var(--soft); }
    .evidence { margin:0.4rem 0 0; padding-left:1.2rem; }
    .note { margin:1.4rem 0; padding:0.9rem 1rem; border:1px solid var(--cant); background:#f8e7c7; }
    .muted { color:var(--soft); } .small { font-size:0.94rem; }
    .cta { margin-top:2rem; padding-top:1.2rem; border-top:1px solid var(--rule); }
    footer.site { border-top:1px solid var(--rule); padding:1.1rem 0 2rem; color:var(--soft); font-size:0.94rem; }
    footer.site p { margin:0 0 0.4rem; }
    footer.site nav a { margin-right:0.9rem; }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.92em; }
    a { color:var(--ink); }
    @media (max-width: 480px) {
      .wrap { padding-left:1rem; padding-right:1rem; }
      main.wrap { padding-top:1.4rem; }
      h1 { font-size:1.85rem; }
      .lede { font-size:1.05rem; }
      form.check { flex-direction:column; }
      input[type=url], form.check button { width:100%; flex:none; font-size:17px; }
      .verdict { font-size:2.3rem; }
      .result { padding:1rem 1rem; border-left-width:6px; }
    }
  </style>
</head>
<body>
<header class="site"><div class="wrap"><a class="brand" href="/">Livecheck</a></div></header>
<main class="wrap">
  <h1>Is this job still open?</h1>
  <p class="lede">Paste a job link. Livecheck checks the posting and the hiring platform right now and tells you Open, Closed, or Can't tell.</p>
  <form class="check" method="post" action="${action}">
    <label for="url">Paste a job posting link</label>
    <input id="url" name="url" type="url" required maxlength="2048" placeholder="Paste a job posting link" value="${esc(value)}" autocomplete="off" inputmode="url" />
    <button type="submit">Check</button>
  </form>
  ${examplesForm}
  ${resultHtml(view, options.remaining)}
  <p class="muted small">Free: ${options.perDay} checks per day, no wallet, no signup. We don't store the links you check.</p>
  <section class="cta">
    <p><strong>Building an AI agent?</strong> Same check by API: <code>POST /v1/verify/job</code>, ${priceLabel()} per call, no account or API key.
    &rarr; <a href="${FREE_JOB_PATH}/go/docs">Docs</a> &middot; <a href="${FREE_JOB_PATH}/go/skill">Agent skill</a></p>
  </section>
</main>
<footer class="site"><div class="wrap">
  <p>${esc(HOW_IT_WORKS)}</p>
  <nav><a href="${FREE_JOB_PATH}/go/docs">Docs</a><a href="${FREE_JOB_PATH}/go/skill">Agent skill</a><a href="mailto:${CONTACT_EMAIL}">Contact</a></nav>
</div></footer>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Routes

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};

function clientIp(c: Context): string {
  const fly = c.req.header("fly-client-ip")?.trim();
  if (fly) return fly;
  const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded;
  return "local";
}

function ensureVisitor(c: Context): string {
  const existing = getCookie(c, FREE_JOB_COOKIE);
  if (existing && /^[A-Za-z0-9_-]{16,64}$/.test(existing)) return existing;
  const id = randomBytes(16).toString("base64url");
  setCookie(c, FREE_JOB_COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:" || Boolean(process.env.FLY_APP_NAME),
    path: FREE_JOB_PATH,
    maxAge: 2 * 86_400,
  });
  return id;
}

function page(c: Context, view: FreeJobView, status: number, config: FreeJobConfig, remaining?: number) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
  if (view.kind === "busy") c.header("retry-after", "180");
  const origin = publicOrigin(c.req.url, c.req.header("host"));
  const formAction = sourceFormAction(carriedSource(c));
  return c.html(freeJobHtml(view, { perDay: config.perVisitorDaily, remaining, origin, formAction }), status as 200);
}

/** Hosts that count as "self" for the referrer dimension. */
function selfHosts(c: Context): string[] {
  const hosts = [c.req.header("host") ?? ""];
  try {
    hosts.push(new URL(publicOrigin(c.req.url, c.req.header("host"))).host);
  } catch {
    // ignore
  }
  return hosts.filter(Boolean);
}

/**
 * Source for this request. A page view reads the Referer host and
 * utm_source/ref. A form POST cannot (its Referer is /job), so the page
 * carries the already-reduced values in its own form action
 * (`/job?utm_source=x&sref=domain`), and they are re-sanitized here.
 */
function carriedSource(c: Context): { utm: string; referrer: string } {
  const utm = utmSource(c.req.query("utm_source") ?? c.req.query("ref"));
  if (c.req.method === "GET") return { utm, referrer: referrerSource(c.req.header("referer"), selfHosts(c)) };
  const sref = (c.req.query("sref") ?? "").trim().toLowerCase();
  const referrer =
    sref === "" ? "direct" : sref === "self" || sref === "other" ? sref : (registrableDomain(sref) ?? "other");
  return { utm, referrer };
}

function sourceFormAction(source: { utm: string; referrer: string }): string {
  const params = new URLSearchParams();
  if (source.utm !== "none") params.set("utm_source", source.utm);
  if (source.referrer !== "direct") params.set("sref", source.referrer);
  const query = params.toString();
  return query ? `${FREE_JOB_PATH}?${query}` : FREE_JOB_PATH;
}

function countSource(c: Context, event: "view" | "check", now: Date): void {
  const { utm, referrer } = carriedSource(c);
  bumpFreePageSources(event, { referrer, utm, ua: uaClass(c.req.header("user-agent")) }, now);
}

async function readSubmitted(c: Context): Promise<{ url?: unknown; example?: unknown }> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    return { url: body.url, example: body.example };
  }
  return {};
}

/**
 * One check, start to finish, through the guarded fetcher (SSRF rules on
 * every hop). Returns the card and whether the check got a verdict. Never
 * logs the link.
 */
async function runCheck(target: string, opts: { signal?: AbortSignal }): Promise<{ view: FreeJobView; ok: boolean }> {
  let platform = platformFor(target);
  const fetcher = guardedFetch(policy);
  let verdict: VerifyVerdict | undefined;
  try {
    verdict = await verifyUrl(target, fetcher, clock(), {
      atsApi: true,
      ...(opts.signal ? { signal: opts.signal } : {}),
      deadlineMs: totalTimeoutMs,
    });
  } catch (error) {
    // Never log the message: VerifyError text can contain the link.
    if (!(error instanceof VerifyError)) {
      console.warn(`[free_page] check failed (${error instanceof Error ? error.name : "error"})`);
    }
  }
  if (!verdict) {
    return { view: { kind: "result", url: target, label: "Can't tell", platform, evidence: [], explanation: UNREACHABLE_COPY }, ok: false };
  }
  const label = verdictLabel(verdict.status);
  let role: RoleInfo | undefined;
  if (label !== "Can't tell") {
    role = await roleLookup(target, fetcher, { timeoutMs: 5_000, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (role?.platform && platform === "Company careers page") platform = role.platform;
  }
  const line = roleLine(target, verdict, role);
  return {
    view: {
      kind: "result",
      url: target,
      label,
      ...(line.text ? { title: line.text } : {}),
      ...(line.unavailable ? { titleUnavailable: true } : {}),
      platform,
      evidence: evidenceForVerdict(verdict.signals, platform, label),
      ...(label === "Can't tell" ? { explanation: cantTellCopy(verdict.signals) } : {}),
    },
    ok: true,
  };
}

async function handleExample(c: Context, key: ExampleKey, config: FreeJobConfig, ip: string, visitor: string) {
  const now = clock();
  bumpFreePageMetric(key === "open" ? "example_open" : "example_filled", now);
  let view: FreeJobView;
  try {
    view = (await examples.get(key)).value;
  } catch {
    view = {
      kind: "result",
      url: exampleUrls[key],
      label: "Can't tell",
      platform: platformFor(exampleUrls[key]),
      evidence: [],
      explanation: UNREACHABLE_COPY,
      example: key,
    };
  }
  // Examples never touch the limiter: no cookie or IP count, no hourly cap.
  return page(c, view, 200, config, limiter.remaining(ip, visitor, config, now));
}

async function handleFreeCheck(c: Context) {
  const config = currentFreeJobConfig();
  const now = clock();
  if (!config.enabled) return c.text("Not found", 404);
  const visitor = ensureVisitor(c);
  const ip = clientIp(c);

  let submitted: { url?: unknown; example?: unknown } = {};
  try {
    submitted = await readSubmitted(c);
  } catch {
    submitted = {};
  }
  if (isExampleKey(submitted.example)) return handleExample(c, submitted.example, config, ip, visitor);
  const raw = submitted.url;
  const typed = typeof raw === "string" ? raw.trim().slice(0, 2048) : "";
  let target: string;
  try {
    target = parseTargetUrl(typed);
    await vetTarget(target, policy);
  } catch (error) {
    bumpFreePageMetric("invalid_url", now);
    const message =
      error instanceof BlockedTargetError
        ? `We only check public job pages (${error.message}).`
        : "That doesn't look like a link. Paste the full address, starting with https://";
    return page(c, { kind: "invalid", message, url: typed }, 400, config, limiter.remaining(ip, visitor, config, now));
  }

  const admit = limiter.admit(ip, visitor, config, now);
  if (!admit.ok) {
    if (admit.reason === "visitor_limit") {
      bumpFreePageMetric("limited", now);
      return page(c, { kind: "limited", perDay: config.perVisitorDaily }, 429, config, 0);
    }
    bumpFreePageMetric("busy", now);
    return page(c, { kind: "busy" }, 503, config);
  }

  let view: FreeJobView;
  try {
    view = (await runCheck(target, { signal: c.req.raw.signal })).view;
  } finally {
    admit.release();
  }
  if (view.kind !== "result") throw new Error("unexpected view");
  bumpFreePageMetric("checks", now);
  countSource(c, "check", now);
  bumpFreePageMetric(
    view.label === "Open" ? "verdict_open" : view.label === "Closed" ? "verdict_closed" : "verdict_cant_tell",
    now,
  );
  return page(c, view, 200, config, limiter.remaining(ip, visitor, config, now));
}

function sha(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Constant-time compare against FREE_PAGE_STATS_TOKEN. No token configured = always refused. */
export function statsTokenOk(c: Context): boolean {
  const secret = process.env[FREE_PAGE_STATS_TOKEN_ENV]?.trim() ?? "";
  if (secret.length < 16) return false;
  const bearer = c.req.header("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  const provided = (c.req.header("x-livecheck-stats-token") ?? bearer ?? c.req.query("token") ?? "").trim();
  if (!provided) return false;
  return timingSafeEqual(sha(provided), sha(secret));
}

export function registerFreeJobRoutes(app: Hono): void {
  app.get(FREE_JOB_PATH, (c) => {
    const config = currentFreeJobConfig();
    if (!config.enabled) return c.text("Not found", 404);
    const now = clock();
    const visitor = ensureVisitor(c);
    bumpFreePageMetric("views", now);
    countSource(c, "view", now);
    return page(c, { kind: "form" }, 200, config, limiter.remaining(clientIp(c), visitor, config, now));
  });
  app.post(FREE_JOB_PATH, async (c) => {
    try {
      return await handleFreeCheck(c);
    } catch (error) {
      // Never hand this to Hono's default onError: it would log the error, and
      // fetch/verify messages can contain the link.
      console.warn(`[free_page] internal error (${error instanceof Error ? error.name : "error"})`);
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) c.header(name, value);
      return c.text("Something went wrong. Please try again.", 500);
    }
  });
  app.get(OG_IMAGE_PATH, (c) => {
    c.header("content-type", "image/png");
    c.header("cache-control", "public, max-age=86400");
    c.header("x-content-type-options", "nosniff");
    return c.body(new Uint8Array(OG_IMAGE_PNG), 200);
  });
  app.get(`${FREE_JOB_PATH}/go/docs`, (c) => {
    bumpFreePageMetric("cta_docs", clock());
    c.header("cache-control", "no-store");
    return c.redirect(DOCS_URL, 302);
  });
  app.get(`${FREE_JOB_PATH}/go/skill`, (c) => {
    bumpFreePageMetric("cta_skill", clock());
    c.header("cache-control", "no-store");
    return c.redirect(SKILL_URL, 302);
  });
  // Private: needs FREE_PAGE_STATS_TOKEN (header x-livecheck-stats-token,
  // Authorization: Bearer, or ?token=). Anything else is a plain 404.
  app.get(`${FREE_JOB_PATH}/stats`, (c) => {
    c.header("cache-control", "no-store");
    if (!statsTokenOk(c)) return c.text("Not found", 404);
    const now = clock();
    const config = currentFreeJobConfig();
    return c.json({
      ...readFreePageStats(now),
      limits: {
        per_visitor_daily: config.perVisitorDaily,
        per_ip_daily: config.perIpDaily,
        hourly_cap: config.hourlyCap,
        concurrency: config.concurrency,
        enabled: config.enabled,
      },
      this_hour_checks: limiter.checksThisHour(now),
      in_flight: limiter.inFlightNow(),
      example_cache: { cached: examples.keys(), refreshes: examples.refreshes, ttl_minutes: EXAMPLE_TTL_MS / 60_000 },
      // MPP paid calls that could not return a real answer (review for refund).
      // Counts per UTC day only; this view is token-gated, never public /stats.
      mpp_refund_candidates: queryRefundCandidateDailyFromStore(now) ?? { available: false },
    });
  });
  // /check alias from the launch kit ("livecheck.fly.dev/job (or /check)").
  app.get("/check", (c) => c.redirect(FREE_JOB_PATH, 302));
  app.post("/check", (c) => c.redirect(FREE_JOB_PATH, 307));
}
