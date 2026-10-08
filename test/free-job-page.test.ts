import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { FIXTURES } from "../src/fixtures.js";
import {
  BlockedTargetError,
  DEFAULT_FETCH_POLICY,
  guardedFetch,
  isBlockedAddress,
  vetTarget,
  type FetchPolicy,
} from "../src/free-job-guard.js";
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
  setFreeJobPolicyForTests,
  setFreeJobTotalTimeoutForTests,
} from "../src/free-job-page.js";
import {
  closeFreePageStore,
  freePageDbForTests,
  initFreePageStore,
  setFreePageSetting,
} from "../src/free-job-store.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";

// ---------------------------------------------------------------------------
// Local "internet": one server on 127.0.0.2. The test policy treats 127.0.0.2
// (and only it) as public, so 127.0.0.1, 10/8, 169.254/16 etc. stay blocked.

const PUBLIC_IP = "127.0.0.2";
let port = 0;
let server: Server;
const hits: Array<{ path: string; local: string }> = [];
const sockets = new Set<Socket>();
let lastHugeBytesWritten = -1;
let holdRelease: (() => void) | undefined;
let resolverCalls: string[] = [];
let rebindCount = 0;

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push({ path, local: req.socket.localAddress ?? "" });
    const loc = (to: string) => {
      res.writeHead(302, { location: to });
      res.end();
    };
    if (path.startsWith("/jobs/1842")) return html(res, 200, FIXTURES["jobs/1842"]!.body ?? "");
    if (path === "/jobs/7777") return html(res, 404, FIXTURES["gone-404"]!.body ?? "Not found");
    if (path === "/jobs/5555") return html(res, 200, FIXTURES["cloudflare-challenge"]!.body ?? "");
    if (path === "/redir/loopback") return loc(`http://127.0.0.1:${port}/jobs/1842`);
    if (path === "/redir/metadata") return loc("http://169.254.169.254/latest/meta-data/");
    if (path === "/redir/metadata6") return loc("http://[fd00:ec2::254]/latest/meta-data/");
    if (path === "/redir/mapped") return loc("http://[::ffff:127.0.0.1]/");
    if (path === "/redir/internal") return loc(`http://internal.test:${port}/jobs/1842`);
    if (path === "/redir/flyname") return loc(`http://8e4766c7d59608.vm.livecheck.internal:${port}/stats`);
    if (path === "/redir/port") return loc("http://acme.test:8080/jobs/1842");
    if (path === "/redir/ok") return loc(`http://acme.test:${port}/jobs/1842`);
    const loop = path.match(/^\/loop\/(\d+)$/);
    if (loop) return loc(`/loop/${Number(loop[1]) + 1}`);
    if (path === "/huge") {
      res.writeHead(200, { "content-type": "text/html" });
      const chunk = Buffer.alloc(64 * 1024, "a");
      let sent = 0;
      const total = 50 * 1024 * 1024;
      const pump = () => {
        while (sent < total) {
          sent += chunk.length;
          if (!res.write(chunk)) return void res.once("drain", pump);
        }
        res.end();
      };
      res.on("close", () => {
        lastHugeBytesWritten = req.socket.bytesWritten;
      });
      return pump();
    }
    if (path === "/gzip-bomb") {
      const bomb = gzipSync(Buffer.alloc(40 * 1024 * 1024, 0));
      res.writeHead(200, { "content-type": "text/html", "content-encoding": "gzip" });
      return void res.end(bomb);
    }
    if (path === "/slow-headers") return; // never answers
    if (path === "/slow-body") {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<html>");
      const t = setInterval(() => res.write("."), 200);
      res.on("close", () => clearInterval(t));
      return;
    }
    if (path === "/hold") {
      holdRelease = () => html(res, 200, FIXTURES["jobs/1842"]!.body ?? "");
      return;
    }
    html(res, 500, "nope");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return new Promise((resolve) =>
    server.listen(0, PUBLIC_IP, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

function testPolicy(overrides: Partial<FetchPolicy> = {}): Partial<FetchPolicy> {
  return {
    resolver: async (host: string) => {
      resolverCalls.push(host);
      if (host === "internal.test") return ["10.0.0.5"];
      if (host === "evil-dns.example.org") return ["127.0.0.1"];
      if (host === "meta.example.org") return ["169.254.169.254"];
      if (host === "rebind.test") return rebindCount++ === 0 ? [PUBLIC_IP] : ["127.0.0.1"];
      if (host.endsWith(".test")) return [PUBLIC_IP];
      throw new Error("ENOTFOUND");
    },
    isBlocked: (ip: string) => (ip === PUBLIC_IP ? false : isBlockedAddress(ip)),
    allowedPorts: new Set(["", "80", "443", String(port)]),
    ...overrides,
  };
}

const u = (path: string, host = "acme.test") => `http://${host}:${port}${path}`;

const ENV_KEYS = [
  "LIVECHECK_FREE_PER_VISITOR_DAILY",
  "LIVECHECK_FREE_PER_IP_DAILY",
  "LIVECHECK_FREE_HOURLY_CAP",
  "LIVECHECK_FREE_CONCURRENCY",
  "LIVECHECK_FREE_PAGE",
  "FREE_PAGE_STATS_TOKEN",
] as const;

const app = createApp();
const TOKEN = "t".repeat(20) + "statsTokenForTests";

async function form(url: string, opts: { ip?: string; cookie?: string } = {}) {
  return app.request("/job", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "fly-client-ip": opts.ip ?? "198.51.100.10",
      ...(opts.cookie ? { cookie: `${FREE_JOB_COOKIE}=${opts.cookie}` } : {}),
    },
    body: new URLSearchParams({ url }).toString(),
  });
}

