import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import type { FacilitatorClient } from "@x402/core/server";
import { Hono } from "hono";
import { createApp } from "../src/app.js";
import {
  assertConfirmPaymentCoversIntent,
  atomicFromPaymentSignatureHeader,
  InsufficientConfirmPaymentError,
  rememberVerifiedAtomic,
  resolveConfirmPayment,
  settledAmountGate,
  withConfirmPaymentContext,
  wrapFacilitatorForVerifiedAmount,
} from "../src/confirm-payment.js";
import { NETWORK, ORDER_PLACED_PRICE_ATOMIC_USDC } from "../src/config.js";

function paymentJson(payment: ReturnType<typeof resolveConfirmPayment>): Record<string, unknown> {
  if (payment.kind === "verified") return { kind: "verified", atomic: payment.atomic.toString() };
  return payment;
}

describe("assertConfirmPaymentCoversIntent", () => {
  it("allows mock pay for order_placed", () => {
    assert.doesNotThrow(() => assertConfirmPaymentCoversIntent("order_placed", { kind: "mock" }));
  });

  it("allows verified $0.25 and above for order_placed", () => {
    assert.doesNotThrow(() =>
      assertConfirmPaymentCoversIntent("order_placed", { kind: "verified", atomic: 250000n }),
    );
    assert.doesNotThrow(() =>
      assertConfirmPaymentCoversIntent("order_placed", { kind: "verified", atomic: 250001n }),
    );
  });

  it("rejects underpaid and unknown order_placed with payment_amount_insufficient", () => {
    assert.throws(
      () => assertConfirmPaymentCoversIntent("order_placed", { kind: "verified", atomic: 100000n }),
      (error: unknown) =>
        error instanceof InsufficientConfirmPaymentError &&
        error.status === 402 &&
        error.code === "payment_amount_insufficient" &&
        error.paid_atomic === "100000",
    );
    assert.throws(
      () => assertConfirmPaymentCoversIntent("order_placed", { kind: "unknown" }),
      InsufficientConfirmPaymentError,
    );
  });

  it("does not re-check lead_submit or listing_published", () => {
    assert.doesNotThrow(() =>
      assertConfirmPaymentCoversIntent("lead_submit", { kind: "verified", atomic: 100000n }),
    );
    assert.doesNotThrow(() =>
      assertConfirmPaymentCoversIntent("listing_published", { kind: "verified", atomic: 100000n }),
    );
    assert.doesNotThrow(() => assertConfirmPaymentCoversIntent("lead_submit", { kind: "unknown" }));
  });
});

describe("atomicFromPaymentSignatureHeader", () => {
  it("reads accepted.amount from JSON or base64 PAYMENT-SIGNATURE", () => {
    const envelope = { x402Version: 2, accepted: { amount: "100000" } };
    assert.equal(atomicFromPaymentSignatureHeader(JSON.stringify(envelope)), 100000n);
    assert.equal(
      atomicFromPaymentSignatureHeader(Buffer.from(JSON.stringify(envelope), "utf8").toString("base64")),
      100000n,
    );
    assert.equal(atomicFromPaymentSignatureHeader("livecheck-dev"), null);
    assert.equal(atomicFromPaymentSignatureHeader("not-json"), null);
  });
});

describe("wrapFacilitatorForVerifiedAmount", () => {
  it("records requirements.amount onto the confirm-payment ALS", async () => {
    const inner = {
      async getSupported() {
        return { kinds: [], extensions: [], signers: {} };
      },
      async verify() {
        return { isValid: true };
      },
      async settle() {
        return { success: true, transaction: "0xabc", network: NETWORK };
      },
    } satisfies FacilitatorClient;
    const wrapped = wrapFacilitatorForVerifiedAmount(inner);
    const app = new Hono();
    app.use(withConfirmPaymentContext());
    app.post("/probe", async (c) => {
      await wrapped.verify(
        { x402Version: 2, accepted: { amount: "100000" }, payload: {} } as never,
        { amount: "100000" } as never,
      );
      return c.json(paymentJson(resolveConfirmPayment({ get: () => null })));
    });
    const res = await app.request("/probe", { method: "POST" });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { kind: "verified", atomic: "100000" });
  });
});

describe("underpaid order_placed HTTP", () => {
  const underpaid = createApp(settledAmountGate("100000"));
  const paid25 = createApp(settledAmountGate(ORDER_PLACED_PRICE_ATOMIC_USDC));
  let underOrigin = "";
  let paidOrigin = "";
  let closeUnder: () => void = () => {};
  let closePaid: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: underpaid.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        underOrigin = `http://127.0.0.1:${info.port}`;
        closeUnder = () => server.close();
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: paid25.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        paidOrigin = `http://127.0.0.1:${info.port}`;
        closePaid = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    closeUnder();
    closePaid();
  });

  it("rejects order_placed on /v1/confirm with 400 unsupported_intent (underpay gate unused)", async () => {
    const res = await fetch(`${underOrigin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${underOrigin}/fixtures/confirm/order-thank-you-id`,
        intent: "order_placed",
      }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error?: string; intent?: string; use?: string };
    assert.equal(body.error, "unsupported_intent");
    assert.equal(body.intent, "order_placed");
    assert.equal(body.use, "/v1/confirm/order");
  });

  it("still runs lead_submit and listing_published after a $0.10 settle", async () => {
    const lead = await fetch(`${underOrigin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${underOrigin}/fixtures/confirm/thank-you-id`,
        intent: "lead_submit",
      }),
    });
    assert.equal(lead.status, 200);
    assert.equal(((await lead.json()) as { effect: { type: string } }).effect.type, "lead_submit");

    const listing = await fetch(`${underOrigin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${underOrigin}/fixtures/products/ridge-wallet`,
        intent: "listing_published",
      }),
    });
    assert.equal(listing.status, 200);
    assert.equal(((await listing.json()) as { effect: { type: string } }).effect.type, "listing_published");
  });

  it("accepts order_placed on /v1/confirm/order after a $0.25 settle", async () => {
    const res = await fetch(`${paidOrigin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: `${paidOrigin}/fixtures/confirm/order-thank-you-id`,
        intent: "order_placed",
      }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { verdict: string; price_usd: number };
    assert.equal(body.verdict, "confirmed");
    assert.equal(body.price_usd, 0.25);
  });
});

describe("rememberVerifiedAtomic is request-scoped", () => {
  it("does not leak across ALS runs", async () => {
    const app = new Hono();
    app.use(withConfirmPaymentContext());
    app.get("/a", (c) => {
      rememberVerifiedAtomic("100000");
      return c.json(paymentJson(resolveConfirmPayment({ get: () => null })));
    });
    app.get("/b", (c) => {
      return c.json(paymentJson(resolveConfirmPayment({ get: () => null })));
    });
    const a = await app.request("/a");
    const b = await app.request("/b");
    assert.deepEqual(await a.json(), { kind: "verified", atomic: "100000" });
    assert.deepEqual(await b.json(), { kind: "unknown" });
  });
});
