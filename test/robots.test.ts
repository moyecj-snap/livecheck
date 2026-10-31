import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { classify } from "../src/classify.js";
import { guardedFetch, isBlockedAddress, type FetchPolicy } from "../src/free-job-guard.js";
import { USER_AGENT } from "../src/config.js";
import { cantTellCopy } from "../src/free-job-page.js";
import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_DISALLOWED_MESSAGE,
  ROBOTS_DISALLOWED_SIGNAL,
  ROBOTS_FETCH_TIMEOUT_MS,
  ROBOTS_MAX_REDIRECTS,
  clearRobotsCacheForTests,
  isPublicAtsApiUrl,
  parseRobots,
  robotsAllows,
  robotsAllowsGroups,
  robotsCacheSizeForTests,
  robotsProductToken,
  setRobotsClockForTests,
} from "../src/robots.js";
import { verifyUrl } from "../src/verify.js";

afterEach(() => {
  clearRobotsCacheForTests();
  setRobotsClockForTests(null);
});

const PAGE_HTML = "<html><title>Engineer</title><body><a>Apply now</a></body></html>";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function hangUntilAbort(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    if (init?.signal?.aborted) {
      fail();
      return;
    }
    init?.signal?.addEventListener("abort", fail, { once: true });
  });
}

describe("robots.txt parser", () => {
  const page = new URL("https://jobs.example/jobs/42");

  it("matches the Livecheck product token and the longest rule, with Allow winning a tie", () => {
    assert.equal(robotsProductToken(USER_AGENT), "livecheck");
    const groups = parseRobots(`
User-agent: *
Disallow: /secret

User-agent: Livecheck
Disallow: /jobs
Allow: /jobs/42
`);
    assert.equal(robotsAllowsGroups(groups, page), true);
    assert.equal(robotsAllowsGroups(groups, new URL("https://jobs.example/jobs/7")), false);
    assert.equal(robotsAllowsGroups(groups, new URL("https://jobs.example/secret")), true);
    const tie = parseRobots("User-agent: *\nDisallow: /jobs\nAllow: /jobs\n");
    assert.equal(robotsAllowsGroups(tie, page), true);
  });

  it("uses the star group when Livecheck has no group of its own", () => {
    const groups = parseRobots("User-agent: *\nDisallow: /\n");
    assert.equal(robotsAllowsGroups(groups, page), false);
    const other = parseRobots("User-agent: Otherbot\nDisallow: /\nUser-agent: *\nAllow: /\n");
    assert.equal(robotsAllowsGroups(other, page), true);
  });

  it("treats an empty Disallow as allow, and anchors with $", () => {
    const empty = parseRobots("User-agent: *\nDisallow:\n");
    assert.equal(robotsAllowsGroups(empty, page), true);
    const anchored = parseRobots("User-agent: *\nDisallow: /jobs$\nAllow: /jobs/\n");
    assert.equal(robotsAllowsGroups(anchored, new URL("https://jobs.example/jobs")), false);
    assert.equal(robotsAllowsGroups(anchored, page), true);
  });
});

