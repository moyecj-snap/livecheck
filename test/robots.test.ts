import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { classify } from "../src/classify.js";
import { USER_AGENT } from "../src/config.js";
import { cantTellCopy } from "../src/free-job-page.js";
import {
  ROBOTS_CACHE_TTL_MS,
  ROBOTS_DISALLOWED_MESSAGE,
  ROBOTS_DISALLOWED_SIGNAL,
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
