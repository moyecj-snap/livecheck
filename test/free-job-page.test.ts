import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { FIXTURES } from "../src/fixtures.js";
import { isBlockedAddress, assertPublicTarget, BlockedTargetError } from "../src/free-job-guard.js";
import {
  FREE_JOB_COOKIE,
  SKILL_URL,
  evidenceForVerdict,
  evidenceInPlainWords,
  freeJobLimiterKeysForTests,
  platformFor,
  resetFreeJobForTests,
  resolveFreeJobConfig,
  setFreeJobClockForTests,
  setFreeJobFetchForTests,
  setFreeJobResolverForTests,
} from "../src/free-job-page.js";
import { closeFreePageStore, freePageDbForTests, initFreePageStore } from "../src/free-job-store.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";

const OPEN_URL = "https://careers.acme-co.com/jobs/1842";
const GONE_URL = "https://careers.acme-co.com/jobs/7777";
const BLOCKED_URL = "https://careers.acme-co.com/jobs/5555";
const REDIRECT_TO_PRIVATE = "https://redirector.example.org/r/1";
const SECRET_QUERY = "https://careers.acme-co.com/jobs/1842?email=jane%40example.com&token=s3cr3t";

const ENV_KEYS = [
  "LIVECHECK_FREE_PER_VISITOR_DAILY",
  "LIVECHECK_FREE_PER_IP_DAILY",
  "LIVECHECK_FREE_HOURLY_CAP",
  "LIVECHECK_FREE_CONCURRENCY",
  "LIVECHECK_FREE_PAGE",
] as const;

let fetchCalls: string[] = [];
let hold: Promise<void> | undefined;

function stubFetch(): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    fetchCalls.push(url);
    if (hold) await hold;
    const path = new URL(url).pathname;
    if (url.startsWith(REDIRECT_TO_PRIVATE)) {
      return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/admin" } });
    }
    if (path === "/jobs/1842") return new Response(FIXTURES["jobs/1842"]!.body, { status: 200, headers: { "content-type": "text/html" } });
    if (path === "/jobs/7777") return new Response(FIXTURES["gone-404"]!.body ?? "", { status: 404, headers: { "content-type": "text/html" } });
    if (path === "/jobs/5555") {
      return new Response(FIXTURES["cloudflare-challenge"]!.body, { status: 200, headers: { "content-type": "text/html" } });
    }
    return new Response("nope", { status: 500 });
  }) as typeof fetch;
}

const app = createApp();

async function form(url: string, opts: { ip?: string; cookie?: string } = {}) {
  return app.request("/job", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "fly-client-ip": opts.ip ?? "203.0.113.10",
      ...(opts.cookie ? { cookie: `${FREE_JOB_COOKIE}=${opts.cookie}` } : {}),
    },
    body: new URLSearchParams({ url }).toString(),
  });
}

function visitor(n: number): string {
  return `visitor${String(n).padStart(12, "0")}`;
}

function paidCallCount(db: ReturnType<typeof initPaidCallStore>): number {
  assert.equal(db.ok, true);
  if (!db.ok) return -1;
  return Number((db.db.prepare("SELECT COUNT(*) AS n FROM paid_calls").get() as { n: number }).n);
}