describe("robots.txt fetch policy", () => {
  it("does not apply to documented public ATS JSON APIs", () => {
    assert.equal(isPublicAtsApiUrl("https://api.lever.co/v0/postings/acme/16a1b500-13fe-4c22-ad89-372093b462da"), true);
    assert.equal(isPublicAtsApiUrl("https://api.ashbyhq.com/posting-api/job-board/linear"), true);
    assert.equal(isPublicAtsApiUrl("https://boards-api.greenhouse.io/v1/boards/discord/jobs/1"), true);
    assert.equal(
      isPublicAtsApiUrl("https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external/job/Role_R1"),
      true,
    );
    assert.equal(isPublicAtsApiUrl("https://jobs.lever.co/acme/16a1b500-13fe-4c22-ad89-372093b462da"), false);
  });

  it("caches an allow for an hour and fails open without caching when robots.txt is unreachable", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      const url = requestUrl(input);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /private\n", { status: 200 });
      }
      return new Response("page", { status: 200 });
    };
    const first = await robotsAllows("https://jobs.example/jobs/42", fetcher);
    const second = await robotsAllows("https://jobs.example/other", fetcher);
    assert.equal(first.allowed, true);
    assert.equal(second.allowed, true);
    assert.equal(calls, 1);
    assert.equal(robotsCacheSizeForTests(), 1);

    let now = 0;
    setRobotsClockForTests(() => now);
    clearRobotsCacheForTests();
    calls = 0;
    await robotsAllows("https://jobs.example/jobs/42", fetcher);
    now = ROBOTS_CACHE_TTL_MS + 1;
    await robotsAllows("https://jobs.example/jobs/42", fetcher);
    assert.equal(calls, 2);

    clearRobotsCacheForTests();
    let failures = 0;
    const down: typeof fetch = async () => {
      failures += 1;
      return new Response("nope", { status: 503 });
    };
    assert.equal((await robotsAllows("https://down.example/jobs/1", down)).allowed, true);
    assert.equal((await robotsAllows("https://down.example/jobs/1", down)).allowed, true);
    assert.equal(failures, 2, "an unreachable robots.txt is not cached");
    assert.equal(robotsCacheSizeForTests(), 0);
  });

  it("checks the page for 401, 403, 404, and 410, and still checks it for 429, 500, and 503", async () => {
    const page = "<html><title>Engineer</title><body><a>Apply now</a></body></html>";
    for (const status of [401, 403, 404, 410]) {
      clearRobotsCacheForTests();
      const seen: string[] = [];
      let robotsFetches = 0;
      const fetcher: typeof fetch = async (input) => {
        const url = requestUrl(input);
        seen.push(url);
        if (url.endsWith("/robots.txt")) {
          robotsFetches += 1;
          return new Response("nope", { status });
        }
        return new Response(page, { status: 200 });
      };
      const origin = `https://absent-${status}.example`;
      const first = await verifyUrl(`${origin}/jobs/1`, fetcher);
      const second = await verifyUrl(`${origin}/jobs/2`, fetcher);
      assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false, String(status));
      assert.equal(second.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false, String(status));
      assert.ok(seen.includes(`${origin}/jobs/1`), `${status} still fetches the page`);
      assert.ok(seen.includes(`${origin}/jobs/2`), `${status} still fetches the page`);
      assert.equal(robotsFetches, 1, `${status} is cached as allow`);
      assert.equal(robotsCacheSizeForTests(), 1);
    }

    for (const status of [429, 500, 503]) {
      clearRobotsCacheForTests();
      const seen: string[] = [];
      let robotsFetches = 0;
      const fetcher: typeof fetch = async (input) => {
        const url = requestUrl(input);
        seen.push(url);
        if (url.endsWith("/robots.txt")) {
          robotsFetches += 1;
          return new Response("nope", { status });
        }
        return new Response(page, { status: 200 });
      };
      const origin = `https://unreachable-${status}.example`;
      const first = await verifyUrl(`${origin}/jobs/1`, fetcher);
      const second = await verifyUrl(`${origin}/jobs/2`, fetcher);
      assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false, String(status));
      assert.ok(seen.includes(`${origin}/jobs/1`), `${status} still fetches the page`);
      assert.ok(seen.includes(`${origin}/jobs/2`), `${status} still fetches the page`);
      assert.equal(robotsFetches, 2, `${status} is not cached`);
      assert.equal(robotsCacheSizeForTests(), 0);
    }
  });

  it("a robots.txt timeout is unreachable and the page is still checked", { timeout: 3_000 }, async () => {
    const seen: string[] = [];
    const started = Date.now();
    const fetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return hangUntilAbort(init);
      return Promise.resolve(new Response(PAGE_HTML, { status: 200 }));
    };
    const verdict = await verifyUrl("https://timeout.example/jobs/1", fetcher);
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= ROBOTS_FETCH_TIMEOUT_MS - 100, `waited ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `waited ${elapsed}ms`);
    assert.equal(verdict.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.ok(seen.includes("https://timeout.example/jobs/1"));
    assert.equal(robotsCacheSizeForTests(), 0);
  });

  it("a robots.txt DNS failure is unreachable and the page is still checked", async () => {
    const seen: string[] = [];
    let robotsFetches = 0;
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) {
        robotsFetches += 1;
        throw Object.assign(new Error("getaddrinfo ENOTFOUND dns.example"), { code: "ENOTFOUND" });
      }
      return new Response(PAGE_HTML, { status: 200 });
    };
    const first = await verifyUrl("https://dns.example/jobs/1", fetcher);
    const second = await verifyUrl("https://dns.example/jobs/2", fetcher);
    assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.equal(second.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.ok(seen.includes("https://dns.example/jobs/1"));
    assert.ok(seen.includes("https://dns.example/jobs/2"));
    assert.equal(robotsFetches, 2, "a DNS failure is not cached");
    assert.equal(robotsCacheSizeForTests(), 0);
  });

  it("follows five robots.txt redirects and applies the final file to the original URL", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      const hop = seen.length;
      if (hop <= ROBOTS_MAX_REDIRECTS) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://cdn.example/robots/${hop}` },
        });
      }
      return new Response("User-agent: *\nDisallow: /jobs\n", { status: 200 });
    };
    const verdict = await verifyUrl("https://jobs.example/jobs/9", fetcher);
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.deepEqual(verdict.signals, [ROBOTS_DISALLOWED_SIGNAL]);
    assert.equal(seen.includes("https://jobs.example/jobs/9"), false);
    assert.deepEqual(seen, [
      "https://jobs.example/robots.txt",
      "https://cdn.example/robots/1",
      "https://cdn.example/robots/2",
      "https://cdn.example/robots/3",
      "https://cdn.example/robots/4",
      "https://cdn.example/robots/5",
    ]);
  });

  it("treats a sixth robots.txt redirect as no file, checks the page, and caches the allow", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      return new Response(null, {
        status: 302,
        headers: { location: `https://cdn.example/robots/${seen.length}` },
      });
    };
    const first = await verifyUrl("https://jobs.example/jobs/9", fetcher);
    const duringRobots = seen.filter((url) => url !== "https://jobs.example/jobs/9");
    assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.ok(seen.includes("https://jobs.example/jobs/9"));
    assert.deepEqual(duringRobots, [
      "https://jobs.example/robots.txt",
      "https://cdn.example/robots/1",
      "https://cdn.example/robots/2",
      "https://cdn.example/robots/3",
      "https://cdn.example/robots/4",
      "https://cdn.example/robots/5",
    ]);
    seen.length = 0;
    const second = await verifyUrl("https://jobs.example/about", fetcher);
    assert.equal(second.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.deepEqual(seen, ["https://jobs.example/about"]);
    assert.equal(robotsCacheSizeForTests(), 1);
  });

  it("vets every robots.txt redirect hop and does not connect to a private address", async () => {
    const hits: string[] = [];
    const server = createServer((req, res) => {
      hits.push(req.url ?? "");
      if (req.url === "/robots.txt") {
        res.writeHead(302, { location: `http://meta.test:${port}/secret` });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(PAGE_HTML);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const resolved: string[] = [];
    const policy: FetchPolicy = {
      resolver: async (host) => {
        resolved.push(host);
        if (host === "public.test") return ["127.0.0.1"];
        if (host === "meta.test") return ["169.254.169.254"];
        throw new Error(`ENOTFOUND ${host}`);
      },
      isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedAddress(ip)),
      allowedPorts: new Set(["", "80", "443", String(port)]),
      maxBodyBytes: 1024 * 1024,
      hopTimeoutMs: 2_000,
      maxRedirects: ROBOTS_MAX_REDIRECTS,
    };
    try {
      const verdict = await verifyUrl(`http://public.test:${port}/jobs/1`, guardedFetch(policy));
      assert.equal(verdict.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
      assert.deepEqual(hits, ["/robots.txt", "/jobs/1"]);
      assert.ok(resolved.includes("meta.test"));
      assert.equal(hits.includes("/secret"), false);
      assert.equal(robotsCacheSizeForTests(), 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("returns can't tell and does not fetch the page when the URL is disallowed", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) {
        return new Response("User-agent: *\nDisallow: /jobs\n", { status: 200 });
      }
      return new Response("<html><title>Engineer</title><body><a>Apply now</a></body></html>", { status: 200 });
    };
    const verdict = await verifyUrl("https://jobs.example/jobs/42", fetcher, new Date("2026-10-30T00:00:00Z"));
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.deepEqual(verdict.signals, [ROBOTS_DISALLOWED_SIGNAL]);
    assert.equal(verdict.http_status, 0);
    assert.deepEqual(seen, ["https://jobs.example/robots.txt"]);
    assert.equal(cantTellCopy(verdict.signals), ROBOTS_DISALLOWED_MESSAGE);

    const allowed = await verifyUrl("https://jobs.example/about", fetcher);
    assert.equal(allowed.status === "unknown" || allowed.status === "live", true);
    assert.ok(seen.includes("https://jobs.example/about"));
  });

  it("does not let a listed Greenhouse API override a disallowed posting page", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      return new Response(JSON.stringify({ id: 8806482002, title: "Engineer", absolute_url: "https://job-boards.greenhouse.io/discord/jobs/8806482002" }), { status: 200 });
    };
    const verdict = await verifyUrl(
      "https://job-boards.greenhouse.io/discord/jobs/8806482002",
      fetcher,
      new Date(),
      { atsApi: true },
    );
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.equal(seen.some((url) => url.includes("boards-api.greenhouse.io")), false);
  });

  it("classify of a disallowed page is unknown even with apply-form HTML", () => {
    const verdict = classify({
      requestedUrl: "https://jobs.example/jobs/42",
      canonicalUrl: "https://jobs.example/jobs/42",
      httpStatus: 0,
      title: null,
      html: "<a>Apply now</a>",
      text: "Apply now",
      redirected: false,
      redirectChain: [],
      robotsDisallowed: true,
    });
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.signals.includes("apply form present"), false);
  });
});
