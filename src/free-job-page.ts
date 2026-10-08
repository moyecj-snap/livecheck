import { createHmac, randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { ATS_API_LISTED, ATS_API_MISSING, parseAtsJobUrl } from "./ats-api.js";
import { PRICE_USD } from "./config.js";
import { BlockedTargetError, assertPublicTarget, defaultResolver, guardedFetch, type Resolver } from "./free-job-guard.js";
import { bumpFreePageMetric, pacificDay, readFreePageStats } from "./free-job-store.js";
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

export type FreeJobConfig = {
  perVisitorDaily: number;
  perIpDaily: number;
  hourlyCap: number;
  concurrency: number;
  enabled: boolean;
};

export const FREE_JOB_DEFAULTS: Omit<FreeJobConfig, "enabled"> = {
  perVisitorDaily: 5,
  perIpDaily: 5,
  hourlyCap: 300,
  concurrency: 2,
};

function intEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}

/**
 * Env knobs (a `fly secrets set` restarts the machine; no deploy):
 * LIVECHECK_FREE_PER_VISITOR_DAILY (5), LIVECHECK_FREE_PER_IP_DAILY (5),
 * LIVECHECK_FREE_HOURLY_CAP (300), LIVECHECK_FREE_CONCURRENCY (2),
 * LIVECHECK_FREE_PAGE=off hides the page.
 */
export function resolveFreeJobConfig(env: NodeJS.ProcessEnv = process.env): FreeJobConfig {
  const off = ["off", "0", "false", "none"].includes((env.LIVECHECK_FREE_PAGE ?? "").trim().toLowerCase());
  return {
    perVisitorDaily: intEnv(env, "LIVECHECK_FREE_PER_VISITOR_DAILY", FREE_JOB_DEFAULTS.perVisitorDaily, 1, 1000),
    perIpDaily: intEnv(env, "LIVECHECK_FREE_PER_IP_DAILY", FREE_JOB_DEFAULTS.perIpDaily, 1, 10_000),
    hourlyCap: intEnv(env, "LIVECHECK_FREE_HOURLY_CAP", FREE_JOB_DEFAULTS.hourlyCap, 0, 100_000),
    concurrency: intEnv(env, "LIVECHECK_FREE_CONCURRENCY", FREE_JOB_DEFAULTS.concurrency, 1, 16),
    enabled: !off,
  };
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

  /** Audit seam: every key the limiter holds (hashes only). */
  snapshotKeys(): string[] {
    return [...this.ips.keys(), ...this.visitors.keys()];
  }
}

let limiter = new FreeJobLimiter();
let fetchImpl: typeof fetch | undefined;
let resolverImpl: Resolver = defaultResolver;
let clock: () => Date = () => new Date();

