import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { observationHash } from "../src/check.js";
import {
  CHAIN_TOPUP_PAYMENT_DESCRIPTION,
  CHAIN_TOPUP_PRICE_ATOMIC_USDC,
  CHAIN_TOPUP_PRICE_USD,
  CHECK_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_ATOMIC_USDC,
  ORDER_PLACED_PRICE_ATOMIC_USDC,
  PRICE_ATOMIC_USDC,
  WATCH_PRICE_ATOMIC_USDC,
} from "../src/config.js";
import { closeReceiptStore, getConfirmReceipt, initReceiptStore } from "../src/receipt-store.js";
import { hashOwnerToken, parseWatchRequest, WatchError } from "../src/watch.js";
import { tickDueWatchers } from "../src/watch-scheduler.js";
import {
  closeWatchStore,
  creditChainBalance,
  getWatcher,
  initWatchStore,
  insertWatcher,
  listWatchEvents,
  type WatcherRow,
} from "../src/watch-store.js";
import { decodePaymentRequired } from "../src/x402-payload.js";

const OWNER = "owt_01J8Z0K3N4P5Q6R7S8T9V0WOWT";

function isAscii(value: string): boolean {
  return [...value].every((ch) => ch.charCodeAt(0) < 128);
}

function stubWatcher(overrides: Partial<WatcherRow> = {}): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id: overrides.id ?? "wtc_01CHAIN000000000000000001",
    payer: overrides.payer ?? "0x2222222222222222222222222222222222222222",
    owner_token_hash: overrides.owner_token_hash ?? hashOwnerToken(OWNER),
    status: overrides.status ?? "active",
    tier: "standard",
    target_url: overrides.target_url ?? "https://example.com/jobs/1",
    target: overrides.target ?? { type: "url", url: "https://example.com/jobs/1", render: "never", selector: null },
    condition: overrides.condition ?? { detector: "status_change", params: {} },
    condition_key: overrides.condition_key ?? "chain-key".padEnd(64, "0"),
    interval_s: overrides.interval_s ?? 900,
    checks_remaining: overrides.checks_remaining ?? 2880,
    expires_at: overrides.expires_at ?? "2026-10-10T18:00:00Z",
    first_check_at: overrides.first_check_at ?? now,
    next_check_at: overrides.next_check_at ?? now,
    baseline: overrides.baseline ?? { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
    last_observation: overrides.last_observation ?? null,
    callback_url: overrides.callback_url ?? "https://example.com/hooks/livecheck",
    callback_secret: overrides.callback_secret ?? "whsec_test",
    callback_deliver: "on_change",
    run: overrides.run ?? "verify",
    chain_budget_usd: overrides.chain_budget_usd ?? 5,
    chain_balance_atomic: overrides.chain_balance_atomic ?? 0,
    chain_spent_atomic: overrides.chain_spent_atomic ?? 0,
    label: null,
    context_json: overrides.context_json ?? JSON.stringify({ listing_id: "job-1" }),
    created_at: now,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {},
    ...overrides,
  };
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

