import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CHECK_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_ATOMIC_USDC,
  MOCK_PAY_TO,
  PRICE_ATOMIC_USDC,
  WATCH_MAX_ACTIVE_PER_WALLET,
  WATCH_PAYMENT_DESCRIPTION,
  WATCH_PRICE_ATOMIC_USDC,
  WATCH_PRICE_USD,
} from "../src/config.js";
import { isCheckId, isOwnerToken, isWatchId } from "../src/confirm-id.js";
import { observationHash } from "../src/check.js";
import {
  generateReceiptPrivateKeyPem,
  resetReceiptSignerCache,
} from "../src/receipt.js";
import { decodePaymentRequired } from "../src/x402-payload.js";
import { checksRemainingForInterval, jitteredDelayMs, parseWatchRequest, WatchError } from "../src/watch.js";
import { tickDueWatchers } from "../src/watch-scheduler.js";
import {
  closeWatchStore,
  countActiveStandardWatchers,
  initWatchStore,
  insertWatcher,
  listWatchEvents,
  type WatcherRow,
} from "../src/watch-store.js";

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

function stubWatcher(overrides: Partial<WatcherRow> = {}): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id: overrides.id ?? "wtc_01J8Z0K3N4P5Q6R7S8T9V0WAAA",
    payer: overrides.payer ?? MOCK_PAY_TO.toLowerCase(),
    owner_token_hash: overrides.owner_token_hash ?? "aa".repeat(32),
    status: overrides.status ?? "active",
    tier: "standard",
    target_url: overrides.target_url ?? "https://example.com/jobs/1",
    target: overrides.target ?? { type: "url", url: "https://example.com/jobs/1", render: "never", selector: null },
    condition: overrides.condition ?? { detector: "status_change", params: {} },
    condition_key: overrides.condition_key ?? "bb".repeat(32),
    interval_s: overrides.interval_s ?? 900,
    checks_remaining: overrides.checks_remaining ?? 2880,
    expires_at: overrides.expires_at ?? "2026-10-10T18:00:00Z",
    first_check_at: overrides.first_check_at ?? now,
    next_check_at: overrides.next_check_at ?? now,
    baseline: overrides.baseline ?? { captured: true, hash: observationHash("live", "2xx"), summary: "live 2xx (200)" },
    last_observation: overrides.last_observation ?? null,
    callback_url: overrides.callback_url ?? "https://example.com/hooks/livecheck",
    callback_secret: overrides.callback_secret ?? "whsec_test",
    callback_deliver: "on_change",
    run: "none",
    chain_budget_usd: null,
    chain_balance_atomic: 0,
    chain_spent_atomic: 0,
    label: null,
    context_json: null,
    created_at: now,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {},
    ...overrides,
  };
}