export function resetFreeJobForTests(): void {
  limiter = new FreeJobLimiter();
  fetchImpl = undefined;
  resolverImpl = defaultResolver;
  clock = () => new Date();
}
export function setFreeJobFetchForTests(fn: typeof fetch | undefined): void {
  fetchImpl = fn;
}
export function setFreeJobResolverForTests(fn: Resolver): void {
  resolverImpl = fn;
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
      platform: string;
      evidence: string[];
      explanation?: string;
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
    ${view.title ? `<p class="title">${esc(view.title)}</p>` : ""}
    <p class="platform">${esc(view.platform)}</p>
    ${view.explanation ? `<p class="explain">${esc(view.explanation)}</p>` : ""}
    ${evidence}
    ${remaining !== undefined ? `<p class="muted small">${remaining} free check${remaining === 1 ? "" : "s"} left today.</p>` : ""}
  </section>`;
}

export function freeJobHtml(view: FreeJobView, options: { remaining?: number; perDay: number }): string {
  const value = view.kind === "result" || view.kind === "invalid" ? (view.url ?? "") : "";
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Is this job still open? — Livecheck</title>
  <meta name="description" content="Paste a job posting link and Livecheck tells you if it's still open, closed, or can't tell. Free, no signup." />
  <style>
    :root { --ink:#14211a; --paper:#f4efe4; --rule:#c9c0ae; --open:#1f7a46; --closed:#9b2c2c; --cant:#8a6d1b; }
    * { box-sizing: border-box; }
    body { margin:0; color:var(--ink); background:var(--paper); font-family:"Iowan Old Style","Palatino Linotype",Palatino,serif; line-height:1.5; }
    main { max-width:42rem; margin:0 auto; padding:2.5rem 1.25rem 4rem; }
    h1 { font-size:2.2rem; letter-spacing:-0.02em; margin:0 0 0.3rem; }
    .lede { font-size:1.1rem; margin:0 0 1.4rem; }
    form { display:flex; gap:0.5rem; flex-wrap:wrap; }
    label { position:absolute; left:-9999px; }
    input[type=url] { flex:1 1 20rem; font-size:1.05rem; padding:0.75rem 0.85rem; border:2px solid var(--ink); border-radius:4px; background:#fffdf8; }
    button { font-size:1.05rem; padding:0.75rem 1.4rem; border:2px solid var(--ink); border-radius:4px; background:var(--ink); color:var(--paper); cursor:pointer; }
    .result { margin:1.6rem 0; padding:1.2rem 1.3rem; border-left:8px solid var(--rule); background:#fffdf8; }
    .result.open { border-color:var(--open); } .result.closed { border-color:var(--closed); } .result.cant { border-color:var(--cant); }
    .verdict { font-size:2.6rem; font-weight:700; margin:0; line-height:1.1; }
    .open .verdict { color:var(--open); } .closed .verdict { color:var(--closed); } .cant .verdict { color:var(--cant); }
    .title { font-size:1.15rem; margin:0.5rem 0 0; } .platform { margin:0.1rem 0 0.6rem; color:#5c5346; }
    .evidence { margin:0.4rem 0 0; padding-left:1.2rem; }
    .note { margin:1.4rem 0; padding:0.9rem 1rem; border:1px solid var(--cant); background:#f8e7c7; }
    .muted { color:#5c5346; } .small { font-size:0.9rem; }
    .cta { margin-top:2.2rem; padding-top:1.2rem; border-top:1px solid var(--rule); }
    code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:0.92em; }
    a { color:var(--ink); }
  </style>
</head>
<body>
<main>
  <h1>Is this job still open?</h1>
  <p class="lede">Paste a job link. Livecheck checks the posting and the hiring platform right now and tells you Open, Closed, or Can't tell.</p>
  <form method="post" action="${FREE_JOB_PATH}">
    <label for="url">Paste a job posting link</label>
    <input id="url" name="url" type="url" required maxlength="2048" placeholder="Paste a job posting link" value="${esc(value)}" autocomplete="off" />
    <button type="submit">Check</button>
  </form>
  ${resultHtml(view, options.remaining)}
  <p class="muted small">Free: ${options.perDay} checks per day, no wallet, no signup. We don't store the links you check.</p>
  <section class="cta">
    <p><strong>Building an AI agent?</strong> Same check by API: <code>POST /v1/verify/job</code>, ${priceLabel()} per call, no account or API key.
    &rarr; <a href="${FREE_JOB_PATH}/go/docs">Docs</a> &middot; <a href="${FREE_JOB_PATH}/go/skill">Agent skill</a></p>
  </section>
</main>
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
  return c.html(freeJobHtml(view, { perDay: config.perVisitorDaily, remaining }), status as 200);
}

async function readSubmittedUrl(c: Context): Promise<unknown> {
  const type = c.req.header("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const body = await c.req.parseBody();
    return body.url;
  }
  return undefined;
}

async function handleFreeCheck(c: Context) {
  const config = resolveFreeJobConfig();
  const now = clock();
  if (!config.enabled) return c.text("Not found", 404);
  const visitor = ensureVisitor(c);
  const ip = clientIp(c);

  let raw: unknown;
  try {
    raw = await readSubmittedUrl(c);
  } catch {
    raw = undefined;
  }
  const typed = typeof raw === "string" ? raw.trim().slice(0, 2048) : "";
  let target: string;
  try {
    target = parseTargetUrl(typed);
    await assertPublicTarget(target, resolverImpl);
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
    const platform = platformFor(target);
    let verdict: VerifyVerdict | undefined;
    try {
      verdict = await verifyUrl(target, guardedFetch(fetchImpl ?? fetch, resolverImpl), now, {
        atsApi: true,
        signal: c.req.raw.signal,
      });
    } catch (error) {
      if (!(error instanceof VerifyError)) throw error;
    }
    if (verdict) {
      const label = verdictLabel(verdict.status);
      view = {
        kind: "result",
        url: target,
        label,
        ...(verdict.title ? { title: verdict.title } : {}),
        platform,
        evidence: evidenceForVerdict(verdict.signals, platform, label),
        ...(label === "Can't tell" ? { explanation: cantTellCopy(verdict.signals) } : {}),
      };
    } else {
      view = { kind: "result", url: target, label: "Can't tell", platform, evidence: [], explanation: UNREACHABLE_COPY };
    }
  } finally {
    admit.release();
  }
  bumpFreePageMetric("checks", now);
  bumpFreePageMetric(
    view.label === "Open" ? "verdict_open" : view.label === "Closed" ? "verdict_closed" : "verdict_cant_tell",
    now,
  );
  return page(c, view, 200, config, limiter.remaining(ip, visitor, config, now));
}

export function registerFreeJobRoutes(app: Hono): void {
  app.get(FREE_JOB_PATH, (c) => {
    const config = resolveFreeJobConfig();
    if (!config.enabled) return c.text("Not found", 404);
    const now = clock();
    const visitor = ensureVisitor(c);
    bumpFreePageMetric("views", now);
    return page(c, { kind: "form" }, 200, config, limiter.remaining(clientIp(c), visitor, config, now));
  });
  app.post(FREE_JOB_PATH, handleFreeCheck);
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
  app.get(`${FREE_JOB_PATH}/stats`, (c) => {
    c.header("cache-control", "no-store");
    return c.json(readFreePageStats(clock()));
  });
  // /check alias from the launch kit ("livecheck.fly.dev/job (or /check)").
  app.get("/check", (c) => c.redirect(FREE_JOB_PATH, 302));
  app.post("/check", (c) => c.redirect(FREE_JOB_PATH, 307));
}
