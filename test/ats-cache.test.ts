import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import {
  atsCacheStats,
  atsFetchScope,
  atsResponseCacheKey,
  cacheableAtsResponse,
  clearAtsResponseCache,
  readAtsResponseCache,
  setAtsCacheClockForTests,
  setAtsCacheLimitsForTests,
  writeAtsResponseCache,
} from "../src/ats-cache.js";
import { lookupAtsJob, parseAtsJobUrl } from "../src/ats-api.js";
import { ATS_BOARD_CACHE_TTL_MS } from "../src/config.js";

const ASHBY_LIVE = "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff";
const ASHBY_OTHER = "https://jobs.ashbyhq.com/linear/deadbeef-dead-beef-dead-beefdeadbeef";
const ASHBY_ACME = "https://jobs.ashbyhq.com/acme/d3bc1ced-3ce4-4086-a050-555055dbb1ff";
const LEVER_LIVE = "https://jobs.lever.co/palantir/16a1b500-13fe-4c22-ad89-372093b462da";
const LEVER_OTHER = "https://jobs.lever.co/palantir/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const GREENHOUSE_LIVE = "https://job-boards.greenhouse.io/discord/jobs/8806482002";
const WORKDAY_LIVE =
  "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Sr-Technology-Compliance-Product-Owner_R172124";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), "utf8");
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function refOf(url: string) {
  const ref = parseAtsJobUrl(url);
  assert.ok(ref, url);
  return ref;
}

afterEach(() => {
  clearAtsResponseCache();
  setAtsCacheClockForTests(null);
  setAtsCacheLimitsForTests(null);
});