describe("watch parsers", () => {
  it("defaults interval and accepts on_change / every_check / chain_budget_usd", () => {
    const parsed = parseWatchRequest({
      target: { type: "url", url: "https://example.com/job", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
      chain_budget_usd: 5,
      on_change: { run: "verify" },
    });
    assert.equal(parsed.interval_s, 900);
    assert.equal(parsed.callback.deliver, "on_change");
    assert.equal(parsed.chain_budget_usd, 5);
    assert.equal(parsed.run, "verify");
    const every = parseWatchRequest({
      target: { type: "url", url: "https://example.com/job", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x", deliver: "every_check" },
    });
    assert.equal(every.callback.deliver, "every_check");
    assert.equal(checksRemainingForInterval(900), 2880);
    assert.equal(checksRemainingForInterval(300), 2880);
  });

  it("rejects render always as render_not_available", () => {
    assert.throws(
      () =>
        parseWatchRequest({
          target: { type: "url", url: "https://example.com", render: "always" },
          condition: { detector: "status_change" },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
        }),
      (error: unknown) =>
        error instanceof WatchError && error.code === "render_not_available" && error.use === "/v1/watch/fast",
    );
  });

  it("rejects invalid target and condition", () => {
    assert.throws(
      () =>
        parseWatchRequest({
          target: { type: "url", url: "ftp://example.com", render: "never" },
          condition: { detector: "status_change" },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
        }),
      (error: unknown) => error instanceof WatchError && error.code === "invalid_target",
    );
    assert.throws(
      () =>
        parseWatchRequest({
          target: { type: "url", url: "https://example.com", render: "never" },
          condition: { detector: "css" },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
        }),
      (error: unknown) => error instanceof WatchError && error.code === "invalid_condition",
    );
    const textDiff = parseWatchRequest({
      target: { type: "url", url: "https://example.com", render: "never" },
      condition: { detector: "text_diff", params: { selector: "h1", min_change_ratio: 0.05 } },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
    });
    assert.equal(textDiff.condition.detector, "text_diff");
    const numeric = parseWatchRequest({
      target: { type: "url", url: "https://example.com", render: "never" },
      condition: { detector: "numeric_threshold", params: { selector: ".price", op: "lt", value: 1000 } },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
    });
    assert.equal(numeric.condition.detector, "numeric_threshold");
  });

  it("jitter stays within ±10%", () => {
    const delay = jitteredDelayMs(1000, () => 0);
    assert.equal(delay, 900_000);
    const high = jitteredDelayMs(1000, () => 0.999999);
    assert.ok(high <= 1_100_000);
    assert.ok(high >= 900_000);
  });
});

describe("POST /v1/watch HTTP", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
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
  });

  it("unpaid watch is 402 with one accept at 2500000", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(watchBody("https://example.com/jobs/1")),
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
    assert.ok(resource.url?.endsWith("/v1/watch"));
    assert.equal(resource.description, WATCH_PAYMENT_DESCRIPTION);
    assert.equal(isAscii(WATCH_PAYMENT_DESCRIPTION), true);
    assert.doesNotMatch(WATCH_PAYMENT_DESCRIPTION, /[^\x00-\x7F]/);
  });

  it("verify, check, and confirm unpaid 402s stay single-price (regression)", async () => {
    const verify = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(verify.status, 402);
    const verifyDecoded = decodePaymentRequired(verify.headers.get("payment-required") ?? "");
    assert.equal((verifyDecoded.accepts as Array<{ amount?: string }>).length, 1);
    assert.equal((verifyDecoded.accepts as Array<{ amount?: string }>)[0]?.amount, PRICE_ATOMIC_USDC);

    const check = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
    });
    assert.equal(check.status, 402);
    const checkDecoded = decodePaymentRequired(check.headers.get("payment-required") ?? "");
    assert.equal((checkDecoded.accepts as Array<{ amount?: string }>)[0]?.amount, CHECK_PRICE_ATOMIC_USDC);

    const confirm = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thank-you", intent: "lead_submit" }),
    });
    assert.equal(confirm.status, 402);
    const confirmDecoded = decodePaymentRequired(confirm.headers.get("payment-required") ?? "");
    assert.equal((confirmDecoded.accepts as Array<{ amount?: string }>)[0]?.amount, CONFIRM_PRICE_ATOMIC_USDC);
  });

  it("mock-paid create is 201 with owner_token and captured baseline", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody(`${origin}/fixtures/live-apply-now`)),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      id: string;
      tier: string;
      owner_token: string;
      baseline: { captured: boolean; hash?: string; summary?: string };
      price_usd: number;
      checks_remaining: number;
      interval_s: number;
      run: string;
      receipt: { hash: string; verify_url: string };
    };
    assert.equal(isWatchId(body.id), true);
    assert.equal(isCheckId(body.id), false);
    assert.equal(isOwnerToken(body.owner_token), true);
    assert.equal(body.tier, "standard");
    assert.equal(body.baseline.captured, true);
    assert.equal(body.baseline.hash, observationHash("live", "2xx"));
    assert.match(body.baseline.summary ?? "", /live 2xx/);
    assert.equal(body.price_usd, 2.5);
    assert.equal(body.interval_s, 900);
    assert.equal(body.checks_remaining, 2880);
    assert.equal(body.run, "none");
    assert.equal(body.receipt.hash.length, 64);
    assert.ok(body.receipt.verify_url.includes(body.id));
  });

  it("GET/DELETE require a good owner token", async () => {
    const created = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody(`${origin}/fixtures/closed-to-new-applications`)),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as { id: string; owner_token: string };
    const missing = await fetch(`${origin}/v1/watch/${body.id}`);
    assert.equal(missing.status, 401);
    const bad = await fetch(`${origin}/v1/watch/${body.id}`, {
      headers: { "x-livecheck-owner-token": "owt_01AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(bad.status, 403);
    const good = await fetch(`${origin}/v1/watch/${body.id}`, {
      headers: { "x-livecheck-owner-token": body.owner_token },
    });
    assert.equal(good.status, 200);
    const view = (await good.json()) as { id: string; owner_token?: string; status: string };
    assert.equal(view.id, body.id);
    assert.equal(view.owner_token, undefined);
    assert.equal(view.status, "active");

    const badDel = await fetch(`${origin}/v1/watch/${body.id}`, {
      method: "DELETE",
      headers: { "x-livecheck-owner-token": "owt_01AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(badDel.status, 403);
    const del = await fetch(`${origin}/v1/watch/${body.id}`, {
      method: "DELETE",
      headers: { "x-livecheck-owner-token": body.owner_token },
    });
    assert.equal(del.status, 200);
    const stopped = (await del.json()) as { status: string; refund: boolean };
    assert.equal(stopped.status, "stopped");
    assert.equal(stopped.refund, false);
  });

  it("duplicate active watcher is 409 duplicate_watch", async () => {
    const url = `${origin}/fixtures/live-apply-now`;
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const first = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify(watchBody(url, { label: "dup-a" })),
    });
    // first create in this describe already used live-apply-now — expect 409 or 201 then 409
    const firstBody = (await first.json()) as { id?: string; error?: string };
    const firstId = first.status === 201 ? firstBody.id : firstBody.id;
    const second = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify(watchBody(url, { label: "dup-b" })),
    });
    assert.equal(second.status, 409);
    const dup = (await second.json()) as { error?: string; id?: string };
    assert.equal(dup.error, "duplicate_watch");
    assert.ok(dup.id?.startsWith("wtc_"));
    if (firstId) assert.equal(dup.id, firstId);
  });

  it("invalid target/condition and render always", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const badTarget = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify(watchBody("ftp://example.com")),
    });
    assert.equal(badTarget.status, 400);
    assert.equal(((await badTarget.json()) as { error?: string }).error, "invalid_target");

    const badCondition = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never" },
        condition: { detector: "keyword", params: { any: "Apply Now" } },
        callback: { url: "https://example.com/hook", secret: "whsec_x" },
      }),
    });
    assert.equal(badCondition.status, 400);
    assert.equal(((await badCondition.json()) as { error?: string }).error, "invalid_condition");

    const render = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "always" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hook", secret: "whsec_x" },
      }),
    });
    assert.equal(render.status, 400);
    const renderBody = (await render.json()) as { error?: string; use?: string };
    assert.equal(renderBody.error, "render_not_available");
    assert.equal(renderBody.use, "/v1/watch/fast");
  });

  it("accepts text_diff and numeric_threshold on create", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const textDiff = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "text_diff", params: { selector: "h1" } },
        callback: { url: "https://example.com/hook-text", secret: "whsec_x" },
        interval_s: 900,
      }),
    });
    assert.equal(textDiff.status, 201);
    const textBody = (await textDiff.json()) as { condition: { detector: string }; baseline: { captured: boolean } };
    assert.equal(textBody.condition.detector, "text_diff");
    assert.equal(textBody.baseline.captured, true);

    const numeric = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "numeric_threshold", params: { selector: ".price", op: "lt", value: 2000 } },
        callback: { url: "https://example.com/hook-num", secret: "whsec_x" },
        interval_s: 900,
      }),
    });
    assert.equal(numeric.status, 201);
    assert.equal(((await numeric.json()) as { condition: { detector: string } }).condition.detector, "numeric_threshold");
  });

  it("unreachable baseline is 201 captured=false, never 422", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody("http://127.0.0.1:1/no-listener")),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as { baseline: { captured: boolean } };
    assert.equal(body.baseline.captured, false);
  });
});