describe("chain topup + on_change.verify", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    initWatchStore(":memory:");
    initReceiptStore(":memory:");
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
    closeReceiptStore();
  });

  it("accepts confirm on_change.run with default lead_submit and stores verify + budget as a cap", () => {
    const confirm = parseWatchRequest({
      target: { type: "url", url: "https://example.com/job", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
      on_change: { run: "confirm" },
    });
    assert.equal(confirm.run, "confirm");
    assert.equal(confirm.chain_confirm?.intent, "lead_submit");
    assert.equal(confirm.chain_confirm?.url, null);

    const order = parseWatchRequest({
      target: { type: "url", url: "https://example.com/job", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
      on_change: { run: "confirm", intent: "order_placed", url: "https://example.com/thanks" },
    });
    assert.equal(order.chain_confirm?.intent, "order_placed");
    assert.equal(order.chain_confirm?.url, "https://example.com/thanks");

    assert.throws(
      () =>
        parseWatchRequest({
          target: { type: "url", url: "https://example.com/job", render: "never" },
          condition: { detector: "status_change", params: {} },
          callback: { url: "https://example.com/hook", secret: "whsec_x" },
          on_change: { run: "verify", intent: "lead_submit" },
        }),
      (error: unknown) => error instanceof WatchError && error.code === "invalid_target",
    );

    const parsed = parseWatchRequest({
      target: { type: "url", url: "https://example.com/job", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: "whsec_x" },
      on_change: { run: "verify" },
      chain_budget_usd: 5,
    });
    assert.equal(parsed.run, "verify");
    assert.equal(parsed.chain_budget_usd, 5);
    assert.equal(parsed.chain_confirm, null);
  });

  it("unpaid topup is 402 with one accept at 500000", async () => {
    const res = await fetch(`${origin}/v1/watch/wtc_01CHAINUNPAID00000000001/chain/topup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
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
    assert.equal(accepts[0]?.amount, CHAIN_TOPUP_PRICE_ATOMIC_USDC);
    assert.equal(accepts[0]?.amount, "500000");
    assert.equal(CHAIN_TOPUP_PRICE_USD, 0.5);
    assert.equal(accepts[0]?.scheme, "exact");
    assert.deepEqual(accepts[0]?.extra, { name: "USD Coin", version: "2" });
    const resource = decoded.resource as { url?: string; description?: string };
    assert.ok(resource.url?.endsWith("/v1/watch/wtc_01CHAINUNPAID00000000001/chain/topup"));
    assert.equal(resource.description, CHAIN_TOPUP_PAYMENT_DESCRIPTION);
    assert.equal(isAscii(CHAIN_TOPUP_PAYMENT_DESCRIPTION), true);
  });

  it("watch/check/verify unpaid 402s stay single-price (regression)", async () => {
    const watch = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(watchBody("https://example.com/jobs/1")),
    });
    assert.equal(watch.status, 402);
    const watchDecoded = decodePaymentRequired(watch.headers.get("payment-required") ?? "");
    assert.equal((watchDecoded.accepts as Array<{ amount?: string }>).length, 1);
    assert.equal((watchDecoded.accepts as Array<{ amount?: string }>)[0]?.amount, WATCH_PRICE_ATOMIC_USDC);

    const check = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com", render: "never" },
        condition: { detector: "status_change", params: {} },
      }),
    });
    assert.equal(check.status, 402);
    assert.equal(
      (decodePaymentRequired(check.headers.get("payment-required") ?? "").accepts as Array<{ amount?: string }>)[0]
        ?.amount,
      CHECK_PRICE_ATOMIC_USDC,
    );

    const verify = await fetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    assert.equal(verify.status, 402);
    assert.equal(
      (decodePaymentRequired(verify.headers.get("payment-required") ?? "").accepts as Array<{ amount?: string }>)[0]
        ?.amount,
      PRICE_ATOMIC_USDC,
    );

    const confirm = await fetch(`${origin}/v1/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/thanks", intent: "lead_submit" }),
    });
    assert.equal(confirm.status, 402);
    const confirmAccepts = decodePaymentRequired(confirm.headers.get("payment-required") ?? "").accepts as Array<{
      amount?: string;
    }>;
    assert.equal(confirmAccepts.length, 1);
    assert.equal(confirmAccepts[0]?.amount, CONFIRM_PRICE_ATOMIC_USDC);

    const order = await fetch(`${origin}/v1/confirm/order`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com/order", intent: "order_placed" }),
    });
    assert.equal(order.status, 402);
    const orderAccepts = decodePaymentRequired(order.headers.get("payment-required") ?? "").accepts as Array<{
      amount?: string;
    }>;
    assert.equal(orderAccepts.length, 1);
    assert.equal(orderAccepts[0]?.amount, ORDER_PLACED_PRICE_ATOMIC_USDC);
  });

  it("mock-paid topup requires owner token and increases balance by $0.50", async () => {
    const created = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(
        watchBody(`${origin}/fixtures/live-apply-now`, {
          on_change: { run: "verify" },
          chain_budget_usd: 5,
          label: "chain-topup",
        }),
      ),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      owner_token: string;
      run: string;
      on_change?: { run?: string };
      chain_budget_usd?: number | null;
      chain_balance_usd?: number;
    };
    assert.equal(body.run, "verify");
    assert.equal(body.on_change?.run, "verify");
    assert.equal(body.chain_budget_usd, 5);
    assert.equal(body.chain_balance_usd, 0);

    const missing = await fetch(`${origin}/v1/watch/${body.id}/chain/topup`, {
      method: "POST",
      headers: { "x-livecheck-mock": "1" },
    });
    assert.equal(missing.status, 401);

    const bad = await fetch(`${origin}/v1/watch/${body.id}/chain/topup`, {
      method: "POST",
      headers: { "x-livecheck-mock": "1", "x-livecheck-owner-token": "owt_01AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(bad.status, 403);

    const paid = await fetch(`${origin}/v1/watch/${body.id}/chain/topup`, {
      method: "POST",
      headers: { "x-livecheck-mock": "1", "x-livecheck-owner-token": body.owner_token },
    });
    assert.equal(paid.status, 200);
    const topup = (await paid.json()) as {
      id: string;
      added_usd: number;
      chain_balance_usd: number;
      price_usd: number;
      run: string;
    };
    assert.equal(topup.id, body.id);
    assert.equal(topup.added_usd, 0.5);
    assert.equal(topup.chain_balance_usd, 0.5);
    assert.equal(topup.price_usd, 0.5);
    assert.equal(topup.run, "verify");
    assert.equal(getWatcher(body.id)?.chain_balance_atomic, 500_000);

    const again = await fetch(`${origin}/v1/watch/${body.id}/chain/topup`, {
      method: "POST",
      headers: { "x-livecheck-mock": "1", "x-livecheck-owner-token": body.owner_token },
    });
    assert.equal(again.status, 200);
    assert.equal(((await again.json()) as { chain_balance_usd: number }).chain_balance_usd, 1);
  });

  it("change with verify + balance debits and attaches result; insufficient skips", async () => {
    const fundedId = "wtc_01CHAINFUNDED000000000001";
    const skippedId = "wtc_01CHAINSKIPPED00000000001";
    const liveUrl = `${origin}/fixtures/live-apply-now`;
    insertWatcher(
      stubWatcher({
        id: fundedId,
        payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        condition_key: "chain-funded".padEnd(64, "0"),
        target_url: liveUrl,
        target: { type: "url", url: liveUrl, render: "never", selector: null },
        run: "verify",
        chain_budget_usd: 5,
        chain_balance_atomic: 500_000,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
      }),
    );
    insertWatcher(
      stubWatcher({
        id: skippedId,
        payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        condition_key: "chain-skip".padEnd(64, "0"),
        target_url: liveUrl,
        target: { type: "url", url: liveUrl, render: "never", selector: null },
        run: "verify",
        chain_budget_usd: 5,
        chain_balance_atomic: 0,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
      }),
    );

    const hookOk: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/hooks/") || url.includes("example.com/hooks")) {
        return new Response("ok", { status: 200 });
      }
      assert.doesNotMatch(url, /\/v1\/verify/);
      return fetch(input, init);
    };

    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), hookOk);
    assert.equal(listWatchEvents(fundedId).some((event) => event.kind === "change"), false);
    await tickDueWatchers(new Date("2026-09-10T18:00:20Z"), hookOk);

    const fundedEvents = listWatchEvents(fundedId).filter((event) => event.kind === "change");
    assert.equal(fundedEvents.length, 1);
    const fundedPayload = JSON.parse(fundedEvents[0]?.payload_json ?? "{}") as {
      type: string;
      diff: { changed: string[] };
      chain: {
        run?: string;
        skipped?: string;
        result?: { status?: string; price_usd?: number; url?: string };
        receipt?: { hash?: string; verify_url?: string };
        debit_usd?: number;
      };
    };
    assert.equal(fundedPayload.type, "change");
    assert.ok(fundedPayload.diff.changed.length > 0);
    assert.equal(fundedPayload.chain.skipped, undefined);
    assert.equal(fundedPayload.chain.run, "verify");
    assert.equal(fundedPayload.chain.result?.status, "live");
    assert.equal(fundedPayload.chain.result?.price_usd, 0.01);
    assert.equal(fundedPayload.chain.debit_usd, 0.01);
    assert.equal(fundedPayload.chain.receipt?.hash?.length, 64);
    assert.ok(fundedPayload.chain.receipt?.verify_url?.includes(fundedEvents[0]?.id ?? ""));
    assert.equal(getWatcher(fundedId)?.chain_balance_atomic, 490_000);
    assert.equal(getWatcher(fundedId)?.chain_spent_atomic, 10_000);

    const skippedEvents = listWatchEvents(skippedId).filter((event) => event.kind === "change");
    assert.equal(skippedEvents.length, 1);
    const skippedPayload = JSON.parse(skippedEvents[0]?.payload_json ?? "{}") as {
      diff: { changed: string[] };
      chain: { skipped?: string; run?: string; result?: unknown };
    };
    assert.ok(skippedPayload.diff.changed.length > 0);
    assert.equal(skippedPayload.chain.skipped, "insufficient_balance");
    assert.equal(skippedPayload.chain.result, undefined);
    assert.equal(getWatcher(skippedId)?.chain_balance_atomic, 0);
  });

  it("mock-paid watch create stores on_change.confirm + default intent", async () => {
    const created = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify(
        watchBody(`${origin}/fixtures/confirm/thank-you-id`, {
          on_change: { run: "confirm" },
          chain_budget_usd: 5,
          label: "chain-confirm",
        }),
      ),
    });
    assert.equal(created.status, 201);
    const body = (await created.json()) as {
      id: string;
      owner_token: string;
      run: string;
      on_change?: { run?: string; intent?: string };
    };
    assert.equal(body.run, "confirm");
    assert.equal(body.on_change?.run, "confirm");
    assert.equal(body.on_change?.intent, "lead_submit");

    const viewed = await fetch(`${origin}/v1/watch/${body.id}`, {
      headers: { "x-livecheck-owner-token": body.owner_token },
    });
    assert.equal(viewed.status, 200);
    const view = (await viewed.json()) as { run?: string; on_change?: { run?: string; intent?: string } };
    assert.equal(view.run, "confirm");
    assert.equal(view.on_change?.intent, "lead_submit");
  });

  it("change with confirm + balance debits, writes receipts.sqlite, and skips when unpaid", async () => {
    const fundedId = "wtc_01CHAINCONFIRMFUND00000001";
    const skippedId = "wtc_01CHAINCONFIRMSKIP0000001";
    const thanksUrl = `${origin}/fixtures/confirm/thank-you-id`;
    insertWatcher(
      stubWatcher({
        id: fundedId,
        payer: "0xdddddddddddddddddddddddddddddddddddddddd",
        condition_key: "chain-confirm-funded".padEnd(64, "0"),
        target_url: thanksUrl,
        target: { type: "url", url: thanksUrl, render: "never", selector: null },
        run: "confirm",
        chain_confirm: { intent: "lead_submit", url: null, claim: null },
        chain_budget_usd: 5,
        chain_balance_atomic: 500_000,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
      }),
    );
    insertWatcher(
      stubWatcher({
        id: skippedId,
        payer: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        condition_key: "chain-confirm-skip".padEnd(64, "0"),
        target_url: thanksUrl,
        target: { type: "url", url: thanksUrl, render: "never", selector: null },
        run: "confirm",
        chain_confirm: { intent: "lead_submit", url: null, claim: null },
        chain_budget_usd: 5,
        chain_balance_atomic: 0,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
      }),
    );

    const hookOk: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/hooks/") || url.includes("example.com/hooks")) {
        return new Response("ok", { status: 200 });
      }
      assert.doesNotMatch(url, /\/v1\/confirm/);
      return fetch(input, init);
    };

    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), hookOk);
    assert.equal(listWatchEvents(fundedId).some((event) => event.kind === "change"), false);
    await tickDueWatchers(new Date("2026-09-10T18:00:20Z"), hookOk);

    const fundedEvents = listWatchEvents(fundedId).filter((event) => event.kind === "change");
    assert.equal(fundedEvents.length, 1);
    const fundedPayload = JSON.parse(fundedEvents[0]?.payload_json ?? "{}") as {
      type: string;
      chain: {
        run?: string;
        intent?: string;
        skipped?: string;
        result?: { verdict?: string; id?: string; price_usd?: number };
        receipt?: { hash?: string; verify_url?: string };
        debit_usd?: number;
      };
    };
    assert.equal(fundedPayload.type, "change");
    assert.equal(fundedPayload.chain.skipped, undefined);
    assert.equal(fundedPayload.chain.run, "confirm");
    assert.equal(fundedPayload.chain.intent, "lead_submit");
    assert.equal(fundedPayload.chain.result?.verdict, "confirmed");
    assert.equal(fundedPayload.chain.debit_usd, 0.1);
    assert.ok(fundedPayload.chain.result?.id?.startsWith("cfm_"));
    assert.equal(fundedPayload.chain.receipt?.hash?.length, 64);
    assert.ok(fundedPayload.chain.receipt?.verify_url?.includes(fundedPayload.chain.result?.id ?? "missing"));

    const receiptRow = getConfirmReceipt(fundedPayload.chain.result?.id ?? "");
    assert.ok(receiptRow, "expected cfm_ row in receipts.sqlite");
    assert.equal(receiptRow.intent, "lead_submit");
    assert.equal(receiptRow.verdict, "confirmed");

    const receiptRes = await fetch(`${origin}/v1/receipt/${fundedPayload.chain.result?.id}`);
    assert.equal(receiptRes.status, 200);
    const receiptBody = (await receiptRes.json()) as { id?: string; intent?: string };
    assert.equal(receiptBody.id, fundedPayload.chain.result?.id);
    assert.equal(receiptBody.intent, "lead_submit");

    assert.equal(getWatcher(fundedId)?.chain_balance_atomic, 400_000);
    assert.equal(getWatcher(fundedId)?.chain_spent_atomic, 100_000);

    const skippedEvents = listWatchEvents(skippedId).filter((event) => event.kind === "change");
    assert.equal(skippedEvents.length, 1);
    const skippedPayload = JSON.parse(skippedEvents[0]?.payload_json ?? "{}") as {
      chain: { skipped?: string; result?: unknown };
    };
    assert.equal(skippedPayload.chain.skipped, "insufficient_balance");
    assert.equal(skippedPayload.chain.result, undefined);
    assert.equal(getWatcher(skippedId)?.chain_balance_atomic, 0);
  });

  it("order_placed confirm chain debits $0.25 and writes a receipt", async () => {
    const fundedId = "wtc_01CHAINCONFIRMORDER000001";
    const orderUrl = `${origin}/fixtures/confirm/order-thank-you-id`;
    insertWatcher(
      stubWatcher({
        id: fundedId,
        payer: "0xffffffffffffffffffffffffffffffffffffffff",
        condition_key: "chain-confirm-order".padEnd(64, "0"),
        target_url: orderUrl,
        target: { type: "url", url: orderUrl, render: "never", selector: null },
        run: "confirm",
        chain_confirm: { intent: "order_placed", url: null, claim: null },
        chain_budget_usd: 5,
        chain_balance_atomic: 500_000,
        next_check_at: "2026-09-10T18:00:00Z",
        baseline: { captured: true, hash: observationHash("closed", "4xx"), summary: "closed 4xx" },
      }),
    );

    const hookOk: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/hooks/") || url.includes("example.com/hooks")) {
        return new Response("ok", { status: 200 });
      }
      assert.doesNotMatch(url, /\/v1\/confirm/);
      return fetch(input, init);
    };

    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), hookOk);
    await tickDueWatchers(new Date("2026-09-10T18:00:20Z"), hookOk);

    const fundedEvents = listWatchEvents(fundedId).filter((event) => event.kind === "change");
    assert.equal(fundedEvents.length, 1);
    const fundedPayload = JSON.parse(fundedEvents[0]?.payload_json ?? "{}") as {
      chain: { run?: string; intent?: string; debit_usd?: number; result?: { verdict?: string; id?: string } };
    };
    assert.equal(fundedPayload.chain.run, "confirm");
    assert.equal(fundedPayload.chain.intent, "order_placed");
    assert.equal(fundedPayload.chain.debit_usd, 0.25);
    assert.equal(fundedPayload.chain.result?.verdict, "confirmed");
    assert.ok(getConfirmReceipt(fundedPayload.chain.result?.id ?? ""));
    assert.equal(getWatcher(fundedId)?.chain_balance_atomic, 250_000);
    assert.equal(getWatcher(fundedId)?.chain_spent_atomic, 250_000);
  });

  it("credit helper is used by topup and does not pay public verify", () => {
    const id = "wtc_01CHAINCREDIT000000000001";
    insertWatcher(
      stubWatcher({
        id,
        payer: "0xcccccccccccccccccccccccccccccccccccccccc",
        condition_key: "chain-credit".padEnd(64, "0"),
        run: "none",
        chain_balance_atomic: 0,
        next_check_at: "2099-01-01T00:00:00Z",
      }),
    );
    assert.equal(creditChainBalance(id, 500_000), 500_000);
    assert.equal(getWatcher(id)?.chain_balance_atomic, 500_000);
  });
});
