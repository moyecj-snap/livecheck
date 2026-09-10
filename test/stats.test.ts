import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { observationHash } from "../src/check.js";
import {
  CHECK_PRICE_USD,
  CHAIN_TOPUP_PRICE_USD,
  CONFIRM_PRICE_USD,
  OPENAPI_CONFIRM_DESCRIPTION,
  OPENAPI_CONFIRM_INTENT_DESCRIPTION,
  WATCH_PRICE_USD,
} from "../src/config.js";
import { openApiDocument } from "../src/discovery.js";
import { buildStatsDocument } from "../src/stats.js";
import {
  closeWatchStore,
  initWatchStore,
  insertWatchEvent,
  insertWatcher,
  type WatcherRow,
} from "../src/watch-store.js";

function stubWatcher(overrides: Partial<WatcherRow> = {}): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  return {
    id: overrides.id ?? "wtc_01J8Z0K3N4P5Q6R7S8T9V0WAAA",
    payer: overrides.payer ?? "0x1111111111111111111111111111111111111111",
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

describe("GET /stats", () => {
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

  it("returns 200 JSON with lead_submit placeholders and null false-confirmed rate", async () => {
    const res = await fetch(`${origin}/stats`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ok?: boolean;
      intents?: {
        lead_submit?: {
          payable?: boolean;
          price_usd?: number;
          status?: string;
          l7d?: { paid_calls?: number; receipts?: number };
        };
        listing_published?: {
          payable?: boolean;
          price_usd?: number;
          status?: string;
          l7d?: { paid_calls?: number; receipts?: number };
        };
        order_placed?: {
          payable?: boolean;
          price_usd?: number;
          status?: string;
          l7d?: { paid_calls?: number; receipts?: number };
        };
      };
      sentinel?: {
        payable?: boolean;
        status?: string;
        prices?: { check_usd?: number; watch_usd?: number; chain_topup_usd?: number };
        active_watchers?: number;
        checks_run?: number;
        change_events?: number;
        by_detector?: {
          status_change?: { watchers?: number; change_events?: number };
          keyword?: { watchers?: number; change_events?: number };
          text_diff?: { watchers?: number; change_events?: number };
          numeric_threshold?: { watchers?: number; change_events?: number };
        };
        benches?: { false_positive_rate?: unknown; median_latency_ms?: unknown; note?: string };
      };
      benches?: { false_confirmed_rate?: unknown; note?: string };
    };
    assert.equal(body.ok, true);
    assert.equal(body.intents?.lead_submit?.payable, true);
    assert.equal(body.intents?.lead_submit?.price_usd, CONFIRM_PRICE_USD);
    assert.equal(body.intents?.lead_submit?.status, "ga");
    assert.equal(typeof body.intents?.lead_submit?.l7d?.paid_calls, "number");
    assert.equal(body.intents?.listing_published?.payable, true);
    assert.equal(body.intents?.listing_published?.price_usd, CONFIRM_PRICE_USD);
    assert.equal(body.intents?.listing_published?.status, "ga");
    assert.equal(typeof body.intents?.listing_published?.l7d?.paid_calls, "number");
    assert.equal(body.intents?.order_placed?.payable, true);
    assert.equal(body.intents?.order_placed?.price_usd, 0.25);
    assert.equal(body.intents?.order_placed?.status, "ga");
    assert.equal(body.benches?.false_confirmed_rate, null);
    assert.match(body.benches?.note ?? "", /not published/i);
    assert.equal(body.sentinel?.payable, true);
    assert.equal(body.sentinel?.status, "payable");
    assert.equal(body.sentinel?.prices?.check_usd, CHECK_PRICE_USD);
    assert.equal(body.sentinel?.prices?.watch_usd, WATCH_PRICE_USD);
    assert.equal(body.sentinel?.prices?.chain_topup_usd, CHAIN_TOPUP_PRICE_USD);
    assert.equal(typeof body.sentinel?.active_watchers, "number");
    assert.equal(typeof body.sentinel?.checks_run, "number");
    assert.equal(typeof body.sentinel?.change_events, "number");
    assert.equal(typeof body.sentinel?.by_detector?.status_change?.watchers, "number");
    assert.equal(typeof body.sentinel?.by_detector?.keyword?.watchers, "number");
    assert.equal(typeof body.sentinel?.by_detector?.text_diff?.watchers, "number");
    assert.equal(typeof body.sentinel?.by_detector?.numeric_threshold?.watchers, "number");
    assert.equal(body.sentinel?.benches?.false_positive_rate, null);
    assert.equal(body.sentinel?.benches?.median_latency_ms, null);
    assert.match(body.sentinel?.benches?.note ?? "", /not published/i);
  });

  it("returns HTML Sentinel section when Accept: text/html", async () => {
    const res = await fetch(`${origin}/stats`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<h2>Sentinel<\/h2>/);
    assert.match(html, /Active watchers/);
    assert.match(html, /False-positive rate/);
    assert.match(html, /Median latency/);
    assert.match(html, /status_change/);
    assert.match(html, /numeric_threshold/);
  });

  it("GET /v1/judge is a 501 stub and is not 402", async () => {
    const res = await fetch(`${origin}/v1/judge`);
    assert.equal(res.status, 501);
    const body = (await res.json()) as { error?: string };
    assert.equal(body.error, "not_implemented");
  });
});

describe("Sentinel /stats from SQLite", () => {
  before(() => {
    initWatchStore(":memory:");
    insertWatcher(
      stubWatcher({
        id: "wtc_01STATSSTATUSCHANGE00001",
        condition: { detector: "status_change", params: {} },
        condition_key: "status-a".padEnd(64, "0"),
        checks_remaining: 2878,
      }),
    );
    insertWatcher(
      stubWatcher({
        id: "wtc_01STATSKEYWORD00000000002",
        payer: "0x2222222222222222222222222222222222222222",
        target_url: "https://example.com/jobs/2",
        target: { type: "url", url: "https://example.com/jobs/2", render: "never", selector: null },
        condition: {
          detector: "keyword",
          params: { any: ["closed"], all: [], none: [], selector: null, case_sensitive: false },
        },
        condition_key: "keyword-b".padEnd(64, "0"),
        checks_remaining: 2880,
      }),
    );
    insertWatcher(
      stubWatcher({
        id: "wtc_01STATSSTOPPED00000000003",
        payer: "0x3333333333333333333333333333333333333333",
        target_url: "https://example.com/jobs/3",
        target: { type: "url", url: "https://example.com/jobs/3", render: "never", selector: null },
        condition: { detector: "text_diff", params: { selector: "h1", ignore: [], min_change_ratio: 0.02 } },
        condition_key: "diff-c".padEnd(64, "0"),
        status: "stopped",
        checks_remaining: 2800,
      }),
    );
    insertWatchEvent({
      id: "evt_01STATSCHANGES0000000001",
      watcher_id: "wtc_01STATSSTATUSCHANGE00001",
      kind: "change",
      payload_json: "{}",
      created_at: "2026-09-10T18:01:00Z",
      delivered_at: null,
      delivery_attempts: 0,
      next_attempt_at: null,
      last_error: null,
    });
    insertWatchEvent({
      id: "evt_01STATSUNREACH0000000002",
      watcher_id: "wtc_01STATSSTATUSCHANGE00001",
      kind: "unreachable",
      payload_json: "{}",
      created_at: "2026-09-10T18:02:00Z",
      delivered_at: null,
      delivery_attempts: 0,
      next_attempt_at: null,
      last_error: null,
    });
  });

  after(() => closeWatchStore());

  it("counts active watchers, scheduled checks, change events, and per-detector rows", () => {
    const doc = buildStatsDocument();
    assert.equal(doc.sentinel.active_watchers, 2);
    assert.equal(doc.sentinel.change_events, 1);
    assert.equal(doc.sentinel.checks_run, 2 + 80);
    assert.equal(doc.sentinel.by_detector.status_change.watchers, 1);
    assert.equal(doc.sentinel.by_detector.status_change.change_events, 1);
    assert.equal(doc.sentinel.by_detector.keyword.watchers, 1);
    assert.equal(doc.sentinel.by_detector.keyword.change_events, 0);
    assert.equal(doc.sentinel.by_detector.text_diff.watchers, 1);
    assert.equal(doc.sentinel.by_detector.text_diff.change_events, 0);
    assert.equal(doc.sentinel.by_detector.numeric_threshold.watchers, 0);
    assert.equal(doc.sentinel.benches.false_positive_rate, null);
    assert.equal(doc.sentinel.benches.median_latency_ms, null);
  });
});

describe("OpenAPI Confirm v1.0 spine", () => {
  it("documents additive confirm fields and does not list unsupported intents as payable", () => {
    const doc = openApiDocument("https://livecheck.fly.dev/openapi.json") as {
      paths?: {
        "/v1/confirm"?: {
          post?: {
            description?: string;
            "x-guidance"?: string;
            requestBody?: {
              content?: {
                "application/json"?: {
                  schema?: {
                    properties?: { intent?: { enum?: string[]; description?: string }; claim?: object };
                  };
                };
              };
            };
            responses?: {
              "200"?: {
                content?: {
                  "application/json"?: {
                    schema?: { properties?: Record<string, unknown>; required?: string[] };
                  };
                };
              };
            };
          };
        };
        "/v1/receipt/{id}"?: object;
        "/stats"?: { get?: { description?: string; tags?: string[]; summary?: string } };
      };
    };
    const intentEnum = doc.paths?.["/v1/confirm"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties
      ?.intent?.enum;
    assert.deepEqual(intentEnum, ["lead_submit", "listing_published"]);
    const orderEnum = (
      doc.paths as {
        "/v1/confirm/order"?: {
          post?: { requestBody?: { content?: { "application/json"?: { schema?: { properties?: { intent?: { enum?: string[] } } } } } } };
        };
      }
    )["/v1/confirm/order"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.intent?.enum;
    assert.deepEqual(orderEnum, ["order_placed"]);
    assert.equal(doc.paths?.["/v1/confirm"]?.post?.description, OPENAPI_CONFIRM_DESCRIPTION);
    assert.equal(doc.paths?.["/v1/confirm"]?.post?.["x-guidance"], OPENAPI_CONFIRM_DESCRIPTION);
    assert.equal(
      doc.paths?.["/v1/confirm"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.intent
        ?.description,
      OPENAPI_CONFIRM_INTENT_DESCRIPTION,
    );
    assert.ok(
      doc.paths?.["/v1/confirm"]?.post?.requestBody?.content?.["application/json"]?.schema?.properties?.claim,
    );
    const schema = doc.paths?.["/v1/confirm"]?.post?.responses?.["200"]?.content?.["application/json"]?.schema;
    for (const key of ["id", "evidence_level", "confidence", "receipt"]) {
      assert.ok(schema?.properties?.[key], `expected 200 schema property ${key}`);
      assert.ok(schema?.required?.includes(key), `expected required ${key}`);
    }
    assert.ok(doc.paths?.["/v1/receipt/{id}"]);
    assert.ok(doc.paths?.["/stats"]);
    assert.match(doc.paths?.["/stats"]?.get?.description ?? "", /Sentinel/);
    assert.ok(doc.paths?.["/stats"]?.get?.tags?.includes("Sentinel"));
  });
});