describe("POST /v1/watch receipt + rate limit + scheduler", () => {
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

  it("signs wtc_ receipts and GET /v1/receipt/{id} resolves them", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(watchBody(`${origin}/fixtures/live-apply-now`)),
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      id: string;
      receipt: { signature?: string; signer?: string };
    };
    assert.equal(isWatchId(body.id), true);
    assert.ok(body.receipt.signature);
    assert.equal(body.receipt.signer, "livecheck-confirm-v1");

    const lookup = await fetch(`${origin}/v1/receipt/${body.id}`);
    assert.equal(lookup.status, 200);
    const stored = (await lookup.json()) as {
      intent: string;
      verify: { signed?: boolean; valid?: boolean | null };
    };
    assert.equal(stored.intent, "watch");
    assert.equal(stored.verify.signed, true);
    assert.equal(stored.verify.valid, true);
  });

  it("soft-caps 200 active standard watchers per wallet", async () => {
    const payer = "0x1111111111111111111111111111111111111111";
    for (let i = 0; i < WATCH_MAX_ACTIVE_PER_WALLET; i += 1) {
      insertWatcher(
        stubWatcher({
          id: `wtc_01J8Z0K3N4P5Q6R7S8T9V${String(i).padStart(3, "0")}`,
          payer,
          target_url: `https://example.com/jobs/${i}`,
          target: { type: "url", url: `https://example.com/jobs/${i}`, render: "never", selector: null },
          condition_key: `k${i.toString(16).padStart(63, "0")}`,
          next_check_at: "2099-01-01T00:00:00Z",
        }),
      );
    }
    assert.equal(countActiveStandardWatchers(payer), 200);
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-livecheck-mock": "1",
        "x-livecheck-payer": payer,
      },
      body: JSON.stringify(watchBody(`${origin}/fixtures/loginwalled`)),
    });
    assert.equal(res.status, 429);
    const body = (await res.json()) as { error?: string; limit?: number };
    assert.equal(body.error, "rate_limited");
    assert.equal(body.limit, 200);
  });

  it("scheduler runs due watchers, respects host concurrency, and emits change events", async () => {
    const due = "2026-01-01T00:00:00Z";
    const hostUrl = `${origin}/fixtures/live-apply-now`;
    insertWatcher(
      stubWatcher({
        id: "wtc_01SCHEDULER00000000000001",
        payer: "0x2222222222222222222222222222222222222223",
        target_url: hostUrl,
        target: { type: "url", url: hostUrl, render: "never", selector: null },
        condition_key: "scheduler-1".padEnd(64, "0"),
        next_check_at: due,
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
        last_observation: null,
      }),
    );
    insertWatcher(
      stubWatcher({
        id: "wtc_01SCHEDULER00000000000002",
        payer: "0x2222222222222222222222222222222222222224",
        target_url: hostUrl,
        target: { type: "url", url: hostUrl, render: "never", selector: null },
        condition_key: "scheduler-2".padEnd(64, "0"),
        next_check_at: due,
      }),
    );
    insertWatcher(
      stubWatcher({
        id: "wtc_01SCHEDULER00000000000003",
        payer: "0x2222222222222222222222222222222222222225",
        target_url: hostUrl,
        target: { type: "url", url: hostUrl, render: "never", selector: null },
        condition_key: "scheduler-3".padEnd(64, "0"),
        next_check_at: due,
      }),
    );

    const hookOk: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/hooks/") || url.includes("example.com/hooks")) {
        return new Response("ok", { status: 200 });
      }
      return fetch(input, init);
    };
    const first = await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), hookOk);
    assert.equal(first.ran, 2);
    assert.equal(first.skipped, 1);
    const second = await tickDueWatchers(new Date("2026-09-10T18:00:01Z"), hookOk);
    assert.ok(first.ran + second.ran >= 3);

    const beforeConfirm = listWatchEvents("wtc_01SCHEDULER00000000000001");
    assert.equal(beforeConfirm.some((event) => event.kind === "change"), false);

    const confirm = await tickDueWatchers(new Date("2026-09-10T18:00:20Z"), hookOk);
    assert.ok(confirm.ran >= 1);
    const events = listWatchEvents("wtc_01SCHEDULER00000000000001");
    assert.ok(events.some((event) => event.kind === "change"));
    assert.equal(events.some((event) => event.kind === "callback_pending"), false);
  });
});
