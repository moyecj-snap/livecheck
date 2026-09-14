import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  WATCH_PRICE_ATOMIC_USDC,
  WATCH_PRICE_USD,
  WATCH_RENEW_PAYMENT_DESCRIPTION,
  WATCH_TERM_DAYS,
} from "../src/config.js";
import { isOwnerToken, isWatchId, isWatchRenewId } from "../src/confirm-id.js";
import { generateReceiptPrivateKeyPem, resetReceiptSignerCache } from "../src/receipt.js";
import { parseWatchRenewRequest, WatchError } from "../src/watch.js";
import { closeWatchStore, getWatcher, initWatchStore, stopWatcher } from "../src/watch-store.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

function isAscii(value: string): boolean {
  return [...value].every((ch) => ch.charCodeAt(0) < 128);
}

function watchBody(url: string, extras: Record<string, unknown> = {}) {
  return {
    target: { type: "url", url, render: "never", selector: null },
    condition: { detector: "status_change", params: {} },
    callback: { url: "https://example.com/hooks/livecheck", secret: "whsec_test", deliver: "on_change" },
    interval_s: 900,
    ...extras,
  };
}

describe("watch renew parser", () => {
  it("requires { id } as a watcher id", () => {
    assert.throws(
      () => parseWatchRenewRequest({}),
      (error: unknown) => error instanceof WatchError && error.code === "invalid_id",
    );
    assert.throws(
      () => parseWatchRenewRequest({ id: "not-a-watch-id" }),
      (error: unknown) => error instanceof WatchError && error.code === "invalid_id",
    );
    const parsed = parseWatchRenewRequest({ id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC" });
    assert.equal(parsed.id, "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC");
  });
});

describe("POST /v1/watch/renew HTTP", () => {
  const pem = generateReceiptPrivateKeyPem();
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  let previous: string | undefined;

  before(async () => {
    previous = process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    process.env.CONFIRM_RECEIPT_PRIVATE_KEY = pem;
    resetReceiptSignerCache();
    initWatchStore(":memory:");
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
    closeWatchStore();
    if (previous === undefined) delete process.env.CONFIRM_RECEIPT_PRIVATE_KEY;
    else process.env.CONFIRM_RECEIPT_PRIVATE_KEY = previous;
    resetReceiptSignerCache();
  });

  it("unpaid renew is 402 with one accept at 2500000", async () => {
    const res = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0WWTC" }),
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
    assert.equal(accepts[0]?.amount, WATCH_PRICE_ATOMIC_USDC);
    assert.equal(accepts[0]?.amount, "2500000");
    assert.equal(WATCH_PRICE_USD, 2.5);
    assert.equal(accepts[0]?.scheme, "exact");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
    const resource = decoded.resource as { url?: string; description?: string };
    assert.ok(resource.url?.endsWith("/v1/watch/renew"));
    assert.equal(resource.url?.includes("{"), false);
    assert.equal(resource.description, WATCH_RENEW_PAYMENT_DESCRIPTION);
    assert.equal(isAscii(WATCH_RENEW_PAYMENT_DESCRIPTION), true);
  });

  it("mock-paid renew extends window and returns create-shaped receipt", async () => {
    const created = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody(`${origin}/fixtures/live-apply-now`, { label: "renew-me" })),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      owner_token: string;
      expires_at: string;
      checks_remaining: number;
      interval_s: number;
      first_check_at: string;
      baseline: { captured: boolean };
      target: { url: string };
      condition: { detector: string };
      price_usd: number;
      run: string;
      receipt: { hash: string; verify_url: string };
    };
    assert.equal(isWatchId(body.id), true);
    assert.equal(isOwnerToken(body.owner_token), true);
    const createdExpiry = Date.parse(body.expires_at);
    const createdChecks = body.checks_remaining;

    const missing = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ id: body.id }),
    });
    assert.equal(missing.status, 401);

    const bad = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "x-livecheck-owner-token": "owt_01AAAAAAAAAAAAAAAAAAAAAAAA",
      },
      body: JSON.stringify({ id: body.id }),
    });
    assert.equal(bad.status, 403);

    const unknown = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "x-livecheck-owner-token": body.owner_token,
      },
      body: JSON.stringify({ id: "wtc_01J8Z0K3N4P5Q6R7S8T9V0GONE" }),
    });
    assert.equal(unknown.status, 404);

    const paid = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "x-livecheck-owner-token": body.owner_token,
      },
      body: JSON.stringify({ id: body.id }),
    });
    assert.equal(paid.status, 200);
    const renewed = (await paid.json()) as {
      id: string;
      owner_token?: string;
      tier: string;
      status: string;
      expires_at: string;
      checks_remaining: number;
      interval_s: number;
      first_check_at: string;
      next_check_at: string;
      baseline: { captured: boolean };
      target: { url: string };
      condition: { detector: string };
      price_usd: number;
      run: string;
      on_change: { run: string };
      receipt: { hash: string; verify_url: string; signature?: string; signer?: string };
      label?: string;
    };
    assert.equal(renewed.id, body.id);
    assert.equal(renewed.owner_token, undefined);
    assert.equal(renewed.tier, "standard");
    assert.equal(renewed.status, "active");
    assert.equal(renewed.price_usd, 2.5);
    assert.equal(renewed.interval_s, body.interval_s);
    assert.equal(renewed.first_check_at, body.first_check_at);
    assert.equal(renewed.baseline.captured, body.baseline.captured);
    assert.equal(renewed.target.url, body.target.url);
    assert.equal(renewed.condition.detector, body.condition.detector);
    assert.equal(renewed.label, "renew-me");
    assert.equal(renewed.checks_remaining, createdChecks + createdChecks);
    const addedMs = Date.parse(renewed.expires_at) - createdExpiry;
    assert.ok(Math.abs(addedMs - WATCH_TERM_DAYS * 86_400_000) < 2_000);
    assert.equal(renewed.receipt.hash.length, 64);
    const receiptId = renewed.receipt.verify_url.split("/").pop() ?? "";
    assert.equal(isWatchRenewId(receiptId), true);
    assert.ok(renewed.receipt.signature);
    assert.equal(renewed.receipt.signer, "livecheck-confirm-v1");

    const lookup = await fetch(`${origin}/v1/receipt/${receiptId}`);
    assert.equal(lookup.status, 200);
    const stored = (await lookup.json()) as {
      intent: string;
      verdict?: string;
      verify: { signed?: boolean; valid?: boolean | null };
    };
    assert.equal(stored.intent, "watch_renew");
    assert.equal(stored.verify.signed, true);
    assert.equal(stored.verify.valid, true);

    const createLookup = await fetch(`${origin}/v1/receipt/${body.id}`);
    assert.equal(createLookup.status, 200);
    assert.equal(((await createLookup.json()) as { intent: string }).intent, "watch");

    const row = getWatcher(body.id);
    assert.equal(row?.expires_at, renewed.expires_at);
    assert.equal(row?.checks_remaining, renewed.checks_remaining);
    assert.equal(row?.expiring_emitted, false);
  });

  it("stopped watcher cannot be renewed", async () => {
    const created = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody(`${origin}/fixtures/closed-to-new-applications`)),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; owner_token: string };
    assert.equal(stopWatcher(body.id), true);

    const res = await fetch(`${origin}/v1/watch/renew`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "x-livecheck-owner-token": body.owner_token,
      },
      body: JSON.stringify({ id: body.id }),
    });
    assert.equal(res.status, 409);
    assert.equal(((await res.json()) as { error?: string }).error, "not_renewable");
  });
});