async function freeStats(): Promise<Record<string, any>> {
  const res = await app.request("/job/stats", { headers: { "x-livecheck-stats-token": TOKEN } });
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, any>;
}

const visitor = (n: number) => `visitor${String(n).padStart(12, "0")}`;

before(startServer);
after(() => {
  for (const socket of sockets) socket.destroy();
  server.close();
});

describe("free /job page", () => {
  let paid: ReturnType<typeof initPaidCallStore>;
  let now = new Date("2026-10-27T16:00:00Z");
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.FREE_PAGE_STATS_TOKEN = TOKEN;
    resetFreeJobForTests();
    hits.length = 0;
    resolverCalls = [];
    rebindCount = 0;
    now = new Date("2026-10-27T16:00:00Z");
    setFreeJobClockForTests(() => now);
    setFreeJobPolicyForTests(testPolicy());
    initFreePageStore(":memory:");
    paid = initPaidCallStore(":memory:");
  });

  afterEach(() => {
    holdRelease?.();
    holdRelease = undefined;
    resetFreeJobForTests();
    closeFreePageStore();
    closePaidCallStore();
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  it("GET /job: one text box, POST form, CTA, privacy line, cookie, no-store, view counted", async () => {
    const res = await app.request("/job");
    assert.equal(res.status, 200);
    const page = await res.text();
    assert.match(page, /<form class="check" method="post" action="\/job">/);
    assert.match(page, /placeholder="Paste a job posting link"/);
    assert.match(page, /We don't store the links you check\./);
    assert.match(page, /Same check by API: <code>POST \/v1\/verify\/job<\/code>, \$0\.01 per call, no account or API key\./);
    assert.match(page, /href="\/job\/go\/docs">Docs</);
    assert.match(page, /href="\/job\/go\/skill">Agent skill</);
    assert.equal(/<script/i.test(page), false);
    const cookie = res.headers.get("set-cookie") ?? "";
    assert.match(cookie, new RegExp(`^${FREE_JOB_COOKIE}=[A-Za-z0-9_-]{16,}`));
    assert.match(cookie, /HttpOnly/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    assert.equal((await freeStats()).today.views, 1);
  });

  it("Open / Closed / Can't tell through the real pinned fetcher and the verify/job classifier", async () => {
    const open = await (await form(u("/jobs/1842"), { cookie: visitor(1) })).text();
    assert.match(open, /class="verdict">Open</);
    assert.match(open, /Apply form is present/);
    const closed = await (await form(u("/jobs/7777"), { cookie: visitor(1) })).text();
    assert.match(closed, /class="verdict">Closed</);
    assert.match(closed, /Posting returns 404 \(page not found\)/);
    const cant = await (await form(u("/jobs/5555"), { cookie: visitor(1) })).text();
    assert.match(cant, /class="verdict">Can&#39;t tell</);
    assert.match(cant, /This site blocks automated checks or needs a login, so we won&#39;t guess\./);
    assert.ok(hits.every((h) => h.local === PUBLIC_IP));
    const s = await freeStats();
    assert.deepEqual([s.today.checks, s.today.verdict_open, s.today.verdict_closed, s.today.verdict_cant_tell], [3, 1, 1, 1]);
  });

  it("limits: 5 per cookie, 15 per IP, per Pacific day", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await form(u("/jobs/1842"), { cookie: visitor(1), ip: "198.51.100.7" })).status, 200);
    const calls = hits.length;
    const sixth = await form(u("/jobs/1842"), { cookie: visitor(1), ip: "198.51.100.7" });
    assert.equal(sixth.status, 429);
    assert.match(await sixth.text(), /You've used your 5 free checks for today/);
    assert.equal(hits.length, calls, "a refused check never fetches");
    assert.equal((await form(u("/jobs/1842"), { cookie: visitor(1), ip: "198.51.100.8" })).status, 429, "same cookie, other IP");
    // Same IP, fresh cookies: allowed up to 15 per IP.
    for (let i = 0; i < 10; i++) assert.equal((await form(u("/jobs/1842"), { cookie: visitor(100 + i), ip: "198.51.100.7" })).status, 200);
    assert.equal((await form(u("/jobs/1842"), { cookie: visitor(200), ip: "198.51.100.7" })).status, 429, "16th from one IP");
    assert.equal((await form(u("/jobs/1842"), { ip: "198.51.100.7" })).status, 429, "no cookie, same IP");
    now = new Date("2026-10-28T07:00:01Z"); // midnight PT
    assert.equal((await form(u("/jobs/1842"), { cookie: visitor(1), ip: "198.51.100.7" })).status, 200);
  });

  it("hourly cap is a live setting: free:set-style change applies on the next request, no restart", async () => {
    assert.equal((await freeStats()).limits.hourly_cap, 300);
    setFreePageSetting("hourly_cap", 2);
    assert.equal((await freeStats()).limits.hourly_cap, 2);
    for (let i = 0; i < 2; i++) assert.equal((await form(u("/jobs/1842"), { cookie: visitor(10 + i), ip: `198.51.100.${20 + i}` })).status, 200);
    const busy = await form(u("/jobs/1842"), { cookie: visitor(20), ip: "198.51.100.50" });
    assert.equal(busy.status, 503);
    assert.equal(busy.headers.get("retry-after"), "180");
    assert.match(await busy.text(), /Busy, try again in a few minutes\./);
    setFreePageSetting("hourly_cap", 1000);
    assert.equal((await form(u("/jobs/1842"), { cookie: visitor(20), ip: "198.51.100.50" })).status, 200);
    assert.equal((await freeStats()).limits.hourly_cap, 1000);
    setFreePageSetting("enabled", 0);
    assert.equal((await app.request("/job")).status, 404);
  });

  it("own concurrency pool: Busy while full, paid route still 402", async () => {
    setFreePageSetting("concurrency", 1);
    const first = form(u("/hold"), { cookie: visitor(30), ip: "198.51.100.30" });
    while (!holdRelease) await new Promise((r) => setTimeout(r, 2));
    assert.equal((await form(u("/jobs/1842"), { cookie: visitor(31), ip: "198.51.100.31" })).status, 503);
    const paidRes = await app.request("/v1/verify/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: u("/jobs/1842") }),
    });
    assert.equal(paidRes.status, 402);
    holdRelease!();
    holdRelease = undefined;
    assert.equal((await first).status, 200);
  });

  it("/job/stats is private: 404 without the token, wrong token, or no secret set", async () => {
    assert.equal((await app.request("/job/stats")).status, 404);
    assert.equal((await app.request("/job/stats", { headers: { "x-livecheck-stats-token": "nope" } })).status, 404);
    assert.equal((await app.request(`/job/stats?token=${TOKEN}x`)).status, 404);
    assert.equal((await app.request(`/job/stats?token=${TOKEN}`)).status, 200);
    assert.equal((await app.request("/job/stats", { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
    delete process.env.FREE_PAGE_STATS_TOKEN;
    assert.equal((await app.request(`/job/stats?token=${TOKEN}`)).status, 404);
    // /stats (paid) stays public.
    assert.equal((await app.request("/stats?format=json")).status, 200);
  });

  // ---- Must-pass 1: SSRF ----
  it("SSRF: every redirect hop to loopback, metadata, internal names, mapped IPv6, or odd ports is refused", async () => {
    for (const path of ["/redir/loopback", "/redir/metadata", "/redir/metadata6", "/redir/mapped", "/redir/internal", "/redir/flyname", "/redir/port"]) {
      hits.length = 0;
      const page = await (await form(u(path, "redirector.test"), { cookie: visitor(40), ip: `198.51.100.${40 + hits.length}` })).text();
      assert.match(page, /class="verdict">Can&#39;t tell</, path);
      assert.deepEqual(hits.map((h) => h.path), [path], `${path}: only the public hop reached a server`);
      resetFreeJobForTests();
      setFreeJobPolicyForTests(testPolicy());
      setFreeJobClockForTests(() => now);
    }
    // Control: a redirect to a public host is followed.
    const ok = await (await form(u("/redir/ok", "redirector.test"), { cookie: visitor(41) })).text();
    assert.match(ok, /class="verdict">Open</);
  });

  it("SSRF: hostnames resolving to private IPs, literal private IPs, and non-80/443 ports are refused before any fetch", async () => {
    const blocked = [
      "http://127.0.0.1/admin",
      "http://localhost/",
      "http://[::1]/",
      "http://10.0.0.1/",
      "http://100.64.1.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[fd00:ec2::254]/",
      "http://[fdaa:0:1::3]/stats",
      "http://[::ffff:169.254.169.254]/",
      "http://8e4766c7d59608.vm.livecheck.internal/stats",
      "https://evil-dns.example.org/jobs/1",
      "https://meta.example.org/latest",
      `http://internal.test:${port}/jobs/1842`,
      "https://acme.test:8443/jobs/1",
      "http://acme.test:22/",
      "https://user:pass@acme.test/jobs/1",
      "ftp://acme.test/jobs/1",
    ];
    for (const url of blocked) {
      const res = await form(url, { cookie: visitor(50), ip: "198.51.100.50" });
      assert.equal(res.status, 400, url);
    }
    assert.equal(hits.length, 0);
    assert.match(await (await form(u("/jobs/1842"), { cookie: visitor(50), ip: "198.51.100.50" })).text(), /4 free checks left today/);
  });

  it("SSRF: DNS rebinding after the check cannot change where the connection goes", async () => {
    // Page pre-check sees 127.0.0.2; every later lookup says 127.0.0.1.
    // The fetch hop resolves again, vets, and refuses.
    const page = await (await form(u("/jobs/1842", "rebind.test"), { cookie: visitor(60) })).text();
    assert.match(page, /class="verdict">Can&#39;t tell</);
    assert.equal(hits.length, 0);

    // Direct: one resolve per hop, and the socket connects to that vetted IP.
    rebindCount = 0;
    resolverCalls = [];
    const fetcher = guardedFetch({ ...DEFAULT_FETCH_POLICY, ...testPolicy() } as FetchPolicy);
    const res = await fetcher(u("/jobs/1842", "rebind.test"));
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(resolverCalls, ["rebind.test"], "resolved exactly once for the hop");
    assert.equal(hits.at(-1)?.local, PUBLIC_IP, "connected to the vetted address");
  });

  // ---- Must-pass 2: links never stored, including logs ----
  it("links never stored: POST only, GET ignores ?url=, /check drops the query, no URL in logs/DB/limiter", async () => {
    const marker = `lcmarker${Date.now()}`;
    const getWithUrl = await app.request(`/job?url=${encodeURIComponent(u(`/jobs/1842?m=${marker}`))}`);
    assert.equal(getWithUrl.status, 200);
    assert.equal((await getWithUrl.text()).includes(marker), false, "GET never echoes or checks a URL");
    assert.equal(hits.length, 0);
    const alias = await app.request(`/check?url=${marker}`);
    assert.equal(alias.status, 302);
    assert.equal(alias.headers.get("location"), "/job", "redirect carries no query");
    const aliasPost = await app.request("/check", { method: "POST" });
    assert.equal(aliasPost.headers.get("location"), "/job");

    const out: string[] = [];
    const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    const capture = (...args: unknown[]) => void out.push(args.map(String).join(" "));
    Object.assign(console, { log: capture, warn: capture, error: capture, info: capture });
    process.stdout.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown) => (out.push(String(chunk)), true)) as typeof process.stderr.write;
    try {
      setFreeJobPolicyForTests(testPolicy({ hopTimeoutMs: 300 }));
      setFreeJobTotalTimeoutForTests(1000);
      await form(u(`/jobs/1842?email=jane%40example.com&m=${marker}`), { cookie: visitor(70), ip: "203.0.113.70" });
      await form(u(`/jobs/7777?m=${marker}`), { cookie: visitor(70), ip: "203.0.113.70" });
      await form(u(`/slow-headers?m=${marker}`), { cookie: visitor(70), ip: "203.0.113.70" }); // timeout path
      await form(`https://nxdomain-${marker}.example.org/x`, { cookie: visitor(70), ip: "203.0.113.70" }); // DNS failure path
      await form(u(`/loop/0?m=${marker}`), { cookie: visitor(70), ip: "203.0.113.70" }); // too many redirects path
    } finally {
      Object.assign(console, orig);
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    }
    const logs = out.join("\n");
    for (const needle of [marker, "jane", "acme.test", "203.0.113.70", visitor(70)]) {
      assert.equal(logs.includes(needle), false, `logs contain ${needle}`);
    }
    const db = freePageDbForTests();
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((t) => t.name);
    assert.deepEqual(tables, ["free_page_daily", "free_page_settings"]);
    const dump = JSON.stringify([db.prepare("SELECT * FROM free_page_daily").all(), db.prepare("SELECT * FROM free_page_settings").all()]);
    for (const needle of [marker, "acme", "jane", "203.0.113.70", visitor(70)]) assert.equal(dump.includes(needle), false);
    for (const key of freeJobLimiterKeysForTests()) assert.match(key, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(paid.ok && Number((paid.db.prepare("SELECT COUNT(*) AS n FROM paid_calls").get() as { n: number }).n), 0);
    assert.equal(JSON.stringify(await freeStats()).includes(marker), false);
  });

  // ---- Must-pass 3: fetch caps ----
  it("caps: a huge or slow page is cut off within limits and does not stall another check", async () => {
    setFreeJobPolicyForTests(testPolicy({ hopTimeoutMs: 1200 }));
    setFreeJobTotalTimeoutForTests(3000);
    const t0 = Date.now();
    const slow = form(u("/slow-body"), { cookie: visitor(80), ip: "203.0.113.80" });
    // Concurrency 2 (default): a fast check runs alongside the slow one.
    const fastStart = Date.now();
    const fast = await form(u("/jobs/1842"), { cookie: visitor(81), ip: "203.0.113.81" });
    assert.equal(fast.status, 200);
    assert.ok(Date.now() - fastStart < 1000, "fast check not stalled by the slow one");
    const slowPage = await (await slow).text();
    assert.match(slowPage, /class="verdict">Can&#39;t tell</);
    assert.ok(Date.now() - t0 < 3500, `slow page cut off in ${Date.now() - t0}ms`);
    const huge = await form(u("/huge"), { cookie: visitor(82), ip: "203.0.113.82" });
    assert.equal(huge.status, 200);
  });

  it("CTA clicks are counted; Docs → /llms.txt, skill → repo; /stats revenue untouched", async () => {
    assert.equal((await app.request("/job/go/docs")).headers.get("location"), "/llms.txt");
    assert.equal((await app.request("/job/go/skill")).headers.get("location"), SKILL_URL);
    await form(u("/jobs/1842"), { cookie: visitor(90) });
    const s = await freeStats();
    assert.equal(s.today.cta_docs, 1);
    assert.equal(s.today.cta_skill, 1);
    const doc = (await (await app.request("/stats?format=json&scope=local")).json()) as any;
    assert.equal(doc.traffic.revenue.all.l30d_usd, 0);
    assert.equal(doc.traffic.reconciliation.ok, true);
  });
});

describe("guardedFetch caps (direct)", () => {
  before(() => {
    hits.length = 0;
  });
  const policy = (o: Partial<FetchPolicy> = {}) => ({ ...DEFAULT_FETCH_POLICY, ...testPolicy(o) }) as FetchPolicy;

  it("body is capped at 5 MB and the connection is closed (50 MB page)", async () => {
    const t0 = Date.now();
    const res = await guardedFetch(policy())(u("/huge"));
    const bytes = (await res.arrayBuffer()).byteLength;
    assert.equal(bytes, 5 * 1024 * 1024);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(lastHugeBytesWritten > 0 && lastHugeBytesWritten < 20 * 1024 * 1024, `server wrote ${lastHugeBytesWritten}`);
    assert.ok(Date.now() - t0 < 3000);
  });

  it("decompressed bytes are capped too (gzip bomb)", async () => {
    const res = await guardedFetch(policy())(u("/gzip-bomb"));
    assert.equal((await res.arrayBuffer()).byteLength, 5 * 1024 * 1024);
  });

  it("per-hop timeout covers slow headers and a trickling body", async () => {
    let t0 = Date.now();
    await assert.rejects(guardedFetch(policy({ hopTimeoutMs: 500 }))(u("/slow-headers")), /timed out after 500ms/);
    assert.ok(Date.now() - t0 < 1500);
    t0 = Date.now();
    const res = await guardedFetch(policy({ hopTimeoutMs: 500 }))(u("/slow-body"));
    await assert.rejects(res.arrayBuffer());
    assert.ok(Date.now() - t0 < 1500);
  });

  it("at most 5 redirects", async () => {
    hits.length = 0;
    await assert.rejects(guardedFetch(policy())(u("/loop/0")), /more than 5 redirects/);
    assert.equal(hits.length, 6);
  });

  it("caller abort stops the hop", async () => {
    const ctrl = new AbortController();
    const p = guardedFetch(policy())(u("/slow-headers"), { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(p, /aborted/);
  });
});

describe("free /job helpers", () => {
  it("defaults: 5 per visitor, 15 per IP, 300/hour, 2 at a time; settings beat env", () => {
    assert.deepEqual(resolveFreeJobConfig({}), { perVisitorDaily: 5, perIpDaily: 15, hourlyCap: 300, concurrency: 2, enabled: true });
    assert.equal(resolveFreeJobConfig({ LIVECHECK_FREE_HOURLY_CAP: "500" }).hourlyCap, 500);
    assert.equal(resolveFreeJobConfig({ LIVECHECK_FREE_HOURLY_CAP: "500" }, { hourly_cap: 1000 }).hourlyCap, 1000);
    assert.equal(resolveFreeJobConfig({}, { enabled: 0 }).enabled, false);
  });

  it("names the platform and words the evidence", () => {
    assert.equal(platformFor("https://boards.greenhouse.io/acme/jobs/123"), "Greenhouse");
    assert.equal(platformFor("https://acme.wd5.myworkdayjobs.com/en-US/careers/job/Remote/Engineer_R123"), "Workday");
    assert.equal(platformFor("https://careers.acme-co.com/jobs/1"), "Company careers page");
    assert.deepEqual(evidenceInPlainWords(["ats_api_listed", "ats_posted_at:2026-10-01T12:00:00Z", "apply form present"], "Greenhouse"), [
      "Listed in Greenhouse's jobs API",
      "Posted Oct 1, 2026",
      "Apply form is present",
    ]);
    assert.deepEqual(
      evidenceForVerdict(["ats_api_missing", "redirected_away_from_job", "apply form present", "no closure banner"], "Greenhouse", "Closed"),
      ["Removed from Greenhouse's jobs API", "Link now redirects away from the posting"],
    );
  });

  it("address policy: private, loopback, link-local, CGNAT, Fly 6PN, metadata, mapped, NAT64, 6to4", async () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "::", "fdaa:0:1::3", "fd00:ec2::254", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "64:ff9b::a00:1", "2002:a00:1::1"]) {
      assert.equal(isBlockedAddress(ip), true, ip);
    }
    for (const ip of ["93.184.216.34", "8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isBlockedAddress(ip), false, ip);
    await assert.rejects(vetTarget("http://foo.internal/", { ...DEFAULT_FETCH_POLICY, resolver: async () => ["93.184.216.34"] }), BlockedTargetError);
    const ok = await vetTarget("https://boards.greenhouse.io/acme/jobs/1", { ...DEFAULT_FETCH_POLICY, resolver: async () => ["93.184.216.34"] });
    assert.equal(ok.address, "93.184.216.34");
  });

  it("npm run free:set / free:get / free:unset on a file DB", () => {
    const dir = mkdtempSync(join(tmpdir(), "lc-free-cli-"));
    const tsx = join(process.cwd(), "node_modules/.bin/tsx");
    const script = join(process.cwd(), "scripts/free-page-settings.ts");
    const run = (args: string[]) => spawnSync(tsx, [script, ...args], { encoding: "utf8", env: { ...process.env, FLY_APP_NAME: "" } });
    try {
      const path = join(dir, "free-page.sqlite");
      assert.equal(run(["get", "--db", path]).status, 2, "never creates the DB");
      initFreePageStore(path);
      closeFreePageStore();
      const set = run(["set", "hourly_cap", "1000", "--db", path, "--json"]);
      assert.equal(set.status, 0, set.stderr);
      assert.equal(JSON.parse(set.stdout).effective.hourlyCap, 1000);
      assert.equal(run(["set", "hourly_cap", "-1", "--db", path]).status, 2);
      assert.equal(run(["set", "bogus", "1", "--db", path]).status, 2);
      assert.equal(JSON.parse(run(["set", "enabled", "off", "--db", path, "--json"]).stdout).effective.enabled, false);
      const unset = run(["unset", "hourly_cap", "--db", path, "--json"]);
      assert.equal(JSON.parse(unset.stdout).effective.hourlyCap, 300);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
