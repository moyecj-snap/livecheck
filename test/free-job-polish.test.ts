import assert from "node:assert/strict";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { FIXTURES } from "../src/fixtures.js";
import { isBlockedAddress, type FetchPolicy } from "../src/free-job-guard.js";
import { EXAMPLE_FAIL_TTL_MS, EXAMPLE_TTL_MS, ExampleCache, FREE_JOB_EXAMPLES } from "../src/free-job-examples.js";
import {
  CONTACT_EMAIL,
  FREE_JOB_COOKIE,
  HOW_IT_WORKS,
  OG_DESCRIPTION,
  freeJobExampleCacheForTests,
  resetFreeJobForTests,
  setFreeJobClockForTests,
  setFreeJobExampleUrlsForTests,
  setFreeJobPolicyForTests,
  setFreeJobRoleLookupForTests,
} from "../src/free-job-page.js";
import { NO_LONGER_AVAILABLE, boardTokenFromHost, lookupRole, roleLine, roleRefFor } from "../src/free-job-role.js";
import { closeFreePageStore, freePageDbForTests, initFreePageStore } from "../src/free-job-store.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";
import { clearAtsResponseCache } from "../src/ats-cache.js";

const PUBLIC_IP = "127.0.0.2";
let port = 0;
let server: Server;
const hits: string[] = [];
const sockets = new Set<Socket>();
let slowRelease: Array<() => void> = [];

const BOARD_HTML = `<!doctype html><html><head><title>Acme Careers | Open Roles</title></head><body>
<h1>Open Roles</h1><ul>
${Array.from({ length: 6 }, (_, i) => `<li class="job-card"><a href="/careers/listing/role-${i}/${1000 + i}">Role ${i}</a></li>`).join("\n")}
</ul></body></html>`;

function html(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
}

function startServer(): Promise<void> {
  server = createServer((req, res) => {
    const path = req.url ?? "/";
    hits.push(path);
    if (path.startsWith("/jobs/1842")) return html(res, 200, FIXTURES["jobs/1842"]!.body ?? "");
    if (path.startsWith("/jobs/search?gh_jid=9000")) {
      res.writeHead(302, { location: "/careers/search" });
      return void res.end();
    }
    if (path === "/careers/search") return html(res, 200, BOARD_HTML);
    if (path === "/gone") return html(res, 404, "<html><head><title>Page not found</title></head><body>Not found</body></html>");
    if (path === "/to-metadata") {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      return void res.end();
    }
    if (path === "/slow-open") {
      slowRelease.push(() => html(res, 200, FIXTURES["jobs/1842"]!.body ?? ""));
      return;
    }
    html(res, 500, "nope");
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  return new Promise((resolve) =>
    server.listen(0, PUBLIC_IP, () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    }),
  );
}

function policy(): Partial<FetchPolicy> {
  return {
    resolver: async (host: string) => {
      if (host.endsWith(".test")) return [PUBLIC_IP];
      throw new Error("ENOTFOUND");
    },
    isBlocked: (ip: string) => (ip === PUBLIC_IP ? false : isBlockedAddress(ip)),
    allowedPorts: new Set(["", "80", "443", String(port)]),
  };
}

const u = (path: string, host = "careers.acme.test") => `http://${host}:${port}${path}`;
const app = createApp();

async function post(fields: Record<string, string>, opts: { cookie?: string; ip?: string } = {}) {
  return app.request("/job", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "fly-client-ip": opts.ip ?? "198.51.100.10",
      host: "livecheck.fly.dev",
      ...(opts.cookie ? { cookie: `${FREE_JOB_COOKIE}=${opts.cookie}` } : {}),
    },
    body: new URLSearchParams(fields).toString(),
  });
}
const visitor = (n: number) => `polishvisitor${String(n).padStart(8, "0")}`;
const verdictOf = (page: string) => page.match(/class="verdict">([^<]*)</)?.[1];
const titleOf = (page: string) => page.match(/class="title[^"]*">([^<]*)</)?.[1];

before(startServer);
after(() => {
  for (const s of sockets) s.destroy();
  server.close();
});

