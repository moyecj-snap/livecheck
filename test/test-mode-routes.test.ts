import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/app.js";
import { isTestModePaidPath } from "../src/check-capacity.js";
import { NETWORK, TEST_MODE_HEADER, TEST_MODE_SECRET_ENV } from "../src/config.js";
import { PAID_CALL_EVENT } from "../src/paid-call.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import { clearConfirmReceiptMemory, listMemoryReceiptIds } from "../src/receipt-store.js";
import { buildStatsDocument } from "../src/stats.js";
import { createWatch } from "../src/watch.js";
import { closeWatchStore, countActiveStandardWatchers, getWatcher, initWatchStore } from "../src/watch-store.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const PAYER = "0xb782000000000000000000000000000000000001";
const SECRET = "route-test-secret";
const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const THANK_YOU =
  "<!doctype html><title>Thank you for your order</title><body><h1>Thank you for your order!</h1><p>Order #ORD-18421 confirmed.</p></body>";

function liveApp() {
  const counts = { verify: 0, settle: 0 };
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
    async verify() {
      counts.verify += 1;
      return { isValid: true };
    },
    async settle() {
      counts.settle += 1;
      return { success: true, transaction: "0xsettle", network: NETWORK, payer: PAYER };
    },
  };
  const app = createApp(livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), PAY_TO));
  return { app, counts };
}

/** Strip time-varying fields so two /stats documents can be compared. */
function statsShape(): unknown {
  return JSON.parse(JSON.stringify(buildStatsDocument(), (key, value) => (/(_at|generated|now|uptime)/i.test(key) ? undefined : value)));
}

describe("test mode on every paid route", () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  let logs: string[] = [];

  before(() => {
    initWatchStore(":memory:");
    initPaidCallStore(":memory:");
  });
  after(() => {
    closeWatchStore();
    closePaidCallStore();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    delete process.env[TEST_MODE_SECRET_ENV];
  });

  it("lists every priced POST route", () => {
    for (const path of [
      "/v1/verify",
      "/v1/verify/job",
      "/v1/verify/listing",
      "/v1/confirm",
      "/v1/confirm/order",
      "/v1/check",
      "/v1/watch",
      "/v1/watch/renew",
      "/v1/watch/wch_abc/chain/topup",
      "/v1/check/",
    ]) {
      assert.equal(isTestModePaidPath(path), true, path);
    }
    for (const path of ["/v1/watch/wch_abc", "/v1/watch/wch_abc/events", "/stats", "/job", "/v1/receipt/cfm_x"]) {
      assert.equal(isTestModePaidPath(path), false, path);
    }
  });

  it("runs each route with no x402, no paid_calls row, no stored receipt or watcher, and /stats unchanged", async () => {
    process.env[TEST_MODE_SECRET_ENV] = SECRET;
    globalThis.fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes("thank-you") ? THANK_YOU : LIVE_HTML;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    };
    // A real watcher (made outside test mode) for renew / topup.
    const created = await createWatch(
      {
        target: { type: "url", url: "https://example.com/jobs/renew-me", render: "never", selector: null },
        condition: { detector: "status_change", params: {} },
        interval_s: 900,
      },
      { payer: PAYER, fetcher: globalThis.fetch },
    );
    const before = getWatcher(created.result.id);
    assert.ok(before);
    clearConfirmReceiptMemory();
    const watchersBefore = countActiveStandardWatchers(PAYER);
    const statsBefore = statsShape();

    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    const { app, counts } = liveApp();
    const cases: Array<{ path: string; body: unknown; status: number; owner?: boolean }> = [
      { path: "/v1/verify", body: { url: "https://example.com/jobs/1" }, status: 200 },
      { path: "/v1/verify/job", body: { url: "https://example.com/jobs/2" }, status: 200 },
      { path: "/v1/verify/listing", body: { url: "https://example.com/listing/3" }, status: 200 },
      { path: "/v1/confirm", body: { url: "https://shop.example.com/thank-you", intent: "lead_submit" }, status: 200 },
      {
        path: "/v1/confirm/order",
        body: { url: "https://shop.example.com/thank-you", intent: "order_placed", claim: { order_id: "ORD-18421" } },
        status: 200,
      },
      {
        path: "/v1/check",
        body: {
          target: { type: "url", url: "https://example.com/jobs/4", render: "never" },
          condition: { detector: "status_change", params: {} },
        },
        status: 200,
      },
      {
        path: "/v1/watch",
        body: {
          target: { type: "url", url: "https://example.com/jobs/5", render: "never", selector: null },
          condition: { detector: "status_change", params: {} },
          interval_s: 900,
        },
        status: 201,
      },
      { path: "/v1/watch/renew", body: { id: created.result.id }, status: 200, owner: true },
      { path: `/v1/watch/${created.result.id}/chain/topup`, body: {}, status: 200, owner: true },
    ];
    for (const c of cases) {
      const headers: Record<string, string> = { "content-type": "application/json", [TEST_MODE_HEADER]: SECRET };
      if (c.owner) headers["x-livecheck-owner-token"] = created.ownerToken;
      const res = await app.request(c.path, { method: "POST", headers, body: JSON.stringify(c.body) });
      assert.equal(res.status, c.status, `${c.path}: ${await res.clone().text()}`);
      assert.equal(res.headers.get(TEST_MODE_HEADER), "1", c.path);
      assert.equal(res.headers.get("payment-required"), null, c.path);
    }
    console.log = originalLog;

    assert.equal(counts.verify, 0, "facilitator verify must not run");
    assert.equal(counts.settle, 0, "facilitator settle must not run");
    assert.equal(logs.some((line) => line.includes(PAID_CALL_EVENT)), false, "no paid_call event");
    assert.deepEqual(listMemoryReceiptIds(), [], "no receipts kept");
    assert.equal(countActiveStandardWatchers(PAYER), watchersBefore, "no watcher created");
    const afterRow = getWatcher(created.result.id);
    assert.equal(afterRow?.expires_at, before.expires_at, "renew is a dry run");
    assert.equal(afterRow?.checks_remaining, before.checks_remaining);
    assert.equal(afterRow?.chain_balance_atomic, before.chain_balance_atomic, "topup is a dry run");
    assert.deepEqual(statsShape(), statsBefore, "/stats unchanged");
  });

  it("a wrong secret still gets 402 on every route", async () => {
    process.env[TEST_MODE_SECRET_ENV] = SECRET;
    const { app, counts } = liveApp();
    for (const path of ["/v1/verify", "/v1/confirm", "/v1/confirm/order", "/v1/check", "/v1/watch", "/v1/watch/renew"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_MODE_HEADER]: "wrong-secret-xx" },
        body: JSON.stringify({ url: "https://example.com/x", intent: "lead_submit" }),
      });
      assert.equal(res.status, 402, path);
    }
    assert.equal(counts.settle, 0);
  });
});
