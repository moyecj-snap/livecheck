import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import type { SettleResponse } from "@x402/core/types";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import { NETWORK, PAYMENT_STATUS_UNKNOWN_MESSAGE } from "../src/config.js";
import { closePaidCallStore, initPaidCallStore, listRefundCandidatesFromStore } from "../src/paid-call-store.js";
import { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } from "../src/payments.js";
import {
  LATE_SETTLE_REASON,
  SETTLE_ERROR_UNRESOLVED_REASON,
  SETTLE_TIMEOUT_UNRESOLVED_REASON,
  setFacilitatorTimeoutForTests,
} from "../src/processor-guard.js";
import { REFUND_CANDIDATE_EVENT, setRefundCandidateWriterForTests, usdFromAtomic } from "../src/refund-candidate-log.js";
import { SETTLED_NO_RESPONSE_REASON, noteSettledPayment, withSettleAbortContext } from "../src/settle-abort.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const PAYER = "0x1111111111111111111111111111111111111111";
const PAY_TO = "0x2222222222222222222222222222222222222222";

function txHash(n: number): string {
  return `0x${n.toString(16).padStart(64, "0")}`;
}

function paymentSignature(accepted: unknown): string {
  const envelope = {
    x402Version: 2,
    accepted,
    payload: { signature: "test-sig", authorization: { from: PAYER, to: PAY_TO, value: "10000", nonce: txHash(99) } },
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

type SettleImpl = () => Promise<SettleResponse>;

describe("x402 settle: payment status unknown and refund candidates", () => {
  const dir = mkdtempSync(join(tmpdir(), "lc-settle-unknown-"));
  const lines: string[] = [];
  let settleImpl: SettleImpl = async () => ({ success: true, transaction: txHash(1), network: NETWORK, payer: PAYER });
  let settleCalls = 0;
  const facilitator: FacilitatorClient = {
    async getSupported() {
      return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
    },
    async verify() {
      return { isValid: true };
    },
    settle() {
      settleCalls += 1;
      return settleImpl();
    },
  };
  const app = createApp(livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator), PAY_TO));
  let origin = "";
  let closeApp: () => void = () => {};
  const pages: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(LIVE_HTML);
  });
  let pagesOrigin = "";

  before(async () => {
    initPaidCallStore(join(dir, "paid-calls.sqlite"));
    setRefundCandidateWriterForTests((line) => lines.push(line));
    await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", () => resolve()));
    const address = pages.address();
    if (!address || typeof address === "string") throw new Error("expected tcp address");
    pagesOrigin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        closeApp = () => server.close();
        resolve();
      });
    });
  });

  after(async () => {
    closeApp();
    await new Promise<void>((resolve) => pages.close(() => resolve()));
    setRefundCandidateWriterForTests(null);
    setFacilitatorTimeoutForTests(null);
    closePaidCallStore();
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    setFacilitatorTimeoutForTests(null);
  });

  function parsed(): Array<Record<string, unknown>> {
    return lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  }

  async function accepted(): Promise<{ amount?: string }> {
    const res = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: `${pagesOrigin}/job` }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header);
    return (decodePaymentRequired(header).accepts as Array<{ amount?: string }>)[0]!;
  }

  async function paidVerify(accept: unknown, signal?: AbortSignal): Promise<Response> {
    return fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "payment-signature": paymentSignature(accept) },
      body: JSON.stringify({ url: `${pagesOrigin}/job` }),
      ...(signal ? { signal } : {}),
    });
  }

  it("a settle that finishes after the 503 is listed with tx, payer, amount, route and both timestamps", async () => {
    setFacilitatorTimeoutForTests(40);
    const tx = txHash(0xa1);
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => new Promise((resolve) => (release = resolve));
    const accept = await accepted();
    const res = await paidVerify(accept);
    const body = (await res.json()) as { error?: string; message?: string };
    assert.equal(res.status, 503);
    assert.equal(body.error, "payment_status_unknown");
    assert.equal(body.message, PAYMENT_STATUS_UNKNOWN_MESSAGE);
    assert.equal(body.message, "Payment status unknown. Don't retry for 60 seconds. If you were charged and got no answer, we'll refund it.");
    assert.doesNotMatch(JSON.stringify(body), /not charged/i);
    assert.equal(res.headers.get("retry-after"), "60");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("payment-response"), null);
    assert.equal(listRefundCandidatesFromStore().some((r) => r.payment_id === tx), false, "not listed before it settles");

    release({ success: true, transaction: tx, network: NETWORK, payer: PAYER });
    await waitFor(() => listRefundCandidatesFromStore().some((r) => r.payment_id === tx));
    const stored = listRefundCandidatesFromStore().find((r) => r.payment_id === tx)!;
    assert.equal(stored.protocol, "x402");
    assert.equal(stored.reason, LATE_SETTLE_REASON);
    assert.equal(stored.route, "verify");
    assert.equal(stored.payer, PAYER);
    assert.equal(stored.amount_usd, usdFromAtomic(accept.amount));
    assert.equal(stored.amount_usd, "0.01");
    assert.match(String(stored.responded_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.match(String(stored.settled_at), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(String(stored.settled_at) >= String(stored.responded_at));
    const line = parsed().find((l) => l.payment_id === tx);
    assert.ok(line);
    assert.equal(line.event, REFUND_CANDIDATE_EVENT);
    assert.equal(line.reason, LATE_SETTLE_REASON);
    assert.equal(JSON.stringify(line).includes(pagesOrigin), false, "no target URL in the refund line");
  });

  it("a timed-out settle whose outcome is never learned is listed without a tx", async () => {
    setFacilitatorTimeoutForTests(40);
    let fail: (error: Error) => void = () => {};
    settleImpl = () => new Promise((_resolve, reject) => (fail = reject));
    const before = listRefundCandidatesFromStore().length;
    const res = await paidVerify(await accepted());
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error?: string }).error, "payment_status_unknown");
    fail(new Error("Facilitator settle failed: The operation was aborted due to timeout"));
    await waitFor(() => listRefundCandidatesFromStore().length > before);
    const stored = listRefundCandidatesFromStore().at(-1)!;
    assert.equal(stored.reason, SETTLE_TIMEOUT_UNRESOLVED_REASON);
    assert.equal(stored.payment_id, undefined);
    assert.equal(stored.payer, PAYER);
    assert.equal(stored.amount_usd, "0.01");
    assert.ok(stored.responded_at);
    assert.equal(stored.settled_at, undefined);
  });

  it("a settle processor error is 503 payment_status_unknown and is listed", async () => {
    settleImpl = async () => {
      throw new Error("Facilitator settle failed (502): down");
    };
    const before = listRefundCandidatesFromStore().length;
    const res = await paidVerify(await accepted());
    assert.equal(res.status, 503);
    const body = (await res.json()) as { error?: string; message?: string };
    assert.equal(body.error, "payment_status_unknown");
    assert.doesNotMatch(String(body.message), /not charged/i);
    assert.equal(res.headers.get("retry-after"), "60");
    await waitFor(() => listRefundCandidatesFromStore().length > before);
    const stored = listRefundCandidatesFromStore().at(-1)!;
    assert.equal(stored.reason, SETTLE_ERROR_UNRESOLVED_REASON);
    assert.equal(stored.payer, PAYER);
  });

  it("a late settle that fails is not listed", async () => {
    setFacilitatorTimeoutForTests(40);
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => new Promise((resolve) => (release = resolve));
    const before = listRefundCandidatesFromStore().length;
    const linesBefore = lines.length;
    const res = await paidVerify(await accepted());
    assert.equal(res.status, 503);
    await res.text();
    release({ success: false, errorReason: "invalid_exact_evm_payload_signature", transaction: "", network: NETWORK });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(listRefundCandidatesFromStore().length, before);
    assert.equal(lines.length, linesBefore);
  });

  it("a settle that lands after the caller disconnected is listed as settled_no_response_delivered", async () => {
    setFacilitatorTimeoutForTests(3_000);
    const tx = txHash(0xb2);
    let settleStarted = false;
    let release: (value: SettleResponse) => void = () => {};
    settleImpl = () => {
      settleStarted = true;
      return new Promise((resolve) => (release = resolve));
    };
    const accept = await accepted();
    const controller = new AbortController();
    const pending = paidVerify(accept, controller.signal).catch((error: unknown) => error);
    await waitFor(() => settleStarted);
    controller.abort();
    assert.ok((await pending) instanceof Error, "the client gave up mid-settle");
    // node-server notices the closed socket, then settle succeeds.
    await new Promise((r) => setTimeout(r, 100));
    release({ success: true, transaction: tx, network: NETWORK, payer: PAYER });
    await waitFor(() => listRefundCandidatesFromStore().some((r) => r.payment_id === tx));
    const stored = listRefundCandidatesFromStore().find((r) => r.payment_id === tx)!;
    assert.equal(stored.reason, SETTLED_NO_RESPONSE_REASON);
    assert.equal(stored.protocol, "x402");
    assert.equal(stored.route, "verify");
    assert.equal(stored.payer, PAYER);
    assert.equal(stored.amount_usd, "0.01");
    assert.ok(stored.settled_at);
    assert.equal(stored.responded_at, undefined, "no answer was delivered");
  });

  it("a normal paid 200 is not listed", async () => {
    setFacilitatorTimeoutForTests(null);
    const tx = txHash(0xc3);
    settleImpl = async () => ({ success: true, transaction: tx, network: NETWORK, payer: PAYER });
    const calls = settleCalls;
    const res = await paidVerify(await accepted());
    assert.equal(res.status, 200);
    await res.json();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(settleCalls, calls + 1);
    assert.equal(listRefundCandidatesFromStore().some((r) => r.payment_id === tx), false);
    assert.equal(parsed().some((l) => l.payment_id === tx), false);
  });
});