describe("free /job polish", () => {
  let now = new Date("2026-10-27T16:00:00Z");
  let paid: ReturnType<typeof initPaidCallStore>;
  beforeEach(() => {
    resetFreeJobForTests();
    clearAtsResponseCache();
    hits.length = 0;
    slowRelease = [];
    now = new Date("2026-10-27T16:00:00Z");
    setFreeJobClockForTests(() => now);
    setFreeJobPolicyForTests(policy());
    setFreeJobExampleUrlsForTests({ open: u("/jobs/1842"), filled: u("/jobs/search?gh_jid=9000") });
    initFreePageStore(":memory:");
    paid = initPaidCallStore(":memory:");
  });
  afterEach(() => {
    for (const release of slowRelease) release();
    resetFreeJobForTests();
    closeFreePageStore();
    closePaidCallStore();
  });

  // ---- 1. Examples ----
  it("examples: POST buttons under the box, production links fixed, no link in any href or query", async () => {
    const page = await (await app.request("/job")).text();
    assert.match(page, /Try one:/);
    assert.match(page, /<form class="examples" method="post" action="\/job">/);
    assert.match(page, /<button type="submit" name="example" value="open">open job<\/button>/);
    assert.match(page, /<button type="submit" name="example" value="filled">filled job<\/button>/);
    assert.equal(/href="[^"]*(stripe|gh_jid)/.test(page), false, "no example link in an href");
    assert.equal(FREE_JOB_EXAMPLES.open.url, "https://stripe.com/jobs/search?gh_jid=8172508");
    assert.equal(FREE_JOB_EXAMPLES.filled.url, "https://stripe.com/jobs/search?gh_jid=7569678");
  });

  it("examples don't use the 5 free checks (cookie or IP) and aren't paid calls", async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post({ url: u("/jobs/1842") }, { cookie: visitor(1) })).status, 200);
    assert.equal((await post({ url: u("/jobs/1842") }, { cookie: visitor(1) })).status, 429);
    const open = await post({ example: "open" }, { cookie: visitor(1) });
    assert.equal(open.status, 200);
    const page = await open.text();
    assert.equal(verdictOf(page), "Open");
    assert.match(page, /It doesn't use your free checks\./);
    assert.match(page, /0 free checks left today\./);
    const filled = await (await post({ example: "filled" }, { cookie: visitor(1) })).text();
    assert.equal(verdictOf(filled), "Closed");
    // Still limited for real links; examples didn't add to the count either way.
    assert.equal((await post({ url: u("/jobs/1842") }, { cookie: visitor(1) })).status, 429);
    const db = freePageDbForTests();
    const counts = Object.fromEntries((db.prepare("SELECT metric, n FROM free_page_daily").all() as Array<{ metric: string; n: number }>).map((r) => [r.metric, Number(r.n)]));
    assert.equal(counts.checks, 5);
    assert.equal(counts.example_open, 1);
    assert.equal(counts.example_filled, 1);
    assert.ok(paid.ok);
    assert.equal(paid.ok && Number((paid.db.prepare("SELECT COUNT(*) AS n FROM paid_calls").get() as { n: number }).n), 0);
    const stats = (await (await app.request("/stats?format=json&scope=local")).json()) as any;
    assert.equal(stats.traffic.revenue.all.l30d_usd, 0);
  });

  it("examples are cached with single-flight: a spike makes one upstream check per TTL", async () => {
    setFreeJobExampleUrlsForTests({ open: u("/slow-open"), filled: u("/jobs/search?gh_jid=9000") });
    const burst = Array.from({ length: 25 }, (_, i) => post({ example: "open" }, { ip: `203.0.113.${i + 1}` }));
    while (slowRelease.length === 0) await new Promise((r) => setTimeout(r, 2));
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(slowRelease.length as number, 1, "one upstream request for 25 clicks");
    slowRelease.shift()!();
    const pages = await Promise.all(burst.map(async (r) => verdictOf(await (await r).text())));
    assert.ok(pages.every((v) => v === "Open"));
    assert.equal(hits.filter((h) => h === "/slow-open").length, 1);
    // Within the TTL: served from cache.
    now = new Date(now.getTime() + EXAMPLE_TTL_MS - 1000);
    await post({ example: "open" });
    assert.equal(hits.filter((h) => h === "/slow-open").length, 1);
    // Stale: answer right away from cache, refresh once in the background.
    now = new Date(now.getTime() + 2000);
    const stale = await Promise.all([post({ example: "open" }), post({ example: "open" }), post({ example: "open" })]);
    assert.ok((await Promise.all(stale.map(async (r) => verdictOf(await r.text())))).every((v) => v === "Open"));
    while (slowRelease.length === 0) await new Promise((r) => setTimeout(r, 2));
    assert.equal(slowRelease.length as number, 1, "one background refresh");
    slowRelease.shift()!();
    assert.equal(freeJobExampleCacheForTests().refreshes, 2);
    assert.deepEqual(freeJobExampleCacheForTests().keys(), ["open"]);
  });

  it("examples keep SSRF guards; a failed refresh is cached for a minute", async () => {
    setFreeJobExampleUrlsForTests({ open: u("/to-metadata"), filled: u("/jobs/search?gh_jid=9000") });
    const page = await (await post({ example: "open" })).text();
    assert.equal(verdictOf(page), "Can&#39;t tell");
    assert.deepEqual(hits, ["/to-metadata"], "the 169.254.169.254 hop was refused");
    await post({ example: "open" });
    assert.equal(hits.length, 1, "failure cached");
    now = new Date(now.getTime() + EXAMPLE_FAIL_TTL_MS + 1000);
    await post({ example: "open" });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hits.length, 2, "retried after the failure TTL");
  });

  it("the cache never holds visitor links", async () => {
    await post({ url: u("/jobs/1842") }, { cookie: visitor(2) });
    await post({ url: u("/gone") }, { cookie: visitor(2) });
    assert.deepEqual(freeJobExampleCacheForTests().keys(), []);
    await post({ example: "filled" });
    assert.deepEqual(freeJobExampleCacheForTests().keys(), ["filled"]);
    const bogus = await post({ example: u("/jobs/1842") }, { cookie: visitor(2) });
    assert.equal(bogus.status, 400, "an unknown example value is not a link and is not fetched");
  });

  it("ExampleCache unit: TTL, stale-while-revalidate, single flight", async () => {
    let t = 0;
    let calls = 0;
    let gate: (() => void) | undefined;
    const cache = new ExampleCache<string>(
      async (key) => {
        calls += 1;
        await new Promise<void>((r) => (gate = r));
        return { value: `${key}-${calls}`, ok: true };
      },
      () => t,
      1000,
      100,
    );
    const a = cache.get("open");
    const b = cache.get("open");
    gate!();
    assert.deepEqual(await Promise.all([a, b]), [
      { value: "open-1", cached: false },
      { value: "open-1", cached: false },
    ]);
    t = 1500;
    assert.deepEqual(await cache.get("open"), { value: "open-1", cached: true });
    assert.equal(calls, 2);
    gate!();
  });

  // ---- 2. Role title on closed jobs ----
  it("closed link that redirects to a board: never the board's title; 'Original posting no longer available'", async () => {
    const page = await (await post({ url: u("/jobs/search?gh_jid=9000") }, { cookie: visitor(3) })).text();
    assert.equal(verdictOf(page), "Closed");
    assert.equal(titleOf(page), NO_LONGER_AVAILABLE);
    assert.equal(page.includes("Open Roles"), false);
    assert.equal(page.includes("Acme Careers"), false);
  });

  it("closed link with the role known from the platform API shows 'Role · Company'", async () => {
    setFreeJobRoleLookupForTests(async () => ({ title: "Program Manager", company: "Stripe", platform: "Greenhouse" }));
    const page = await (await post({ url: u("/jobs/search?gh_jid=9000") }, { cookie: visitor(4) })).text();
    assert.equal(verdictOf(page), "Closed");
    assert.equal(titleOf(page), "Program Manager · Stripe");
    assert.match(page, /class="platform">Greenhouse</);
    assert.equal(page.includes("Open Roles"), false);
  });

  it("a 404 page's title is not a role either", async () => {
    const page = await (await post({ url: u("/gone") }, { cookie: visitor(5) })).text();
    assert.equal(verdictOf(page), "Closed");
    assert.equal(titleOf(page), NO_LONGER_AVAILABLE);
    assert.equal(page.includes("Page not found</p>"), false);
  });

  it("roleLine rules", () => {
    const base = { canonical_url: "https://acme.com/jobs/1", http_status: 200 };
    assert.deepEqual(roleLine("https://acme.com/jobs/1", { ...base, status: "closed", title: "Engineer (closed)", signals: ["close_language:no longer accepting"] }, undefined), {
      text: "Engineer (closed)",
      unavailable: false,
    });
    assert.deepEqual(
      roleLine("https://acme.com/jobs/1", { ...base, canonical_url: "https://acme.com/careers", status: "closed", title: "Acme Careers", signals: ["redirected_to_board"] }, undefined),
      { text: NO_LONGER_AVAILABLE, unavailable: true },
    );
    assert.deepEqual(
      roleLine("https://acme.com/jobs/1", { ...base, status: "unknown", title: "Acme Careers", signals: ["redirected_away_from_job"] }, undefined),
      { unavailable: false },
    );
    assert.deepEqual(
      roleLine("https://acme.com/jobs/1", { ...base, status: "closed", title: "Acme Careers", signals: ["redirected_to_board"] }, { title: "Program Manager", company: "Stripe" }),
      { text: "Program Manager · Stripe", unavailable: false },
    );
  });

  it("role lookup: gh_jid on a company domain asks Greenhouse's board API; only a listed job counts", async () => {
    assert.equal(boardTokenFromHost("stripe.com"), "stripe");
    assert.equal(boardTokenFromHost("careers.acme.co.uk"), "acme");
    assert.equal(boardTokenFromHost("localhost"), undefined);
    assert.equal(roleRefFor("https://stripe.com/jobs/search?gh_jid=7569678")?.apiUrl, "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/7569678");
    assert.equal(roleRefFor("https://stripe.com/jobs/search?gh_jid=abc"), null);
    const seen: string[] = [];
    const stub = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.endsWith("/jobs/111")) {
        return new Response(JSON.stringify({ id: 111, title: "Program Manager", company_name: "Stripe", absolute_url: "https://stripe.com/jobs/search?gh_jid=111" }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 });
    }) as typeof fetch;
    assert.deepEqual(await lookupRole("https://stripe.com/jobs/search?gh_jid=111", stub), { title: "Program Manager", company: "Stripe", platform: "Greenhouse" });
    assert.equal(await lookupRole("https://stripe.com/jobs/search?gh_jid=222", stub), undefined);
    assert.deepEqual(seen, ["https://boards-api.greenhouse.io/v1/boards/stripe/jobs/111", "https://boards-api.greenhouse.io/v1/boards/stripe/jobs/222"]);
    assert.equal(await lookupRole("https://careers.acme.test/jobs/1", stub), undefined, "no ATS reference, no lookup");
    assert.equal(seen.length, 2);
  });

  // ---- 3. Share previews ----
  for (const ua of [
    "LinkedInBot/1.0 (compatible; Mozilla/5.0; Apache-HttpClient +http://www.linkedin.com)",
    "Twitterbot/1.0",
  ]) {
    it(`share tags for ${ua.split("/")[0]}: og + twitter, absolute https URLs`, async () => {
      const res = await app.request("/job", { headers: { "user-agent": ua, host: "livecheck.fly.dev" } });
      assert.equal(res.status, 200);
      const page = await res.text();
      const meta = (attr: string, key: string) => page.match(new RegExp(`<meta ${attr}="${key}" content="([^"]*)"`))?.[1];
      assert.equal(meta("property", "og:title"), "Is this job still open?");
      assert.equal(meta("property", "og:description"), OG_DESCRIPTION.replace(/'/g, "&#39;"));
      assert.equal(meta("property", "og:url"), "https://livecheck.fly.dev/job");
      assert.equal(meta("property", "og:image"), "https://livecheck.fly.dev/job/og.png");
      assert.equal(meta("property", "og:image:width"), "1200");
      assert.equal(meta("property", "og:image:height"), "630");
      assert.equal(meta("name", "twitter:card"), "summary_large_image");
      assert.equal(meta("name", "twitter:title"), "Is this job still open?");
      assert.equal(meta("name", "twitter:description"), OG_DESCRIPTION.replace(/'/g, "&#39;"));
      assert.equal(meta("name", "twitter:image"), "https://livecheck.fly.dev/job/og.png");
    });
  }

  it("og description is the launch-kit description (≤ 260 chars)", () => {
    assert.equal(
      OG_DESCRIPTION,
      "Paste a job link and Livecheck tells you if it's still open, closed, or can't tell, read from the posting and the hiring platform right now. Free for people. Building an AI agent? Same check by API for $0.01, no account or API key.",
    );
    assert.ok(OG_DESCRIPTION.length <= 260);
  });

  it("GET /job/og.png: 1200×630 PNG, image/png, cacheable", async () => {
    const res = await app.request("/job/og.png");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
    assert.match(res.headers.get("cache-control") ?? "", /public, max-age=\d+/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(buf.toString("ascii", 12, 16), "IHDR");
    assert.equal(buf.readUInt32BE(16), 1200);
    assert.equal(buf.readUInt32BE(20), 630);
    assert.ok(buf.length < 1_000_000, "small enough for every crawler");
  });

  // ---- 4. Header / footer ----
  it("header links home; footer has how-it-works line, Docs, Agent skill, Contact", async () => {
    const page = await (await app.request("/job")).text();
    assert.match(page, /<header class="site"><div class="wrap"><a class="brand" href="\/">Livecheck<\/a><\/div><\/header>/);
    assert.ok(page.includes(HOW_IT_WORKS.replace(/'/g, "&#39;")));
    assert.equal(HOW_IT_WORKS, "We read the posting and the hiring platform's own data at the moment you ask.");
    const footer = page.slice(page.indexOf('<footer class="site">'));
    assert.match(footer, /<a href="\/job\/go\/docs">Docs<\/a>/);
    assert.match(footer, /<a href="\/job\/go\/skill">Agent skill<\/a>/);
    assert.match(footer, new RegExp(`<a href="mailto:${CONTACT_EMAIL}">Contact</a>`));
    assert.equal((await app.request("/job/go/docs")).headers.get("location"), "/llms.txt");
  });

  // ---- 5. Mobile ----
  it("mobile: viewport meta, ≥16px text and inputs, stacked form under 480px, no horizontal overflow rules", async () => {
    const page = await (await app.request("/job")).text();
    assert.match(page, /<meta name="viewport" content="width=device-width, initial-scale=1" \/>/);
    assert.match(page, /body \{[^}]*font-size:17px/);
    const phone = page.slice(page.indexOf("@media (max-width: 480px)"));
    assert.match(phone, /form\.check \{ flex-direction:column; \}/);
    assert.match(phone, /input\[type=url\], form\.check button \{ width:100%; flex:none; font-size:17px; \}/);
    assert.match(page, /overflow-wrap:anywhere/);
    assert.match(page, /input\[type=url\] \{[^}]*min-width:0/);
  });

  // ---- Store migration for the new metrics ----
  it("free_page_daily created by v87 (older metric list) is migrated, counts kept", () => {
    closeFreePageStore();
    const dir = mkdtempSync(join(tmpdir(), "lc-free-mig-"));
    try {
      const path = join(dir, "free-page.sqlite");
      const old = new DatabaseSync(path);
      old.exec(`CREATE TABLE free_page_daily (day TEXT NOT NULL CHECK (length(day) = 10), metric TEXT NOT NULL CHECK (metric IN ('views', 'checks')), n INTEGER NOT NULL DEFAULT 0 CHECK (n >= 0), PRIMARY KEY (day, metric));`);
      old.exec("INSERT INTO free_page_daily VALUES ('2026-10-08', 'views', 7), ('2026-10-08', 'checks', 3)");
      old.close();
      assert.equal(initFreePageStore(path).ok, true);
      const db = freePageDbForTests();
      db.prepare("INSERT INTO free_page_daily (day, metric, n) VALUES ('2026-10-08', 'example_open', 1)").run();
      const rows = db.prepare("SELECT metric, n FROM free_page_daily ORDER BY metric").all() as Array<{ metric: string; n: number }>;
      assert.deepEqual(rows.map((r) => [r.metric, Number(r.n)]), [["checks", 3], ["example_open", 1], ["views", 7]]);
      closeFreePageStore();
      assert.equal(initFreePageStore(path).ok, true, "second open is a no-op");
    } finally {
      closeFreePageStore();
      rmSync(dir, { recursive: true, force: true });
      initFreePageStore(":memory:");
    }
  });
});