describe("ATS response cache", () => {
  it("keys a shared Ashby board once and keys single postings by posting URL", () => {
    assert.equal(atsFetchScope("ashby"), "board");
    assert.equal(atsFetchScope("lever"), "posting");
    assert.equal(atsFetchScope("greenhouse"), "posting");
    assert.equal(atsFetchScope("workday"), "posting");

    const live = refOf(ASHBY_LIVE);
    const other = refOf(ASHBY_OTHER);
    const apply = refOf(`${ASHBY_LIVE}/application`);
    assert.equal(atsResponseCacheKey(live), "board:ashby:linear");
    assert.equal(atsResponseCacheKey(live), atsResponseCacheKey(other));
    assert.equal(atsResponseCacheKey(live), atsResponseCacheKey(apply));
    assert.notEqual(atsResponseCacheKey(live), atsResponseCacheKey(refOf(ASHBY_ACME)));

    const lever = refOf(LEVER_LIVE);
    assert.match(lever.apiUrl, /\/v0\/postings\/palantir\/16a1b500-13fe-4c22-ad89-372093b462da$/);
    assert.equal(atsResponseCacheKey(lever), `posting:lever:${lever.apiUrl}`);
    assert.notEqual(atsResponseCacheKey(lever), atsResponseCacheKey(refOf(LEVER_OTHER)));

    const greenhouse = refOf(GREENHOUSE_LIVE);
    assert.match(greenhouse.apiUrl, /\/v1\/boards\/discord\/jobs\/8806482002$/);
    const workday = refOf(WORKDAY_LIVE);
    assert.match(workday.apiUrl, /\/job\/San-Jose\/Sr-Technology-Compliance-Product-Owner_R172124$/);
    assert.equal(cacheableAtsResponse(200, false), true);
    assert.equal(cacheableAtsResponse(404, false), true);
    assert.equal(cacheableAtsResponse(500, false), false);
    assert.equal(cacheableAtsResponse(200, true), false);
  });

  it("reuses one Ashby board fetch for two jobs until the TTL, then misses", async () => {
    let now = 1_000_000;
    setAtsCacheClockForTests(() => now);
    let boardCalls = 0;
    const board = fixture("ashby-board.json");
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      assert.match(url, /api\.ashbyhq\.com\/posting-api\/job-board\/(linear|acme)$/);
      boardCalls += 1;
      if (url.includes("/acme")) return jsonResponse(JSON.stringify({ jobs: [] }));
      return jsonResponse(board);
    };

    const first = await lookupAtsJob(refOf(ASHBY_LIVE), fetcher);
    const second = await lookupAtsJob(refOf(ASHBY_OTHER), fetcher);
    assert.equal(first.outcome, "listed");
    assert.equal(second.outcome, "missing");
    assert.equal(boardCalls, 1, "second job at the same company must reuse the board");

    const again = await lookupAtsJob(refOf(`${ASHBY_LIVE}/application`), fetcher);
    assert.equal(again.outcome, "listed");
    assert.equal(boardCalls, 1);

    now += ATS_BOARD_CACHE_TTL_MS + 1;
    const expired = await lookupAtsJob(refOf(ASHBY_LIVE), fetcher);
    assert.equal(expired.outcome, "listed");
    assert.equal(boardCalls, 2);

    const otherCompany = await lookupAtsJob(refOf(ASHBY_ACME), fetcher);
    assert.equal(otherCompany.outcome, "missing");
    assert.equal(boardCalls, 3);
  });

  it("coalesces concurrent Ashby lookups onto one in-flight board fetch", async () => {
    let boardCalls = 0;
    let release: (body: string) => void = () => {};
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const fetcher: typeof fetch = async (input) => {
      assert.match(requestUrl(input), /job-board\/linear$/);
      boardCalls += 1;
      return jsonResponse(await gate);
    };

    const pending = Promise.all([
      lookupAtsJob(refOf(ASHBY_LIVE), fetcher),
      lookupAtsJob(refOf(ASHBY_OTHER), fetcher),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(boardCalls, 1);
    release(fixture("ashby-board.json"));
    const [live, other] = await pending;
    assert.equal(live.outcome, "listed");
    assert.equal(other.outcome, "missing");
    assert.equal(boardCalls, 1);
  });

  it("caches a single posting and does not cache a 500 or a timeout", async () => {
    let leverCalls = 0;
    const posting = fixture("lever-posting.json");
    const fetcher: typeof fetch = async (input) => {
      leverCalls += 1;
      assert.match(requestUrl(input), /\/v0\/postings\/palantir\/16a1b500/);
      return jsonResponse(posting);
    };
    const lever = refOf(LEVER_LIVE);
    assert.equal((await lookupAtsJob(lever, fetcher)).outcome, "listed");
    assert.equal((await lookupAtsJob(lever, fetcher)).outcome, "listed");
    assert.equal(leverCalls, 1);

    const otherCalls = { n: 0 };
    const otherFetcher: typeof fetch = async (input) => {
      otherCalls.n += 1;
      assert.match(requestUrl(input), /\/v0\/postings\/palantir\/aaaaaaaa-bbbb/);
      return jsonResponse(posting);
    };
    await lookupAtsJob(refOf(LEVER_OTHER), otherFetcher);
    assert.equal(otherCalls.n, 1);
    assert.equal(leverCalls, 1);

    clearAtsResponseCache();
    let errors = 0;
    const failing: typeof fetch = async () => {
      errors += 1;
      return jsonResponse("down", 500);
    };
    assert.equal((await lookupAtsJob(lever, failing)).outcome, "unavailable");
    assert.equal((await lookupAtsJob(lever, failing)).outcome, "unavailable");
    assert.equal(errors, 2);

    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    const timed = await lookupAtsJob(refOf(GREENHOUSE_LIVE), hanging, { timeoutMs: 30 });
    assert.equal(timed.outcome, "unavailable");
    let recovered = 0;
    const greenhouse = fixture("greenhouse-job.json");
    const recover: typeof fetch = async () => {
      recovered += 1;
      return jsonResponse(greenhouse);
    };
    assert.equal((await lookupAtsJob(refOf(GREENHOUSE_LIVE), recover)).outcome, "listed");
    assert.equal(recovered, 1);
  });

  it("drops the oldest entries when the entry or byte cap is exceeded", () => {
    setAtsCacheLimitsForTests({ maxEntries: 2, maxBytes: 1_000 });
    assert.equal(writeAtsResponseCache("board:ashby:a", { status: 200, text: "one", truncated: false }), true);
    assert.equal(writeAtsResponseCache("board:ashby:b", { status: 200, text: "two", truncated: false }), true);
    assert.equal(writeAtsResponseCache("board:ashby:c", { status: 200, text: "three", truncated: false }), true);
    assert.equal(readAtsResponseCache("board:ashby:a"), null);
    assert.ok(readAtsResponseCache("board:ashby:c"));
    assert.equal(atsCacheStats().entries, 2);

    clearAtsResponseCache();
    setAtsCacheLimitsForTests({ maxEntries: 10, maxBytes: 30 });
    assert.equal(writeAtsResponseCache("board:ashby:big", { status: 200, text: "x".repeat(20), truncated: false }), true);
    assert.equal(writeAtsResponseCache("board:ashby:next", { status: 200, text: "y".repeat(20), truncated: false }), true);
    assert.equal(readAtsResponseCache("board:ashby:big"), null);
    assert.equal(readAtsResponseCache("board:ashby:next")?.text.length, 20);
    assert.ok(atsCacheStats().bytes <= 30);
    assert.equal(writeAtsResponseCache("board:ashby:cut", { status: 200, text: "z", truncated: true }), false);
    assert.equal(readAtsResponseCache("board:ashby:cut"), null);
  });
});
