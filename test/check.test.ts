import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CHECK_PAYMENT_DESCRIPTION,
  CHECK_PRICE_ATOMIC_USDC,
  CHECK_PRICE_USD,
  CONFIRM_PRICE_ATOMIC_USDC,
  PRICE_ATOMIC_USDC,
} from "../src/config.js";
import {
  CheckError,
  extractBySelector,
  httpClassOf,
  keywordPresenceMatches,
  observationHash,
  parseCheckRequest,
} from "../src/check.js";
import { isCheckId, isConfirmId, isReceiptId } from "../src/confirm-id.js";
import {
  generateReceiptPrivateKeyPem,
  livecheckKeysDocument,
  resetReceiptSignerCache,
} from "../src/receipt.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

function isAscii(value: string): boolean {
  return [...value].every((ch) => ch.charCodeAt(0) < 128);
}

function checkBody(url: string, extras: Record<string, unknown> = {}) {
  return {
    target: { type: "url", url, render: "never", selector: null },
    condition: { detector: "status_change", params: {} },
    baseline_hash: null,
    ...extras,
  };
}

describe("check parsers and detectors", () => {
  it("hashes status + http class only", () => {
    assert.equal(httpClassOf(200), "2xx");
    assert.equal(httpClassOf(404), "4xx");
    assert.equal(observationHash("live", "2xx"), observationHash("live", "2xx"));
    assert.notEqual(observationHash("live", "2xx"), observationHash("closed", "2xx"));
    assert.notEqual(observationHash("live", "2xx"), observationHash("live", "4xx"));
    assert.equal(observationHash("live", "2xx").length, 64);
  });

  it("keyword any/all/none presence", () => {
    const hay = "Apply Now — Staff Backend Engineer on Greenhouse";
    assert.equal(
      keywordPresenceMatches(hay, {
        any: ["apply now"],
        all: [],
        none: [],
        selector: null,
        case_sensitive: false,
      }),
      true,
    );
    assert.equal(
      keywordPresenceMatches(hay, {
        any: [],
        all: ["Apply Now", "Greenhouse"],
        none: [],
        selector: null,
        case_sensitive: true,
      }),
      true,
    );
    assert.equal(
      keywordPresenceMatches(hay, {
        any: [],
        all: ["apply now", "greenhouse"],
        none: [],
        selector: null,
        case_sensitive: true,
      }),
      false,
    );
    assert.equal(
      keywordPresenceMatches(hay, {
        any: [],
        all: [],
        none: ["sold out"],
        selector: null,
        case_sensitive: false,
      }),
      true,
    );
    assert.equal(
      keywordPresenceMatches(hay, {
        any: ["Apply Now"],
        all: ["Greenhouse"],
        none: ["sold out"],
        selector: null,
        case_sensitive: false,
      }),
      true,
    );
    assert.equal(
      keywordPresenceMatches(hay, {
        any: [],
        all: [],
        none: ["Apply Now"],
        selector: null,
        case_sensitive: false,
      }),
      false,
    );
  });

  it("extracts text from a simple CSS selector", () => {
    const html = `<html><body><h1>Staff Backend Engineer</h1><button>Apply Now</button></body></html>`;
    assert.match(extractBySelector(html, "h1"), /Staff Backend Engineer/);
    assert.equal(extractBySelector(html, "h1").includes("Apply Now"), false);
  });

  it("rejects invalid target and condition", () => {
    assert.throws(() => parseCheckRequest({}), (error: unknown) => {
      return error instanceof CheckError && error.code === "invalid_target" && error.status === 400;
    });
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "watch", url: "https://example.com" },
          condition: { detector: "status_change" },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_target",
    );
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com", render: "always" },
          condition: { detector: "status_change" },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_target",
    );
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com" },
          condition: { detector: "css" },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_condition",
    );
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com" },
          condition: { detector: "keyword", params: {} },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_condition",
    );
  });

  it("rejects an unusable baseline_hash", () => {
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com" },
          condition: { detector: "status_change" },
          baseline_hash: "not-a-hash",
        }),
      (error: unknown) =>
        error instanceof CheckError && error.code === "baseline_unreachable" && error.status === 422,
    );
  });
});

