import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { classify } from "../src/classify.js";
import { CHECK_TIMEOUT_SIGNAL, USER_AGENT } from "../src/config.js";
import { guardedFetch, isBlockedAddress, type FetchPolicy } from "../src/free-job-guard.js";
import { cantTellCopy } from "../src/free-job-page.js";
import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_DISALLOWED_MESSAGE,
  ROBOTS_DISALLOWED_SIGNAL,
  ROBOTS_FETCH_TIMEOUT_MS,
  ROBOTS_MAX_REDIRECTS,
  ROBOTS_STRICT_FETCH_TIMEOUT_MS,
  ROBOTS_UNAVAILABLE_MESSAGE,
  ROBOTS_UNAVAILABLE_SIGNAL,
  clearRobotsCacheForTests,
  isPublicAtsApiUrl,
  parseAuditRunnerArgs,
  parseRobots,
  robotsAllows,
  robotsAllowsGroups,
  robotsCacheSizeForTests,
  robotsProductToken,
  setRobotsClockForTests,
  setRobotsStrictTimeoutForTests,
} from "../src/robots.js";
import { verifyUrl } from "../src/verify.js";

afterEach(() => {
  clearRobotsCacheForTests();
  setRobotsClockForTests(null);
  setRobotsStrictTimeoutForTests(null);
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

  it("checks the page for 401, 403, 404, and 410 in both modes", async () => {
    const page = "<html><title>Engineer</title><body><a>Apply now</a></body></html>";
    for (const mode of ["lenient", "strict"] as const) {
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
        const origin = `https://${mode}-${status}.example`;
        const first = await verifyUrl(`${origin}/jobs/1`, fetcher, new Date(), { robotsMode: mode });
        const second = await verifyUrl(`${origin}/jobs/2`, fetcher, new Date(), { robotsMode: mode });
        assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false, `${mode} ${status}`);
        assert.equal(first.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false, `${mode} ${status}`);
        assert.equal(second.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false, `${mode} ${status}`);
        assert.ok(seen.includes(`${origin}/jobs/1`), `${mode} ${status} fetches the page`);
        assert.ok(seen.includes(`${origin}/jobs/2`), `${mode} ${status} fetches the page`);
        assert.equal(robotsFetches, 1, `${mode} ${status} is cached as allow`);
        assert.equal(robotsCacheSizeForTests(), 1);
      }
    }
  });

  it("429, 500, and 503 are checked in lenient and skipped in strict", async () => {
    const page = "<html><title>Engineer</title><body><a>Apply now</a></body></html>";
    for (const status of [429, 500, 503]) {
      for (const mode of ["lenient", "strict"] as const) {
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
        const origin = `https://${mode}-unreachable-${status}.example`;
        const first = await verifyUrl(`${origin}/jobs/1`, fetcher, new Date(), { robotsMode: mode });
        const second = await verifyUrl(`${origin}/jobs/2`, fetcher, new Date(), { robotsMode: mode });
        assert.equal(robotsFetches, 2, `${mode} ${status} is not cached`);
        assert.equal(robotsCacheSizeForTests(), 0);
        if (mode === "strict") {
          assert.equal(first.status, "unknown");
          assert.equal(first.message, ROBOTS_UNAVAILABLE_MESSAGE);
          assert.deepEqual(first.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
          assert.deepEqual(second.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
          assert.equal(seen.includes(`${origin}/jobs/1`), false, `${mode} ${status} skips the page`);
          assert.equal(seen.includes(`${origin}/jobs/2`), false);
        } else {
          assert.equal(first.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
          assert.equal(second.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
          assert.ok(seen.includes(`${origin}/jobs/1`), `${mode} ${status} fetches the page`);
          assert.ok(seen.includes(`${origin}/jobs/2`));
        }
      }
    }
  });

  it("a robots.txt timeout matches a 5xx in each mode", { timeout: 3_000 }, async () => {
    setRobotsStrictTimeoutForTests(40);
    const strictSeen: string[] = [];
    const strictStarted = Date.now();
    const strictFetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      strictSeen.push(url);
      if (url.endsWith("/robots.txt")) return hangUntilAbort(init);
      return Promise.resolve(new Response(PAGE_HTML, { status: 200 }));
    };
    const strictVerdict = await verifyUrl("https://timeout-strict.example/jobs/1", strictFetcher, new Date(), {
      robotsMode: "strict",
    });
    assert.ok(Date.now() - strictStarted < 1_000);
    assert.equal(strictVerdict.status, "unknown");
    assert.equal(strictVerdict.message, ROBOTS_UNAVAILABLE_MESSAGE);
    assert.deepEqual(strictVerdict.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
    assert.equal(strictSeen.includes("https://timeout-strict.example/jobs/1"), false);
    assert.equal(robotsCacheSizeForTests(), 0);

    setRobotsStrictTimeoutForTests(null);
    clearRobotsCacheForTests();
    const seen: string[] = [];
    const started = Date.now();
    const fetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return hangUntilAbort(init);
      return Promise.resolve(new Response(PAGE_HTML, { status: 200 }));
    };
    const verdict = await verifyUrl("https://timeout-lenient.example/jobs/1", fetcher, new Date(), { robotsMode: "lenient" });
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= ROBOTS_FETCH_TIMEOUT_MS - 100, `waited ${elapsed}ms`);
    assert.ok(elapsed < 2_000, `waited ${elapsed}ms`);
    assert.equal(verdict.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
    assert.ok(seen.includes("https://timeout-lenient.example/jobs/1"));
    assert.equal(robotsCacheSizeForTests(), 0);
  });

  it("a robots.txt DNS failure matches a 5xx in each mode", async () => {
    for (const mode of ["lenient", "strict"] as const) {
      clearRobotsCacheForTests();
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
      const origin = `https://${mode}-dns.example`;
      const first = await verifyUrl(`${origin}/jobs/1`, fetcher, new Date(), { robotsMode: mode });
      const second = await verifyUrl(`${origin}/jobs/2`, fetcher, new Date(), { robotsMode: mode });
      assert.equal(robotsFetches, 2, `${mode} DNS failure is not cached`);
      assert.equal(robotsCacheSizeForTests(), 0);
      if (mode === "strict") {
        assert.equal(first.status, "unknown");
        assert.equal(first.message, ROBOTS_UNAVAILABLE_MESSAGE);
        assert.deepEqual(first.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
        assert.deepEqual(second.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
        assert.equal(seen.includes(`${origin}/jobs/1`), false);
        assert.equal(seen.includes(`${origin}/jobs/2`), false);
      } else {
        assert.equal(first.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
        assert.equal(second.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
        assert.ok(seen.includes(`${origin}/jobs/1`));
        assert.ok(seen.includes(`${origin}/jobs/2`));
      }
    }
  });

  it("follows five robots.txt redirects and applies the final file in both modes", async () => {
    for (const mode of ["lenient", "strict"] as const) {
      clearRobotsCacheForTests();
      const seen: string[] = [];
      const host = `${mode}-five.example`;
      const fetcher: typeof fetch = async (input) => {
        const url = requestUrl(input);
        seen.push(url);
        const hop = seen.length;
        if (hop <= ROBOTS_MAX_REDIRECTS) {
          return new Response(null, {
            status: 302,
            headers: { location: `https://cdn.example/${mode}/robots/${hop}` },
          });
        }
        return new Response("User-agent: *\nDisallow: /jobs\n", { status: 200 });
      };
      const verdict = await verifyUrl(`https://${host}/jobs/9`, fetcher, new Date(), { robotsMode: mode });
      assert.equal(verdict.status, "unknown");
      assert.equal(verdict.message, ROBOTS_DISALLOWED_MESSAGE);
      assert.deepEqual(verdict.signals, [ROBOTS_DISALLOWED_SIGNAL]);
      assert.equal(seen.includes(`https://${host}/jobs/9`), false);
      assert.deepEqual(seen, [
        `https://${host}/robots.txt`,
        `https://cdn.example/${mode}/robots/1`,
        `https://cdn.example/${mode}/robots/2`,
        `https://cdn.example/${mode}/robots/3`,
        `https://cdn.example/${mode}/robots/4`,
        `https://cdn.example/${mode}/robots/5`,
      ]);
    }
  });

  it("treats a sixth robots.txt redirect as no file in both modes", async () => {
    for (const mode of ["lenient", "strict"] as const) {
      clearRobotsCacheForTests();
      const seen: string[] = [];
      const host = `${mode}-six.example`;
      const page = `https://${host}/jobs/9`;
      const fetcher: typeof fetch = async (input) => {
        const url = requestUrl(input);
        seen.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: `https://cdn.example/${mode}/robots/${seen.length}` },
        });
      };
      const first = await verifyUrl(page, fetcher, new Date(), { robotsMode: mode });
      const duringRobots = seen.filter((url) => url !== page);
      assert.equal(first.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
      assert.equal(first.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
      // Six redirects means no robots.txt: allowed, so the page is checked.
      assert.ok(seen.includes(page), `${mode} checks the page`);
      assert.equal(seen.includes(`https://cdn.example/${mode}/robots/6`), false, `${mode} does not fetch the 6th redirect`);
      assert.deepEqual(duringRobots, [
        `https://${host}/robots.txt`,
        `https://cdn.example/${mode}/robots/1`,
        `https://cdn.example/${mode}/robots/2`,
        `https://cdn.example/${mode}/robots/3`,
        `https://cdn.example/${mode}/robots/4`,
        `https://cdn.example/${mode}/robots/5`,
      ]);
      seen.length = 0;
      const second = await verifyUrl(`https://${host}/about`, fetcher, new Date(), { robotsMode: mode });
      assert.equal(second.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
      assert.deepEqual(seen, [`https://${host}/about`]);
      assert.equal(robotsCacheSizeForTests(), 1);
    }
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
      for (const mode of ["lenient", "strict"] as const) {
        clearRobotsCacheForTests();
        hits.length = 0;
        resolved.length = 0;
        const verdict = await verifyUrl(`http://public.test:${port}/jobs/1`, guardedFetch(policy), new Date(), {
          robotsMode: mode,
        });
        assert.ok(resolved.includes("meta.test"), `${mode} vets the redirect target`);
        assert.equal(hits.includes("/secret"), false, `${mode} does not connect to the private address`);
        assert.equal(robotsCacheSizeForTests(), 0);
        if (mode === "strict") {
          assert.equal(verdict.status, "unknown");
          assert.equal(verdict.message, ROBOTS_UNAVAILABLE_MESSAGE);
          assert.deepEqual(verdict.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
          assert.deepEqual(hits, ["/robots.txt"]);
        } else {
          assert.equal(verdict.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
          assert.deepEqual(hits, ["/robots.txt", "/jobs/1"]);
        }
      }
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

const APPLY_PAGE = "<html><title>Engineer</title><body><a>Apply now</a></body></html>";
const GREENHOUSE = "https://job-boards.greenhouse.io/discord/jobs/8806482002";

describe("strict robots.txt", () => {
  it("uses a 5s strict wait and the existing 500ms lenient wait", () => {
    assert.equal(ROBOTS_STRICT_FETCH_TIMEOUT_MS, 5_000);
    assert.equal(ROBOTS_FETCH_TIMEOUT_MS, 500);
  });

  it("strict and a slow robots.txt is unknown, with no page fetch and no ATS lookup", { timeout: 2_000 }, async () => {
    setRobotsStrictTimeoutForTests(40);
    const seen: string[] = [];
    const fetcher: typeof fetch = (input, init) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return hangUntilAbort(init);
      return Promise.resolve(new Response(APPLY_PAGE, { status: 200 }));
    };
    const started = Date.now();
    const verdict = await verifyUrl(GREENHOUSE, fetcher, new Date(), { robotsMode: "strict", atsApi: true });
    assert.ok(Date.now() - started < 1_000);
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.message, ROBOTS_UNAVAILABLE_MESSAGE);
    assert.deepEqual(verdict.signals, [ROBOTS_UNAVAILABLE_SIGNAL]);
    assert.equal(verdict.http_status, 0);
    assert.deepEqual(seen, [`${new URL(GREENHOUSE).origin}/robots.txt`]);
    assert.equal(robotsCacheSizeForTests(), 0);
    assert.equal(cantTellCopy(verdict.signals), ROBOTS_UNAVAILABLE_MESSAGE);

    seen.length = 0;
    const fetcherAfter: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const again = await verifyUrl(GREENHOUSE, fetcherAfter, new Date(), { robotsMode: "strict", atsApi: true });
    assert.equal(again.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
    assert.ok(seen.some((url) => url.endsWith("/robots.txt")), "a strict failure is not cached as allow");
    assert.ok(seen.includes(GREENHOUSE));
  });

  it("a short check deadline still wins over the strict robots wait", { timeout: 2_000 }, async () => {
    const started = Date.now();
    const verdict = await verifyUrl("https://slow-deadline.example/jobs/1", (_input, init) => hangUntilAbort(init), new Date(), {
      robotsMode: "strict",
      deadlineMs: 50,
    });
    assert.ok(Date.now() - started < 1_000);
    assert.ok(verdict.signals.includes(CHECK_TIMEOUT_SIGNAL));
    assert.equal(verdict.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
  });

  it("strict and a disallow skips the page and the ATS lookup", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /\n", { status: 200 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const verdict = await verifyUrl(GREENHOUSE, fetcher, new Date(), { robotsMode: "strict", atsApi: true });
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.deepEqual(verdict.signals, [ROBOTS_DISALLOWED_SIGNAL]);
    assert.equal(seen.some((url) => url.includes("boards-api.greenhouse.io")), false);
    assert.equal(seen.includes(GREENHOUSE), false);
  });

  it("POST /v1/verify ignores a caller robotsMode and stays lenient", async () => {
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("down", { status: 503 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    try {
      const app = createApp();
      const response = await app.request("/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({ url: "https://paid-lenient.example/jobs/1", robotsMode: "strict" }),
      });
      assert.equal(response.status, 200);
      const body = (await response.json()) as { signals?: string[]; status?: string };
      assert.equal(body.signals?.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
      assert.ok(seen.includes("https://paid-lenient.example/jobs/1"));
    } finally {
      globalThis.fetch = original;
    }
  });

  it("the audit runner defaults to strict, and the flag overrides the env var", () => {
    assert.equal(parseAuditRunnerArgs([], undefined).robotsMode, "strict");
    assert.equal(parseAuditRunnerArgs([], "").robotsMode, "strict");
    assert.equal(parseAuditRunnerArgs([], "lenient").robotsMode, "lenient");
    assert.deepEqual(parseAuditRunnerArgs(["bench/plate.json"], "strict"), {
      robotsMode: "strict",
      platePath: "bench/plate.json",
    });
    assert.equal(parseAuditRunnerArgs(["--robots-mode", "lenient", "bench/plate.json"], "strict").robotsMode, "lenient");
    assert.equal(parseAuditRunnerArgs(["--robots-mode=strict", "bench/plate.json"], "lenient").robotsMode, "strict");
    assert.throws(() => parseAuditRunnerArgs([], "open"), /LIVECHECK_ROBOTS_MODE/);
    assert.throws(() => parseAuditRunnerArgs(["--robots-mode", "maybe"], undefined), /--robots-mode/);
  });
});
