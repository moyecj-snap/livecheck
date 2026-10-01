import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import {
  resetCheckSlotsForTests,
  resolveCheckConcurrency,
  setCheckConcurrencyForTests,
} from "../src/check-capacity.js";
import {
  CHECK_CAPACITY_RETRY_AFTER_SECONDS,
  CHECK_CONCURRENCY,
  NETWORK,
  TEST_MODE_HEADER,
  TEST_MODE_SECRET_ENV,
} from "../src/config.js";
import { PAID_CALL_EVENT } from "../src/paid-call.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import { setFacilitatorTimeoutForTests } from "../src/processor-guard.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const JS_SHELL = "<!doctype html><html><head><title>Jobs</title></head><body><div id=\"root\"></div><p>You need to enable JavaScript to run this app.</p></body></html>";
const ASHBY_LIVE = "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff";
const SECRET = "load-test-secret";

function paymentSignature(accepted: unknown): string {
  const envelope = {
    x402Version: 2,
    accepted,
    payload: { signature: "test-sig" },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

function htmlResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function readJson(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

afterEach(() => {
  setCheckConcurrencyForTests(null);
  resetCheckSlotsForTests();
  setFacilitatorTimeoutForTests(null);
  delete process.env[TEST_MODE_SECRET_ENV];
  delete process.env.LIVECHECK_CHECK_CONCURRENCY;
});

describe("check concurrency", () => {
  it("defaults to 5 and honors LIVECHECK_CHECK_CONCURRENCY", () => {
    assert.equal(CHECK_CONCURRENCY, 5);
    assert.ok(CHECK_CONCURRENCY >= 4 && CHECK_CONCURRENCY <= 6);
    assert.equal(resolveCheckConcurrency(), 5);
    process.env.LIVECHECK_CHECK_CONCURRENCY = "4";
    assert.equal(resolveCheckConcurrency(), 4);
    process.env.LIVECHECK_CHECK_CONCURRENCY = "nope";
    assert.equal(resolveCheckConcurrency(), 5);
    setCheckConcurrencyForTests(2);
    assert.equal(resolveCheckConcurrency(), 2);
  });

  it("returns 503 + Retry-After before facilitator verify when the slots are full", async () => {
    let verifyCalls = 0;
    let settleCalls = 0;
    const facilitator: FacilitatorClient = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
      },
      async verify() {
        verifyCalls += 1;
        return { isValid: true };
      },
      async settle() {
        settleCalls += 1;
        return {
          success: true,
          transaction: "0xsettle",
          network: NETWORK,
          payer: "0x1111111111111111111111111111111111111111",
        };
      },
    };
    const app = createApp(
      livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), PAY_TO),
    );
    setCheckConcurrencyForTests(1);

    const unpaid = await app.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/jobs/open" }),
    });
    assert.equal(unpaid.status, 402, "under capacity, an unpaid probe is still 402");
    assert.equal(verifyCalls, 0);
    assert.equal(settleCalls, 0);
    const header = unpaid.headers.get("payment-required");
    assert.ok(header);
    const accepted = (decodePaymentRequired(header).accepts as unknown[])[0];

    const releasers: Array<() => void> = [];
    const original = globalThis.fetch;
    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Promise((resolve) => {
        releasers.push(() => resolve(htmlResponse(LIVE_HTML)));
      });
    };

    try {
      const first = app.request("/v1/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      await waitFor(() => releasers.length === 1 && verifyCalls === 1);

      const overflow = await app.request("/v1/verify/job", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "payment-signature": paymentSignature(accepted),
        },
        body: JSON.stringify({ url: "https://example.com/jobs/2" }),
      });
      assert.equal(overflow.status, 503);
      assert.equal(overflow.headers.get("retry-after"), String(CHECK_CAPACITY_RETRY_AFTER_SECONDS));
      assert.equal(overflow.headers.get("cache-control"), "no-store");
      const overflowBody = await readJson(overflow);
      assert.equal(overflowBody.error, "over_capacity");
      assert.equal(verifyCalls, 1, "overflow must not call facilitator verify");
      assert.equal(settleCalls, 0, "overflow must not settle");

      const probe = await app.request("/v1/verify/listing", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/jobs/3" }),
      });
      assert.equal(probe.status, 503);
      assert.equal(probe.headers.get("retry-after"), String(CHECK_CAPACITY_RETRY_AFTER_SECONDS));
      assert.equal(verifyCalls, 1);

      const confirm = await app.request("/v1/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/thanks", intent: "lead_submit" }),
      });
      assert.equal(confirm.status, 402, "Confirm stays outside the verify slot cap");

      const check = await app.request("/v1/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { type: "url", url: "https://example.com/item" },
          condition: { detector: "keyword", params: { any: ["sold"] } },
        }),
      });
      assert.equal(check.status, 402, "Sentinel check stays outside the verify slot cap");
      assert.equal(verifyCalls, 1);
      assert.equal(settleCalls, 0);

      releasers.shift()?.();
      const done = await first;
      assert.equal(done.status, 200);
      assert.equal(settleCalls, 1);

      const after = await app.request("/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/jobs/4" }),
      });
      assert.equal(after.status, 402);
      assert.equal(verifyCalls, 1);
    } finally {
      for (const release of releasers) release();
      globalThis.fetch = original;
    }
  });
});