describe("POST /v1/check HTTP", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => close());

  it("unpaid check is 402 with one accept at 20000", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(checkBody("https://example.com/jobs/1")),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header);
    const decoded = decodePaymentRequired(header);
    const accepts = decoded.accepts as Array<{
      amount?: string;
      extra?: { name?: string; version?: string };
      scheme?: string;
    }>;
    assert.equal(accepts.length, 1);
    assert.equal(accepts[0]?.amount, CHECK_PRICE_ATOMIC_USDC);
    assert.equal(accepts[0]?.amount, "20000");
    assert.equal(CHECK_PRICE_USD, 0.02);
    assert.equal(accepts[0]?.scheme, "exact");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
    const resource = decoded.resource as { url?: string; description?: string };
    assert.ok(resource.url?.endsWith("/v1/check"));
    assert.equal(resource.description, CHECK_PAYMENT_DESCRIPTION);
    assert.equal(isAscii(CHECK_PAYMENT_DESCRIPTION), true);
    assert.doesNotMatch(CHECK_PAYMENT_DESCRIPTION, /[^\x00-\x7F]/);
  });

  it("verify and confirm unpaid 402s stay single-price (regression)", async () => {
    const verify = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(verify.status, 402);
    const verifyDecoded = decodePaymentRequired(verify.headers.get("payment-required") ?? "");
    const verifyAccepts = verifyDecoded.accepts as Array<{ amount?: string }>;
    assert.equal(verifyAccepts.length, 1);
    assert.equal(verifyAccepts[0]?.amount, PRICE_ATOMIC_USDC);

    const confirm = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thank-you", intent: "lead_submit" }),
    });
    assert.equal(confirm.status, 402);
    const confirmDecoded = decodePaymentRequired(confirm.headers.get("payment-required") ?? "");
    const confirmAccepts = confirmDecoded.accepts as Array<{ amount?: string }>;
    assert.equal(confirmAccepts.length, 1);
    assert.equal(confirmAccepts[0]?.amount, CONFIRM_PRICE_ATOMIC_USDC);
  });

  it("mock-paid status_change live fixture", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(checkBody(`${origin}/fixtures/live-apply-now`)),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      observation: { status: string; http_status: number; http_class: string; hash: string; summary: string };
      fired: boolean | null;
      confidence: number;
      price_usd: number;
      receipt: { hash: string; verify_url: string };
    };
    assert.equal(isCheckId(body.id), true);
    assert.equal(isConfirmId(body.id), false);
    assert.equal(isReceiptId(body.id), true);
    assert.equal(body.observation.status, "live");
    assert.equal(body.observation.http_status, 200);
    assert.equal(body.observation.http_class, "2xx");
    assert.equal(body.observation.hash, observationHash("live", "2xx"));
    assert.match(body.observation.summary, /live 2xx/);
    assert.equal(body.fired, null);
    assert.equal(body.price_usd, 0.02);
    assert.equal(body.receipt.hash.length, 64);
    assert.ok(body.receipt.verify_url.includes(body.id));
  });

  it("mock-paid status_change closed fixture fires against a live baseline", async () => {
    const liveHash = observationHash("live", "2xx");
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/closed-to-new-applications`, render: "never" },
        condition: { detector: "status_change", params: {} },
        baseline_hash: liveHash,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      observation: { status: string; hash: string };
      fired: boolean | null;
    };
    assert.equal(body.observation.status, "closed");
    assert.equal(body.fired, true);
    assert.notEqual(body.observation.hash, liveHash);
  });

  it("status_change does not fire when baseline matches current hash", async () => {
    const liveHash = observationHash("live", "2xx");
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        ...checkBody(`${origin}/fixtures/live-apply-now`),
        baseline_hash: liveHash,
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { fired: boolean | null; observation: { status: string } };
    assert.equal(body.observation.status, "live");
    assert.equal(body.fired, false);
  });

  it("keyword any/all/none against the live fixture", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const anyRes = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { any: ["Apply Now"] } },
      }),
    });
    assert.equal(anyRes.status, 200);
    assert.equal(((await anyRes.json()) as { fired: boolean }).fired, true);

    const allRes = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { all: ["Apply Now", "Greenhouse"] } },
      }),
    });
    assert.equal(((await allRes.json()) as { fired: boolean }).fired, true);

    const noneRes = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { none: ["sold out"] } },
      }),
    });
    assert.equal(((await noneRes.json()) as { fired: boolean }).fired, true);

    const noneMiss = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { none: ["Apply Now"] } },
      }),
    });
    assert.equal(((await noneMiss.json()) as { fired: boolean }).fired, false);

    const scoped = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { any: ["Apply Now"], selector: "h1" } },
      }),
    });
    assert.equal(((await scoped.json()) as { fired: boolean }).fired, false);
  });

  it("invalid_target and invalid_condition after mock pay", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const badTarget = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: "ftp://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
    });
    assert.equal(badTarget.status, 400);
    assert.equal(((await badTarget.json()) as { error?: string }).error, "invalid_target");

    const badCondition = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now` },
        condition: { detector: "keyword", params: { any: "Apply Now" } },
      }),
    });
    assert.equal(badCondition.status, 400);
    assert.equal(((await badCondition.json()) as { error?: string }).error, "invalid_condition");
  });

  it("unusable baseline_hash is 422 baseline_unreachable", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({
        ...checkBody(`${origin}/fixtures/live-apply-now`),
        baseline_hash: "short",
      }),
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error?: string }).error, "baseline_unreachable");
  });

  it("unreachable target is 422 baseline_unreachable", async () => {
    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(checkBody("http://127.0.0.1:1/no-listener")),
    });
    assert.equal(res.status, 422);
    assert.equal(((await res.json()) as { error?: string }).error, "baseline_unreachable");
  });
});

