import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { observationHash } from "../src/check.js";
import {
  SENTINEL_SIGNATURE_HEADER,
  WATCH_CALLBACK_MAX_ATTEMPTS,
  WATCH_CALLBACK_RETRY_DELAYS_MS,
  WATCH_PRICE_ATOMIC_USDC,
} from "../src/config.js";
import { isEventId } from "../src/confirm-id.js";
import { generateReceiptPrivateKeyPem, resetReceiptSignerCache } from "../src/receipt.js";
import {
  deliverDueCallbacks,
  hmacSha256Hex,
  nextCallbackRetryAt,
  parseSentinelSignature,
  signCallbackBody,
  verifyCallbackSignature,
} from "../src/watch-callback.js";
import { emitWatchEvent } from "../src/watch-events.js";
import { hashOwnerToken } from "../src/watch.js";
import { tickDueWatchers } from "../src/watch-scheduler.js";
import {
  closeWatchStore,
  getWatchEvent,
  getWatcher,
  initWatchStore,
  insertWatcher,
  listDeliveryAttempts,
  listWatchEvents,
  setWatcherNextCheckAt,
  type WatcherRow,
} from "../src/watch-store.js";

const SECRET = "whsec_test";
const OWNER = "owt_01J8Z0K3N4P5Q6R7S8T9V0WOWT";

function stubWatcher(overrides: Partial<WatcherRow> = {}): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id: overrides.id ?? "wtc_01J8Z0K3N4P5Q6R7S8T9V0WAAA",
    payer: overrides.payer ?? "0x2222222222222222222222222222222222222222",
    owner_token_hash: overrides.owner_token_hash ?? hashOwnerToken(OWNER),
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
    callback_secret: overrides.callback_secret ?? SECRET,
    callback_deliver: overrides.callback_deliver ?? "on_change",
    run: "none",
    chain_budget_usd: null,
    label: null,
    context_json: overrides.context_json ?? JSON.stringify({ listing_id: "job-1" }),
    created_at: now,
    claimed_until: null,
    consecutive_failures: overrides.consecutive_failures ?? 0,
    unreachable: overrides.unreachable ?? false,
    expiring_emitted: overrides.expiring_emitted ?? false,
    detector_state: {},
    ...overrides,
  };
}

describe("HMAC signature recipe", () => {
  it("v1 is HMAC-SHA256 hex over the raw body; header is t=<unix>,v1=<hex>", () => {
    const body = '{"id":"evt_01TEST","type":"change"}';
    const unix = 1_789_068_411;
    const expected = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
    assert.equal(hmacSha256Hex(SECRET, body), expected);
    const header = signCallbackBody(SECRET, body, unix);
    assert.equal(header, `t=${unix},v1=${expected}`);
    assert.equal(header.startsWith("t="), true);
    assert.match(header, /^t=\d+,v1=[0-9a-f]{64}$/);
    const parsed = parseSentinelSignature(header);
    assert.deepEqual(parsed, { t: unix, v1: expected });
    assert.equal(verifyCallbackSignature(SECRET, body, header), true);
    assert.equal(verifyCallbackSignature("wrong", body, header), false);
    assert.equal(verifyCallbackSignature(SECRET, `${body} `, header), false);
    assert.equal(SENTINEL_SIGNATURE_HEADER, "X-Sentinel-Signature");
  });

  it("schedules 1m, 5m, 30m, 2h after failures and stops after 5 attempts", () => {
    assert.deepEqual([...WATCH_CALLBACK_RETRY_DELAYS_MS], [
      60_000,
      5 * 60_000,
      30 * 60_000,
      2 * 60 * 60_000,
      12 * 60 * 60_000,
    ]);
    assert.equal(WATCH_CALLBACK_MAX_ATTEMPTS, 5);
    const now = new Date("2026-09-10T18:00:00Z");
    assert.equal(nextCallbackRetryAt(1, now)?.getTime(), now.getTime() + 60_000);
    assert.equal(nextCallbackRetryAt(2, now)?.getTime(), now.getTime() + 5 * 60_000);
    assert.equal(nextCallbackRetryAt(3, now)?.getTime(), now.getTime() + 30 * 60_000);
    assert.equal(nextCallbackRetryAt(4, now)?.getTime(), now.getTime() + 2 * 60 * 60_000);
    assert.equal(nextCallbackRetryAt(5, now), null);
  });
});

