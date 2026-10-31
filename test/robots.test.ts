import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { classify } from "../src/classify.js";
import { CHECK_TIMEOUT_SIGNAL, USER_AGENT } from "../src/config.js";
import { cantTellCopy } from "../src/free-job-page.js";
import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_DISALLOWED_MESSAGE,
  ROBOTS_DISALLOWED_SIGNAL,
  ROBOTS_FETCH_TIMEOUT_MS,
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
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

  it("caches a 404 as allow and a 403 as disallow-all", async () => {
    let calls = 0;
    const missing: typeof fetch = async () => {
      calls += 1;
      return new Response("missing", { status: 404 });
    };
    assert.equal((await robotsAllows("https://none.example/jobs/1", missing)).allowed, true);
    assert.equal((await robotsAllows("https://none.example/jobs/2", missing)).allowed, true);
    assert.equal(calls, 1);

    clearRobotsCacheForTests();
    const forbidden: typeof fetch = async () => new Response("no", { status: 403 });
    const blocked = await robotsAllows("https://private.example/jobs/1", forbidden);
    assert.equal(blocked.allowed, false);
    if (!blocked.allowed) assert.equal(blocked.message, ROBOTS_DISALLOWED_MESSAGE);
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

  it("strict and HTTP 503 skips the page and is not cached", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("down", { status: 503 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const verdict = await verifyUrl("https://down.example/jobs/1", fetcher, new Date(), { robotsMode: "strict" });
    assert.equal(verdict.message, ROBOTS_UNAVAILABLE_MESSAGE);
    assert.deepEqual(seen, ["https://down.example/robots.txt"]);
    assert.equal(robotsCacheSizeForTests(), 0);
    await verifyUrl("https://down.example/jobs/1", fetcher, new Date(), { robotsMode: "strict" });
    assert.equal(seen.filter((url) => url.endsWith("/robots.txt")).length, 2);
  });

  it("strict and 404 checks the page, and strict 410 checks the page and caches the allow", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("missing", { status: 404 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const missing = await verifyUrl("https://none.example/jobs/1", fetcher, new Date(), { robotsMode: "strict" });
    assert.equal(missing.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
    assert.equal(missing.signals.includes(ROBOTS_DISALLOWED_SIGNAL), false);
    assert.ok(seen.includes("https://none.example/jobs/1"));

    seen.length = 0;
    clearRobotsCacheForTests();
    const goneFetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("gone", { status: 410 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    await verifyUrl("https://gone.example/jobs/1", goneFetcher, new Date(), { robotsMode: "strict" });
    await verifyUrl("https://gone.example/jobs/2", goneFetcher, new Date(), { robotsMode: "strict" });
    assert.deepEqual(seen.filter((url) => url.endsWith("/robots.txt")), ["https://gone.example/robots.txt"]);
    assert.ok(seen.includes("https://gone.example/jobs/1"));
    assert.ok(seen.includes("https://gone.example/jobs/2"));
  });

  it("lenient still checks the page on 410 and does not cache that response", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("gone", { status: 410 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    await verifyUrl("https://lenient-gone.example/jobs/1", fetcher, new Date(), { robotsMode: "lenient" });
    await verifyUrl("https://lenient-gone.example/jobs/2", fetcher, new Date());
    assert.equal(seen.filter((url) => url.endsWith("/robots.txt")).length, 2);
    assert.ok(seen.includes("https://lenient-gone.example/jobs/1"));
    assert.ok(seen.includes("https://lenient-gone.example/jobs/2"));
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

  it("strict treats HTTP 403 as disallow-all and caches it", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("no", { status: 403 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const first = await verifyUrl("https://private.example/jobs/1", fetcher, new Date(), { robotsMode: "strict" });
    const second = await verifyUrl("https://private.example/jobs/2", fetcher, new Date(), { robotsMode: "strict" });
    assert.equal(first.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.equal(second.message, ROBOTS_DISALLOWED_MESSAGE);
    assert.deepEqual(seen, ["https://private.example/robots.txt"]);
    assert.equal(robotsCacheSizeForTests(), 1);
  });

  it("lenient still fetches the page when robots.txt returns 503", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith("/robots.txt")) return new Response("down", { status: 503 });
      return new Response(APPLY_PAGE, { status: 200 });
    };
    const explicit = await verifyUrl("https://lenient-down.example/jobs/1", fetcher, new Date(), { robotsMode: "lenient" });
    const implicit = await verifyUrl("https://lenient-down.example/jobs/2", fetcher, new Date());
    assert.equal(explicit.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
    assert.equal(implicit.signals.includes(ROBOTS_UNAVAILABLE_SIGNAL), false);
    assert.ok(seen.includes("https://lenient-down.example/jobs/1"));
    assert.ok(seen.includes("https://lenient-down.example/jobs/2"));
    assert.equal(robotsCacheSizeForTests(), 0);
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