describe("POST /v1/check receipt round-trip", () => {
  const pem = generateReceiptPrivateKeyPem();
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  let previous: string | undefined;

  before(async () => {
    previous = process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    process.env.CONFIRM_RECEIPT_PRIVATE_KEY = pem;
    resetReceiptSignerCache();
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    close();
    if (previous === undefined) delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    else process.env.CONFIRM_RECEIPT_PRIVATE_KEY = previous;
    resetReceiptSignerCache();
  });

  it("signs chk_ receipts and GET /v1/receipt/{id} verifies them", async () => {
    const keysDoc = livecheckKeysDocument() as { signing?: boolean };
    assert.equal(keysDoc.signing, true);

    const res = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(checkBody(`${origin}/fixtures/live-apply-now`)),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      id: string;
      receipt: { hash: string; signature?: string; signer?: string; verify_url: string };
    };
    assert.equal(isCheckId(body.id), true);
    assert.ok(body.receipt.signature);
    assert.equal(body.receipt.signer, "livecheck-confirm-v1");

    const lookup = await fetch(`${origin}/v1/receipt/${body.id}`);
    assert.equal(lookup.status, 200);
    const stored = (await lookup.json()) as {
      id: string;
      intent: string;
      canonical: string;
      receipt: { signature?: string };
      verify: { signed?: boolean; valid?: boolean | null; kid?: string | null };
    };
    assert.equal(stored.id, body.id);
    assert.equal(stored.intent, "check");
    assert.equal(stored.verify.signed, true);
    assert.equal(stored.verify.valid, true);
    assert.equal(stored.verify.kid, "livecheck-confirm-v1");
    assert.ok(stored.canonical.includes(body.id));
  });
});