describe("callback retry + events HTTP", () => {
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

  it("retries failed POSTs on the documented schedule and never drops the event", async () => {
    const watcher = stubWatcher({
      id: "wtc_01CALLBACKRETRY00000000001",
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      condition_key: "retry-key".padEnd(64, "0"),
      next_check_at: "2099-01-01T00:00:00Z",
    });
    insertWatcher(watcher);
    const now0 = new Date("2026-09-10T18:00:00Z");
    const payload = emitWatchEvent({
      watcher,
      type: "change",
      previous: { hash: "aa", status: "live", http_status: 200, http_class: "2xx", summary: "live" },
      current: { hash: "bb", status: "closed", http_status: 404, http_class: "4xx", summary: "closed" },
      fired: true,
      confidence: 0.82,
      checks_remaining: 2879,
      now: now0,
    });
    assert.equal(isEventId(payload.id), true);
    assert.equal(payload.chain.run, "none");
    assert.deepEqual(payload.context, { listing_id: "job-1" });
    assert.ok(payload.receipt.hash);
    assert.ok(payload.receipt.verify_url.includes(payload.id));

    const failing: typeof fetch = async () => new Response("nope", { status: 500 });
    let now = now0;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const result = await deliverDueCallbacks(now, failing);
      assert.equal(result.failed, 1);
      const event = getWatchEvent(payload.id);
      assert.ok(event);
      assert.equal(event.delivered_at, null);
      assert.equal(event.delivery_attempts, attempt);
      const attempts = listDeliveryAttempts(payload.id);
      assert.equal(attempts.length, attempt);
      assert.equal(attempts[attempt - 1]?.ok, false);
      if (attempt < 5) {
        const next = nextCallbackRetryAt(attempt, now);
        assert.ok(next);
        assert.equal(event.next_attempt_at, next.toISOString().replace(/\.\d{3}Z$/, "Z"));
        now = next;
      } else {
        assert.equal(event.next_attempt_at, null);
      }
    }
    const stillThere = getWatchEvent(payload.id);
    assert.ok(stillThere);
    assert.equal(stillThere.delivery_attempts, 5);
    assert.equal(stillThere.delivered_at, null);
    assert.equal(listWatchEvents(watcher.id).length, 1);
  });

  it("GET /v1/watch/{id}/events paginates and rejects a bad owner token", async () => {
    const watcher = stubWatcher({
      id: "wtc_01EVENTSPAGE0000000000001",
      payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      condition_key: "page-key".padEnd(64, "0"),
      next_check_at: "2099-01-01T00:00:00Z",
    });
    insertWatcher(watcher);
    const base = new Date("2026-09-10T19:00:00Z").getTime();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const payload = emitWatchEvent({
        watcher,
        type: "change",
        previous: null,
        current: { hash: `c${i}`, status: "live", http_status: 200, http_class: "2xx", summary: `n${i}` },
        fired: true,
        confidence: 0.8,
        checks_remaining: 2800 - i,
        now: new Date(base + i * 1000),
      });
      ids.push(payload.id);
    }

    const missing = await fetch(`${origin}/v1/watch/${watcher.id}/events`);
    assert.equal(missing.status, 401);
    const bad = await fetch(`${origin}/v1/watch/${watcher.id}/events`, {
      headers: { "x-livecheck-owner-token": "owt_01AAAAAAAAAAAAAAAAAAAAAAAA" },
    });
    assert.equal(bad.status, 403);

    const first = await fetch(`${origin}/v1/watch/${watcher.id}/events?limit=2`, {
      headers: { "x-livecheck-owner-token": OWNER },
    });
    assert.equal(first.status, 200);
    const page1 = (await first.json()) as {
      events: Array<{ id: string; type: string }>;
      has_more: boolean;
      next_cursor: string | null;
      limit: number;
    };
    assert.equal(page1.limit, 2);
    assert.equal(page1.events.length, 2);
    assert.equal(page1.has_more, true);
    assert.ok(page1.next_cursor);
    assert.equal(page1.events[0]?.id, ids[4]);
    assert.equal(page1.events[1]?.id, ids[3]);

    const second = await fetch(
      `${origin}/v1/watch/${watcher.id}/events?limit=2&cursor=${encodeURIComponent(page1.next_cursor ?? "")}`,
      { headers: { "x-livecheck-owner-token": OWNER } },
    );
    assert.equal(second.status, 200);
    const page2 = (await second.json()) as {
      events: Array<{ id: string }>;
      has_more: boolean;
      next_cursor: string | null;
    };
    assert.equal(page2.events.length, 2);
    assert.equal(page2.events[0]?.id, ids[2]);
    assert.equal(page2.has_more, true);

    const receipt = await fetch(`${origin}/v1/receipt/${ids[0]}`);
    assert.equal(receipt.status, 200);
    const stored = (await receipt.json()) as {
      intent: string;
      verdict: string;
      verify: { signed?: boolean; valid?: boolean | null };
    };
    assert.equal(stored.intent, "watch_event");
    assert.equal(stored.verdict, "change");
    assert.equal(stored.verify.signed, true);
    assert.equal(stored.verify.valid, true);
  });

  it("emits unreachable once, recovered after a success, plus expiring and expired", async () => {
    const boom: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes("/hooks/")) return new Response("ok", { status: 200 });
      throw new Error("ECONNREFUSED");
    };
    const ok: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes("/hooks/")) return new Response("ok", { status: 200 });
      return fetch(input, init);
    };

    const unreachableId = "wtc_01UNREACHABLE000000000001";
    insertWatcher(
      stubWatcher({
        id: unreachableId,
        payer: "0xcccccccccccccccccccccccccccccccccccccccc",
        condition_key: "unreach-key".padEnd(64, "0"),
        target_url: `${origin}/fixtures/live-apply-now`,
        target: { type: "url", url: `${origin}/fixtures/live-apply-now`, render: "never", selector: null },
        next_check_at: "2026-09-10T18:00:00Z",
      }),
    );

    for (let i = 0; i < 3; i += 1) {
      await tickDueWatchers(new Date(`2026-09-10T18:0${i}:00Z`), boom);
      setWatcherNextCheckAt(unreachableId, "2026-09-10T18:00:00Z");
    }
    const failEvents = listWatchEvents(unreachableId);
    assert.equal(failEvents.filter((event) => event.kind === "unreachable").length, 1);
    const row = getWatcher(unreachableId);
    assert.equal(row?.unreachable, true);
    assert.equal(row?.consecutive_failures, 3);

    await tickDueWatchers(new Date("2026-09-10T18:05:00Z"), ok);
    const after = listWatchEvents(unreachableId);
    assert.equal(after.filter((event) => event.kind === "recovered").length, 1);
    assert.equal(getWatcher(unreachableId)?.unreachable, false);

    const expiringId = "wtc_01EXPIRING000000000000001";
    insertWatcher(
      stubWatcher({
        id: expiringId,
        payer: "0xdddddddddddddddddddddddddddddddddddddddd",
        condition_key: "expiring-key".padEnd(64, "0"),
        next_check_at: "2099-01-01T00:00:00Z",
        expires_at: "2026-09-11T06:00:00Z",
      }),
    );
    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), ok);
    assert.ok(listWatchEvents(expiringId).some((event) => event.kind === "expiring"));
    await tickDueWatchers(new Date("2026-09-10T18:01:00Z"), ok);
    assert.equal(listWatchEvents(expiringId).filter((event) => event.kind === "expiring").length, 1);

    const expiredId = "wtc_01EXPIRED0000000000000001";
    insertWatcher(
      stubWatcher({
        id: expiredId,
        payer: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        condition_key: "expired-key".padEnd(64, "0"),
        next_check_at: "2099-01-01T00:00:00Z",
        expires_at: "2026-09-10T17:00:00Z",
      }),
    );
    await tickDueWatchers(new Date("2026-09-10T18:00:00Z"), ok);
    assert.ok(listWatchEvents(expiredId).some((event) => event.kind === "expired"));
    assert.equal(getWatcher(expiredId)?.status, "expired");
  });

  it("does not change the /v1/watch 402 amount (regression)", async () => {
    const res = await fetch(`${origin}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target: { type: "url", url: "https://example.com/jobs/1", render: "never" },
        condition: { detector: "status_change", params: {} },
        callback: { url: "https://example.com/hooks/livecheck", secret: SECRET, deliver: "on_change" },
      }),
    });
    assert.equal(res.status, 402);
    const header = res.headers.get("payment-required");
    assert.ok(header);
    const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as {
      accepts?: Array<{ amount?: string }>;
    };
    assert.equal(decoded.accepts?.length, 1);
    assert.equal(decoded.accepts?.[0]?.amount, WATCH_PRICE_ATOMIC_USDC);
    assert.equal(decoded.accepts?.[0]?.amount, "2500000");
  });
});