describe("noteSettledPayment (MPP and x402 delivery watch)", () => {
  const lines: string[] = [];
  before(() => setRefundCandidateWriterForTests((line) => lines.push(line)));
  after(() => setRefundCandidateWriterForTests(null));

  function harness() {
    const app = new Hono();
    app.use(withSettleAbortContext());
    app.post("/v1/verify/job", (c) => {
      noteSettledPayment({
        protocol: "mpp_tempo",
        payment_id: txHash(0xd4),
        payer: PAYER,
        amount_usd: "0.01",
        settled_at: "2026-11-04T18:00:00Z",
      });
      return c.json({ ok: true });
    });
    return app;
  }

  it("lists an MPP payment when the caller is already gone, once", async () => {
    lines.length = 0;
    const controller = new AbortController();
    controller.abort();
    await harness().request(new Request("http://x/v1/verify/job", { method: "POST", signal: controller.signal }));
    const found = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    assert.equal(found.length, 1);
    assert.equal(found[0]!.reason, SETTLED_NO_RESPONSE_REASON);
    assert.equal(found[0]!.protocol, "mpp_tempo");
    assert.equal(found[0]!.route, "verify/job");
    assert.equal(found[0]!.amount_usd, "0.01");
    assert.equal(found[0]!.payer, PAYER);
  });

  it("lists it when the caller leaves after settlement, and not when it stays", async () => {
    lines.length = 0;
    const stays = new AbortController();
    await harness().request(new Request("http://x/v1/verify/job", { method: "POST", signal: stays.signal }));
    assert.equal(lines.length, 0);

    const leaves = new AbortController();
    await harness().request(new Request("http://x/v1/verify/job", { method: "POST", signal: leaves.signal }));
    leaves.abort();
    leaves.abort();
    assert.equal(lines.length, 1);
  });
});

describe("usdFromAtomic", () => {
  it("converts 6-decimal atomic amounts", () => {
    assert.equal(usdFromAtomic("10000"), "0.01");
    assert.equal(usdFromAtomic("20000"), "0.02");
    assert.equal(usdFromAtomic("2500000"), "2.5");
    assert.equal(usdFromAtomic("1000000"), "1");
    assert.equal(usdFromAtomic("0"), "0");
    assert.equal(usdFromAtomic("abc"), undefined);
    assert.equal(usdFromAtomic(undefined), undefined);
  });
});