describe("payment processor deadline", () => {
  function appWith(mode: "hang-verify" | "hang-settle" | "throw-verify" | "throw-settle" | "reject" | "verify-error") {
    let verifyCalls = 0;
    let settleCalls = 0;
    let collected = false;
    const facilitator: FacilitatorClient = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
      },
      async verify() {
        verifyCalls += 1;
        if (mode === "hang-verify") return new Promise(() => {});
        if (mode === "throw-verify") throw new Error("Facilitator verify failed (503): upstream");
        if (mode === "verify-error") {
          const error = new Error("invalid_payload");
          error.name = "VerifyError";
          (error as { statusCode?: number }).statusCode = 400;
          throw error;
        }
        if (mode === "reject") return { isValid: false, invalidReason: "invalid_payload" };
        return { isValid: true };
      },
      async settle() {
        settleCalls += 1;
        if (mode === "hang-settle") return new Promise(() => {});
        if (mode === "throw-settle") throw new Error("Facilitator settle failed (502): down");
        collected = true;
        return {
          success: true,
          transaction: "0xsettle",
          network: NETWORK,
          payer: "0x1111111111111111111111111111111111111111",
        };
      },
    };
    const app = createApp(livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), PAY_TO));
    return {
      app,
      counts: () => ({ verifyCalls, settleCalls, collected }),
    };
  }

  async function acceptedFor(app: ReturnType<typeof appWith>["app"]): Promise<unknown> {
    const res = await app.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/jobs/1" }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header);
    return (decodePaymentRequired(header).accepts as unknown[])[0];
  }

  async function paid(app: ReturnType<typeof appWith>["app"], accepted: unknown): Promise<Response> {
    return app.request("/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "payment-signature": paymentSignature(accepted),
      },
      body: JSON.stringify({ url: "https://example.com/jobs/1" }),
    });
  }

  it("verify timeout is 503 and does not settle", async () => {
    setFacilitatorTimeoutForTests(40);
    const { app, counts } = appWith("hang-verify");
    const accepted = await acceptedFor(app);
    const started = Date.now();
    const res = await paid(app, accepted);
    const body = await readJson(res);
    assert.equal(res.status, 503);
    assert.equal(body.error, "processor_unavailable");
    assert.equal(res.headers.get("retry-after"), String(CHECK_CAPACITY_RETRY_AFTER_SECONDS));
    assert.ok(Date.now() - started < 1_000);
    assert.equal(counts().verifyCalls, 1);
    assert.equal(counts().settleCalls, 0);
    assert.equal(counts().collected, false);
  });

  it("verify processor error is 503 and does not settle", async () => {
    const { app, counts } = appWith("throw-verify");
    const accepted = await acceptedFor(app);
    const res = await paid(app, accepted);
    const body = await readJson(res);
    assert.equal(res.status, 503);
    assert.equal(body.error, "processor_unavailable");
    assert.equal(counts().settleCalls, 0);
    assert.equal(counts().collected, false);
  });

  it("settle timeout or error is 503 and does not collect", async () => {
    setFacilitatorTimeoutForTests(40);
    const original = globalThis.fetch;
    globalThis.fetch = async () => htmlResponse(LIVE_HTML);
    try {
      const hung = appWith("hang-settle");
      const accepted = await acceptedFor(hung.app);
      const started = Date.now();
      const res = await paid(hung.app, accepted);
      const body = await readJson(res);
      assert.equal(res.status, 503);
      assert.equal(body.error, "processor_unavailable");
      assert.ok(Date.now() - started < 1_000);
      assert.equal(hung.counts().settleCalls, 1);
      assert.equal(hung.counts().collected, false);

      const failed = appWith("throw-settle");
      const failedAccept = await acceptedFor(failed.app);
      const failedRes = await paid(failed.app, failedAccept);
      const failedBody = await readJson(failedRes);
      assert.equal(failedRes.status, 503);
      assert.equal(failedBody.error, "processor_unavailable");
      assert.equal(failed.counts().collected, false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("a rejected payment stays 402 and a page-fetch failure stays 502", async () => {
    const rejected = appWith("reject");
    const accepted = await acceptedFor(rejected.app);
    const res = await paid(rejected.app, accepted);
    assert.equal(res.status, 402);
    assert.equal(rejected.counts().settleCalls, 0);

    const invalid = appWith("verify-error");
    const invalidAccept = await acceptedFor(invalid.app);
    const invalidRes = await paid(invalid.app, invalidAccept);
    assert.equal(invalidRes.status, 402);
    assert.equal(invalid.counts().settleCalls, 0);

    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("econnreset");
    };
    try {
      const fetched = appWith("hang-settle");
      // verify succeeds; fetch throws before settle. Mode hang-settle must not be reached.
      const fetchedAccept = await acceptedFor(fetched.app);
      const fetchedRes = await paid(fetched.app, fetchedAccept);
      const fetchedBody = await readJson(fetchedRes);
      assert.equal(fetchedRes.status, 502);
      assert.match(String(fetchedBody.error), /Could not fetch URL/);
      assert.equal(fetched.counts().settleCalls, 0);
      assert.equal(fetched.counts().collected, false);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("internal test mode", () => {
  function liveApp() {
    let verifyCalls = 0;
    let settleCalls = 0;
    const facilitator: FacilitatorClient = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
      },
      async verify() {
        verifyCalls += 1;
        return { isValid: true };
      },
      async settle() {
        settleCalls += 1;
        return {
          success: true,
          transaction: "0xsettle",
          network: NETWORK,
          payer: "0x1111111111111111111111111111111111111111",
        };
      },
    };
    const app = createApp(livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), PAY_TO));
    return { app, counts: () => ({ verifyCalls, settleCalls }) };
  }

  it("skips payment, still runs the check, and ignores a wrong or missing secret", async () => {
    process.env[TEST_MODE_SECRET_ENV] = SECRET;
    const { app, counts } = liveApp();
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((part) => String(part)).join(" "));
    };
    const originalFetch = globalThis.fetch;
    const board = readFileSync(new URL("./fixtures/ats/ashby-board.json", import.meta.url), "utf8");
    let atsCalls = 0;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.includes("api.ashbyhq.com")) {
        atsCalls += 1;
        return new Response(board, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === ASHBY_LIVE) return htmlResponse(JS_SHELL);
      return htmlResponse(LIVE_HTML);
    };
    try {
      const job = await app.request("/v1/verify/job", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: ASHBY_LIVE }),
      });
      assert.equal(job.status, 200);
      const body = await readJson(job);
      assert.equal(body.route, "verify/job");
      assert.equal(body.status, "live");
      assert.equal(typeof body.confidence, "number");
      assert.ok(Array.isArray(body.signals));
      assert.ok((body.signals as string[]).includes("ats_api_listed"));
      assert.ok(atsCalls >= 1, "test mode must still call the ATS API");
      assert.equal(counts().verifyCalls, 0);
      assert.equal(counts().settleCalls, 0);
      assert.equal(logs.some((line) => line.includes(PAID_CALL_EVENT)), false);

      const listing = await app.request("/v1/verify/listing", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: "https://example.com/item" }),
      });
      assert.equal(listing.status, 200);
      const listingBody = await readJson(listing);
      assert.equal(listingBody.route, "verify/listing");
      assert.equal(listingBody.status, "live");
      assert.equal(counts().verifyCalls, 0);
      assert.equal(counts().settleCalls, 0);

      const wrong = await app.request("/v1/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: "not-the-secret",
        },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      assert.equal(wrong.status, 402);
      assert.equal(counts().verifyCalls, 0);

      const missing = await app.request("/v1/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      assert.equal(missing.status, 402);

      const confirm = await app.request("/v1/confirm", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: "https://example.com/thanks", intent: "lead_submit" }),
      });
      assert.equal(confirm.status, 402, "test mode does not comp Confirm");

      delete process.env[TEST_MODE_SECRET_ENV];
      const unset = await app.request("/v1/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      assert.equal(unset.status, 402);
      assert.equal(counts().verifyCalls, 0);
      assert.equal(counts().settleCalls, 0);
    } finally {
      console.log = originalLog;
      globalThis.fetch = originalFetch;
    }
  });

  it("still 503s in test mode when the check slots are full, without charging", async () => {
    process.env[TEST_MODE_SECRET_ENV] = SECRET;
    setCheckConcurrencyForTests(1);
    const { app, counts } = liveApp();
    const releasers: Array<() => void> = [];
    const original = globalThis.fetch;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        releasers.push(() => resolve(htmlResponse(LIVE_HTML)));
      });
    try {
      const first = app.request("/v1/verify", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: "https://example.com/jobs/1" }),
      });
      await waitFor(() => releasers.length === 1);
      const second = await app.request("/v1/verify/job", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [TEST_MODE_HEADER]: SECRET,
        },
        body: JSON.stringify({ url: "https://example.com/jobs/2" }),
      });
      assert.equal(second.status, 503);
      assert.equal(second.headers.get("retry-after"), String(CHECK_CAPACITY_RETRY_AFTER_SECONDS));
      assert.equal(counts().verifyCalls, 0);
      assert.equal(counts().settleCalls, 0);
      releasers.shift()?.();
      const done = await first;
      assert.equal(done.status, 200);
    } finally {
      for (const release of releasers) release();
      globalThis.fetch = original;
    }
  });
});
