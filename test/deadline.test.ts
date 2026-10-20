import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import { createApp } from "../src/app.js";
import { lookupAtsJob, parseAtsJobUrl } from "../src/ats-api.js";
import { CheckError, runCheck } from "../src/check.js";
import {
  ATS_FETCH_TIMEOUT_MS,
  CHECK_TIMEOUT_SIGNAL,
  FACILITATOR_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  VERIFY_DEADLINE_MS,
} from "../src/config.js";
import { setDeadlineForTests } from "../src/deadline.js";
import { liveFacilitatorClient } from "../src/payments.js";
import { VerifyError, fetchPage, verifyUrl } from "../src/verify.js";

beforeEach(() => {
  clearAtsResponseCache();
});

const ASHBY = "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff";
const JS_SHELL = `<!doctype html><html><head><title>Jobs</title></head><body><div id="root"></div><p>You need to enable JavaScript to run this app.</p></body></html>`;

function hangingFetch(onAbort?: () => void): typeof fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      const fail = () => {
        onAbort?.();
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) fail();
      else init?.signal?.addEventListener("abort", fail, { once: true });
    });
}

describe("timeout budgets", () => {
  it("pins page, ATS, envelope, and facilitator deadlines", () => {
    assert.equal(FETCH_TIMEOUT_MS, 8_000);
    assert.equal(ATS_FETCH_TIMEOUT_MS, 5_000);
    assert.equal(VERIFY_DEADLINE_MS, 20_000);
    assert.equal(FACILITATOR_TIMEOUT_MS, 5_000);
    assert.equal(CHECK_TIMEOUT_SIGNAL, "check_timeout");
    assert.ok(ATS_FETCH_TIMEOUT_MS < FETCH_TIMEOUT_MS);
    assert.ok(FETCH_TIMEOUT_MS < VERIFY_DEADLINE_MS);
    const fly = readFileSync(new URL("../fly.toml", import.meta.url), "utf8");
    assert.match(fly, /memory\s*=\s*"1gb"/);
  });

  it("builds the live facilitator client with the shorter HTTP deadline", () => {
    const client = liveFacilitatorClient({
      stripeSecretKey: "sk_test_deadline",
      depositAddress: "0x2222222222222222222222222222222222222222",
      cdpApiKeyId: "test-key-id",
      cdpApiKeySecret: "test-key-secret",
    });
    assert.equal(client.timeoutMs, FACILITATOR_TIMEOUT_MS);
  });

  it("page fetch still 504s on its own timeout, before the envelope", async () => {
    const started = Date.now();
    const error = await fetchPage("https://example.com/slow", hangingFetch(), { timeoutMs: 40 }).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof VerifyError);
    assert.equal(error.status, 504);
    assert.match(error.message, /40ms/);
    assert.ok(Date.now() - started < 1_000);
  });

  it("returns unknown check_timeout and aborts the fetch when the envelope elapses", async () => {
    let aborted = false;
    const started = Date.now();
    const verdict = await verifyUrl("https://example.com/jobs/1", hangingFetch(() => {
      aborted = true;
    }), new Date("2026-10-01T00:00:00Z"), { deadlineMs: 50 });
    assert.equal(verdict.status, "unknown");
    assert.deepEqual(verdict.signals, [CHECK_TIMEOUT_SIGNAL]);
    assert.equal(verdict.http_status, 0);
    assert.equal(verdict.confidence, 0);
    assert.equal(verdict.canonical_url, "https://example.com/jobs/1");
    assert.equal(aborted, true);
    assert.ok(Date.now() - started < 1_000);
  });

  it("check envelope is 422 baseline_unreachable with check_timeout, not an observation", async () => {
    const started = Date.now();
    const error = await runCheck(
      {
        target: { type: "url", url: "https://example.com/item", render: "never", selector: null },
        condition: {
          detector: "keyword",
          params: { any: ["sold"], all: [], none: [], selector: null, case_sensitive: false },
        },
        baseline_hash: null,
      },
      hangingFetch(),
      new Date(),
      50,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CheckError);
    assert.equal(error.code, "baseline_unreachable");
    assert.equal(error.status, 422);
    assert.equal(error.signal, CHECK_TIMEOUT_SIGNAL);
    assert.match(error.message, /check_timeout/);
    assert.ok(Date.now() - started < 1_000);
  });

  it("status_change check does not keep a timeout verdict as an observation", async () => {
    const error = await runCheck(
      {
        target: { type: "url", url: "https://example.com/item", render: "never", selector: null },
        condition: { detector: "status_change", params: {} },
        baseline_hash: null,
      },
      hangingFetch(),
      new Date(),
      50,
    ).then(
      () => null,
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CheckError);
    assert.equal(error.signal, CHECK_TIMEOUT_SIGNAL);
    assert.equal(error.status, 422);
  });

  it("POST /v1/verify returns 200 unknown and POST /v1/check returns 422", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = hangingFetch();
    setDeadlineForTests(50);
    try {
      const app = createApp();
      const started = Date.now();
      const verify = await app.request("/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      assert.equal(verify.status, 200);
      const verifyBody = (await verify.json()) as { status?: string; signals?: string[]; route?: string };
      assert.equal(verifyBody.status, "unknown");
      assert.ok(verifyBody.signals?.includes(CHECK_TIMEOUT_SIGNAL));
      assert.equal(verifyBody.route, "verify");

      const check = await app.request("/v1/check", {
        method: "POST",
        headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
        body: JSON.stringify({
          target: { type: "url", url: "https://example.com/item" },
          condition: { detector: "keyword", params: { any: ["sold"] } },
        }),
      });
      assert.equal(check.status, 422);
      const checkBody = (await check.json()) as { error?: string; signal?: string; message?: string };
      assert.equal(checkBody.error, "baseline_unreachable");
      assert.equal(checkBody.signal, CHECK_TIMEOUT_SIGNAL);
      assert.match(checkBody.message ?? "", /check_timeout/);
      assert.ok(Date.now() - started < 2_000);
    } finally {
      globalThis.fetch = original;
      setDeadlineForTests(null);
    }
  });

  it("a hung Ashby board is unavailable at ~5s and does not eat the page timeout or the envelope", { timeout: 12_000 }, async () => {
    const ref = parseAtsJobUrl(ASHBY);
    assert.ok(ref);
    let atsAborted = false;
    const fetcher: typeof fetch = (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.ashbyhq.com")) return hangingFetch(() => {
        atsAborted = true;
      })(input, init);
      return Promise.resolve(new Response(JS_SHELL, { status: 200, headers: { "content-type": "text/html" } }));
    };
    const started = Date.now();
    const verdict = await verifyUrl(ASHBY, fetcher, new Date(), { atsApi: true, deadlineMs: VERIFY_DEADLINE_MS });
    const elapsed = Date.now() - started;
    assert.equal(atsAborted, true);
    assert.equal(verdict.signals.includes(CHECK_TIMEOUT_SIGNAL), false);
    assert.equal(verdict.signals.includes("ats_api_listed"), false);
    assert.equal(verdict.signals.includes("ats_api_missing"), false);
    assert.ok(elapsed >= ATS_FETCH_TIMEOUT_MS - 250, `ATS returned in ${elapsed}ms`);
    assert.ok(elapsed < FETCH_TIMEOUT_MS - 500, `ATS waited ${elapsed}ms`);
  });

  it("a hung page is still a 504 at ~8s when the envelope is 20s", { timeout: 15_000 }, async () => {
    const started = Date.now();
    const error = await verifyUrl("https://example.com/slow-page", hangingFetch(), new Date(), {
      deadlineMs: VERIFY_DEADLINE_MS,
    }).then(
      () => null,
      (caught: unknown) => caught,
    );
    const elapsed = Date.now() - started;
    assert.ok(error instanceof VerifyError);
    assert.equal(error.status, 504);
    assert.match(error.message, new RegExp(`${FETCH_TIMEOUT_MS}ms`));
    assert.ok(elapsed >= FETCH_TIMEOUT_MS - 250, `page returned in ${elapsed}ms`);
    assert.ok(elapsed < VERIFY_DEADLINE_MS - 1_000, `page waited ${elapsed}ms`);
  });

  it("lookupAtsJob default timeout is the ATS budget", { timeout: 12_000 }, async () => {
    const ref = parseAtsJobUrl(ASHBY);
    assert.ok(ref);
    const started = Date.now();
    const result = await lookupAtsJob(ref, hangingFetch());
    const elapsed = Date.now() - started;
    assert.equal(result.outcome, "unavailable");
    assert.ok(elapsed >= ATS_FETCH_TIMEOUT_MS - 250, `elapsed ${elapsed}`);
    assert.ok(elapsed < FETCH_TIMEOUT_MS - 500, `elapsed ${elapsed}`);
  });
});