describe("free /job page", () => {
  let paid: ReturnType<typeof initPaidCallStore>;
  let now = new Date("2026-10-27T16:00:00Z");
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    resetFreeJobForTests();
    fetchCalls = [];
    hold = undefined;
    now = new Date("2026-10-27T16:00:00Z");
    setFreeJobClockForTests(() => now);
    setFreeJobFetchForTests(stubFetch());
    setFreeJobResolverForTests(async (host) => (host === "evil-dns.example.org" ? ["127.0.0.1"] : ["93.184.216.34"]));
    initFreePageStore(":memory:");
    paid = initPaidCallStore(":memory:");
  });

  afterEach(() => {
    resetFreeJobForTests();
    closeFreePageStore();
    closePaidCallStore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("GET /job: one text box, CTA, privacy line, visitor cookie, no-store, view counted", async () => {
    const res = await app.request("/job");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /placeholder="Paste a job posting link"/);
    assert.match(html, />Check</);
    assert.match(html, /We don't store the links you check\./);
    assert.match(html, /Building an AI agent\?<\/strong> Same check by API: <code>POST \/v1\/verify\/job<\/code>, \$0\.01 per call, no account or API key\./);
    assert.match(html, /href="\/job\/go\/docs">Docs</);
    assert.match(html, /href="\/job\/go\/skill">Agent skill</);
    assert.equal(/<script/i.test(html), false, "no scripts, no third-party trackers");
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${FREE_JOB_COOKIE}=[A-Za-z0-9_-]{16,}`));
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const stats = (await (await app.request("/job/stats")).json()) as { today: { views: number } };
    assert.equal(stats.today.views, 1);
  });

  it("Open / Closed / Can't tell use the verify/job classifier and plain-words evidence", async () => {
    const open = await (await form(OPEN_URL, { cookie: visitor(1) })).text();
    assert.match(open, /class="verdict">Open</);
    assert.match(open, /Apply form is present/);
    assert.match(open, /Company careers page/);
    assert.match(open, /4 free checks left today/);

    const closed = await (await form(GONE_URL, { cookie: visitor(1) })).text();
    assert.match(closed, /class="verdict">Closed</);
    assert.match(closed, /Posting returns 404 \(page not found\)/);

    const cant = await (await form(BLOCKED_URL, { cookie: visitor(1) })).text();
    assert.match(cant, /class="verdict">Can&#39;t tell</);
    assert.match(cant, /This site blocks automated checks or needs a login, so we won&#39;t guess\./);

    const stats = (await (await app.request("/job/stats")).json()) as { today: Record<string, number> };
    assert.equal(stats.today.checks, 3);
    assert.equal(stats.today.verdict_open, 1);
    assert.equal(stats.today.verdict_closed, 1);
    assert.equal(stats.today.verdict_cant_tell, 1);
  });

  it("5 free checks per visitor per day by cookie, and by IP when the cookie changes", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await form(OPEN_URL, { cookie: visitor(1), ip: "198.51.100.7" });
      assert.equal(res.status, 200, `check ${i + 1}`);
    }
    const calls = fetchCalls.length;
    const sixth = await form(OPEN_URL, { cookie: visitor(1), ip: "198.51.100.7" });
    assert.equal(sixth.status, 429);
    assert.match(await sixth.text(), /You've used your 5 free checks for today/);
    assert.equal(fetchCalls.length, calls, "a limited request never fetches");

    // Same cookie from another IP: still that visitor's 5.
    assert.equal((await form(OPEN_URL, { cookie: visitor(1), ip: "198.51.100.8" })).status, 429);
    // Fresh cookie (cleared cookies) from the same IP: the IP limit holds.
    assert.equal((await form(OPEN_URL, { cookie: visitor(2), ip: "198.51.100.7" })).status, 429);
    // No cookie at all from the same IP: still limited.
    assert.equal((await form(OPEN_URL, { ip: "198.51.100.7" })).status, 429);
    // Someone else entirely is fine.
    assert.equal((await form(OPEN_URL, { cookie: visitor(3), ip: "198.51.100.9" })).status, 200);

    // Next Pacific day resets (midnight PT = 07:00Z in October).
    now = new Date("2026-10-28T07:00:01Z");
    assert.equal((await form(OPEN_URL, { cookie: visitor(1), ip: "198.51.100.7" })).status, 200);

    const stats = (await (await app.request("/job/stats")).json()) as { l7d: Record<string, number> };
    assert.equal(stats.l7d.limited, 4);
  });

  it("global hourly cap shows Busy and never fetches; resets next hour", async () => {
    process.env.LIVECHECK_FREE_HOURLY_CAP = "3";
    for (let i = 0; i < 3; i++) assert.equal((await form(OPEN_URL, { cookie: visitor(10 + i), ip: `192.0.2.${i + 1}` })).status, 200);
    const calls = fetchCalls.length;
    const busy = await form(OPEN_URL, { cookie: visitor(20), ip: "192.0.2.50" });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "180");
    assert.match(await busy.text(), /Busy, try again in a few minutes\./);
    assert.equal(fetchCalls.length, calls);
    // A busy answer does not use up the visitor's free checks.
    now = new Date(now.getTime() + 60 * 60 * 1000);
    const later = await form(OPEN_URL, { cookie: visitor(20), ip: "192.0.2.50" });
    assert.equal(later.status, 200);
    assert.match(await later.text(), /4 free checks left today/);
  });

  it("its own concurrency pool says Busy while full, and the paid API still answers 402", async () => {
    process.env.LIVECHECK_FREE_CONCURRENCY = "1";
    let release: () => void = () => {};
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = form(OPEN_URL, { cookie: visitor(30), ip: "192.0.2.30" });
    while (fetchCalls.length === 0) await new Promise((r) => setTimeout(r, 2));
    const second = await form(OPEN_URL, { cookie: visitor(31), ip: "192.0.2.31" });
    assert.equal(second.status, 503);
    const paidRes = await app.request("/v1/verify/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: OPEN_URL }),
    });
    assert.equal(paidRes.status, 402, "paid route is untouched by the free pool");
    release();
    assert.equal((await first).status, 200);
  });

  it("privacy: no paid_calls rows, no URL in the counts file, logs, or limiter; hashed keys only", async () => {
    const lines: string[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...args: unknown[]) => lines.push(args.map(String).join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;
    try {
      await form(SECRET_QUERY, { cookie: visitor(40), ip: "203.0.113.40" });
      await form(GONE_URL, { cookie: visitor(40), ip: "203.0.113.40" });
      await form(BLOCKED_URL, { cookie: visitor(40), ip: "203.0.113.40" });
      await app.request("/job/go/docs");
    } finally {
      Object.assign(console, original);
    }
    assert.equal(paidCallCount(paid), 0, "free checks are never paid calls");

    const db = freePageDbForTests();
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;
    assert.deepEqual(tables.map((t) => t.name), ["free_page_daily"]);
    const cols = (db.prepare("PRAGMA table_info(free_page_daily)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.deepEqual(cols, ["day", "metric", "n"]);
    const dump = JSON.stringify(db.prepare("SELECT * FROM free_page_daily").all());
    for (const needle of ["acme-co", "jobs/", "jane", "s3cr3t", "203.0.113.40", visitor(40)]) {
      assert.equal(dump.includes(needle), false, `counts file contains ${needle}`);
      assert.equal(lines.join("\n").includes(needle), false, `logs contain ${needle}`);
    }
    const keys = freeJobLimiterKeysForTests();
    assert.ok(keys.length >= 2);
    for (const key of keys) {
      assert.equal(key.includes("203.0.113.40"), false);
      assert.equal(key.includes(visitor(40)), false);
      assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    }
    const stats = await (await app.request("/job/stats")).text();
    assert.equal(stats.includes("acme-co"), false);
    assert.equal(stats.includes("203.0.113.40"), false);
  });

  it("only fetches public web hosts; a blocked link costs no free check", async () => {
    const blocked = [
      "http://127.0.0.1/admin",
      "http://localhost:43127/stats",
      "http://[::1]/",
      "http://10.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fdaa:0:1::3]:43127/stats",
      "http://8e4766c7d59608.vm.livecheck.internal:43127/stats",
      "https://careers.acme-co.com:22/jobs/1",
      "https://user:pass@careers.acme-co.com/jobs/1",
      "https://evil-dns.example.org/jobs/1",
      "ftp://careers.acme-co.com/jobs/1",
      "not a url",
    ];
    for (const url of blocked) {
      const res = await form(url, { cookie: visitor(50), ip: "203.0.113.50" });
      assert.equal(res.status, 400, url);
    }
    assert.deepEqual(fetchCalls, []);
    const ok = await form(OPEN_URL, { cookie: visitor(50), ip: "203.0.113.50" });
    assert.match(await ok.text(), /4 free checks left today/);

    // A public link that redirects to a private address is not followed.
    const redirected = await (await form(REDIRECT_TO_PRIVATE, { cookie: visitor(51), ip: "203.0.113.51" })).text();
    assert.match(redirected, /class="verdict">Can&#39;t tell</);
    assert.equal((fetchCalls as string[]).some((u) => u.includes("10.0.0.5")), false);
  });

  it("CTA clicks are counted and redirect to the docs and the skill", async () => {
    const docs = await app.request("/job/go/docs");
    assert.equal(docs.status, 302);
    assert.equal(docs.headers.get("location"), "/llms.txt");
    const skill = await app.request("/job/go/skill");
    assert.equal(skill.status, 302);
    assert.equal(skill.headers.get("location"), SKILL_URL);
    await app.request("/job/go/skill");
    const stats = (await (await app.request("/job/stats")).json()) as {
      today: Record<string, number>;
      note: string;
      persisted: boolean;
    };
    assert.equal(stats.today.cta_docs, 1);
    assert.equal(stats.today.cta_skill, 2);
    assert.match(stats.note, /Not paid calls/);
  });

  it("/check is an alias, LIVECHECK_FREE_PAGE=off hides it, and /stats revenue is untouched", async () => {
    const alias = await app.request("/check");
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.get("location"), "/job");
    await form(OPEN_URL, { cookie: visitor(60), ip: "203.0.113.60" });
    const doc = (await (await app.request("/stats?format=json&scope=local")).json()) as {
      traffic: { revenue: { all: { l30d_usd: number } }; reconciliation: { ok: boolean } };
    };
    assert.equal(doc.traffic.revenue.all.l30d_usd, 0);
    assert.equal(doc.traffic.reconciliation.ok, true);
    process.env.LIVECHECK_FREE_PAGE = "off";
    assert.equal((await app.request("/job")).status, 404);
  });
});

describe("free /job helpers", () => {
  it("config defaults match the launch kit and env overrides are bounded", () => {
    assert.deepEqual(resolveFreeJobConfig({}), {
      perVisitorDaily: 5,
      perIpDaily: 5,
      hourlyCap: 300,
      concurrency: 2,
      enabled: true,
    });
    const tuned = resolveFreeJobConfig({ LIVECHECK_FREE_HOURLY_CAP: "1000", LIVECHECK_FREE_PER_IP_DAILY: "15", LIVECHECK_FREE_CONCURRENCY: "99" });
    assert.equal(tuned.hourlyCap, 1000);
    assert.equal(tuned.perIpDaily, 15);
    assert.equal(tuned.concurrency, 2, "out-of-range values fall back");
  });

  it("names the platform and words the evidence", () => {
    assert.equal(platformFor("https://boards.greenhouse.io/acme/jobs/123"), "Greenhouse");
    assert.equal(platformFor("https://jobs.lever.co/acme/0d3c0a52-3f0b-4b39-9f3e-1d2e3f4a5b6c"), "Lever");
    assert.equal(platformFor("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R123"), "Workday");
    assert.equal(platformFor("https://www.linkedin.com/jobs/view/123"), "LinkedIn");
    assert.equal(platformFor("https://careers.acme-co.com/jobs/1"), "Company careers page");
    assert.deepEqual(evidenceInPlainWords(["ats_api_listed", "ats_posted_at:2026-10-01T12:00:00Z", "apply form present"], "Greenhouse"), [
      "Listed in Greenhouse's jobs API",
      "Posted Oct 1, 2026",
      "Apply form is present",
    ]);
    // Closed drops lines that point the other way (seen live on a dead Airbnb Greenhouse link).
    assert.deepEqual(
      evidenceForVerdict(["ats_api_missing", "redirected_away_from_job", "apply form present", "no closure banner"], "Greenhouse", "Closed"),
      ["Removed from Greenhouse's jobs API", "Link now redirects away from the posting"],
    );
    assert.deepEqual(evidenceInPlainWords(["ats_api_missing", "http_404", "weird_internal_code"], "Lever"), [
      "Removed from Lever's jobs API",
      "Posting returns 404 (page not found)",
    ]);
  });

  it("blocks private, loopback, link-local, Fly 6PN, and mapped addresses", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fdaa:0:1::3", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111"]) assert.equal(isBlockedAddress(ip), false, ip);
    await assert.rejects(assertPublicTarget("http://foo.internal/", async () => ["93.184.216.34"]), BlockedTargetError);
    await assertPublicTarget("https://boards.greenhouse.io/acme/jobs/1", async () => ["93.184.216.34"]);
  });
});
