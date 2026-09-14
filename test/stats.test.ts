import assert from "node:assert/strict";
import { after, afterEach, before, describe, it } from "node:test";
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
import {
  FALLBACK_CONFIRM_BENCHES,
  benchFromConfirmIntentReport,
  resetConfirmBenches,
} from "../src/confirm-stats-benches.js";
import {
  FALLBACK_SENTINEL_BENCHES,
  benchesFromSentinelReport,
  resetSentinelBenches,
} from "../src/sentinel-stats-benches.js";
import { hashUrl } from "../src/paid-call.js";
import {
  closePaidCallStore,
  initPaidCallStore,
  insertPaidCallRow,
} from "../src/paid-call-store.js";
import {
  clearConfirmReceiptMemory,
  closeReceiptStore,
  initReceiptStore,
  rememberConfirmReceipt,
  type ConfirmReceiptRow,
} from "../src/receipt-store.js";
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

  it("returns 200 JSON with lead_submit windows and per-intent Confirm FC benches", async () => {
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
        benches?: {
          false_positive_rate?: {
            status_change?: number;
            text_diff?: number;
            n_checks?: number;
            gate?: string;
          };
          median_latency_ms?: number;
          latency_p95_ms?: number;
          interval_s?: number;
          hmac?: { verified?: number; delivered?: number; pass?: boolean };
          chain_verify?: string;
          report?: string;
          commit?: string;
          note?: string;
        };
      };
      benches?: {
        lead_submit?: { false_confirmed_rate?: number; n?: number; false_confirmed?: number; commit?: string };
        listing_published?: { false_confirmed_rate?: number; n?: number; false_confirmed?: number; commit?: string };
        order_placed?: { false_confirmed_rate?: number; n?: number; false_confirmed?: number; commit?: string };
        note?: string;
        report?: string;
      };
      store?: {
        scope?: string;
        confirm_unscoped_paid_calls?: { l7d?: number; l30d?: number };
        note?: string;
      };
    };
    assert.equal(body.ok, true);
    assert.equal(body.store?.scope, "this_machine_volume");
    assert.equal(typeof body.store?.confirm_unscoped_paid_calls?.l7d, "number");
    assert.match(body.store?.note ?? "", /this Fly machine/i);
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
    assert.deepEqual(body.benches?.lead_submit, {
      false_confirmed_rate: 0,
      n: 77,
      false_confirmed: 0,
      report: "bench/lead-submit-report.json",
      commit: "a17f56b",
    });
    assert.deepEqual(body.benches?.listing_published, {
      false_confirmed_rate: 0,
      n: 102,
      false_confirmed: 0,
      report: "bench/listing-published-report.json",
      commit: "b10322b",
    });
    assert.deepEqual(body.benches?.order_placed, {
      false_confirmed_rate: 0,
      n: 100,
      false_confirmed: 0,
      report: "bench/order-placed-report.json",
      commit: "0e9faa1",
    });
    assert.match(body.benches?.note ?? "", /not a live dispute rate/i);
    assert.equal(body.benches?.report, "docs/confirm-benches.md");
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
    assert.deepEqual(body.sentinel?.benches?.false_positive_rate, {
      status_change: 0,
      text_diff: 0,
      n_checks: 198,
      gate: "status_change=0; text_diff<=0.02",
    });
    assert.equal(body.sentinel?.benches?.median_latency_ms, 162500);
    assert.equal(body.sentinel?.benches?.latency_p95_ms, 315250);
    assert.equal(body.sentinel?.benches?.interval_s, 300);
    assert.deepEqual(body.sentinel?.benches?.hmac, { verified: 20, delivered: 20, pass: true });
    assert.equal(body.sentinel?.benches?.chain_verify, "pass");
    assert.equal(body.sentinel?.benches?.report, "docs/sentinel-benches.md");
    assert.equal(body.sentinel?.benches?.commit, "590627c");
    assert.match(body.sentinel?.benches?.note ?? "", /not a 1000-watcher/i);
  });

  it("GET /stats?format=json is the public landing source of truth", async () => {
    const res = await fetch(`${origin}/stats?format=json`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
    const body = (await res.json()) as { ok?: boolean; service?: string; sentinel?: { payable?: boolean } };
    assert.equal(body.ok, true);
    assert.equal(body.service, "livecheck");
    assert.equal(body.sentinel?.payable, true);
  });

  it("returns HTML Sentinel section when Accept: text/html", async () => {
    const res = await fetch(`${origin}/stats`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    assert.match(html, /<h3>Confirm benches<\/h3>/);
    assert.match(html, /lead_submit/);
    assert.match(html, /0\/77/);
    assert.match(html, /0\/102/);
    assert.match(html, /0\/100/);
    assert.match(html, /not a live dispute rate/);
    assert.match(html, /<h2>Sentinel<\/h2>/);
    assert.match(html, /Active watchers/);
    assert.match(html, /False-positive rate/);
    assert.match(html, /Median latency/);
    assert.match(html, /status_change 0\/198/);
    assert.match(html, /text_diff 0\/198/);
    assert.match(html, /162500 ms/);
    assert.match(html, /315250 ms/);
    assert.match(html, /20\/20 pass/);
    assert.match(html, /590627c/);
    assert.doesNotMatch(html, />null</);
    assert.match(html, /status_change/);
    assert.match(html, /numeric_threshold/);
    assert.match(html, /Volume scope/);
    assert.match(html, /Unscoped confirm paid_calls/);
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
    assert.equal(doc.sentinel.benches.false_positive_rate.status_change, 0);
    assert.equal(doc.sentinel.benches.false_positive_rate.text_diff, 0);
    assert.equal(doc.sentinel.benches.false_positive_rate.n_checks, 198);
    assert.equal(doc.sentinel.benches.median_latency_ms, 162500);
    assert.equal(doc.sentinel.benches.latency_p95_ms, 315250);
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
    assert.match(doc.paths?.["/stats"]?.get?.description ?? "", /sentinel-report\.json/);
    assert.match(doc.paths?.["/stats"]?.get?.description ?? "", /false_confirmed_rate/);
    assert.match(doc.paths?.["/stats"]?.get?.description ?? "", /listing-published-report\.json/);
    assert.doesNotMatch(doc.paths?.["/stats"]?.get?.description ?? "", /structured null/);
    assert.ok(doc.paths?.["/stats"]?.get?.tags?.includes("Sentinel"));
  });
});

describe("Sentinel benches loader", () => {
  after(() => {
    resetSentinelBenches();
  });

  it("falls back to the landed 590627c numbers when the report is missing", () => {
    const load = resetSentinelBenches(null);
    assert.equal(load.source, "fallback");
    assert.deepEqual(load.benches, FALLBACK_SENTINEL_BENCHES);
    assert.equal(load.benches.commit, "590627c");
    assert.equal(load.benches.median_latency_ms, 162500);
    assert.equal(load.benches.latency_p95_ms, 315250);
  });

  it("rejects a report missing latency so Fly still uses the fallback", () => {
    assert.equal(benchesFromSentinelReport({ honesty: { status_change: { false_positive_rate: 0, checks: 198 } } }), null);
  });
});

describe("Confirm benches loader", () => {
  after(() => {
    resetConfirmBenches();
  });

  it("falls back to landed honesty numbers when reports are missing", () => {
    const load = resetConfirmBenches(null);
    assert.equal(load.source, "fallback");
    assert.deepEqual(load.benches, FALLBACK_CONFIRM_BENCHES);
    assert.equal(load.benches.lead_submit.n, 77);
    assert.equal(load.benches.listing_published.n, 102);
    assert.equal(load.benches.order_placed.n, 100);
    assert.equal(load.benches.lead_submit.false_confirmed_rate, 0);
    assert.equal(load.benches.listing_published.commit, "b10322b");
    assert.equal(load.benches.order_placed.commit, "0e9faa1");
  });

  it("rejects a report missing n so Fly still uses the fallback for that intent", () => {
    assert.equal(benchFromConfirmIntentReport("listing_published", { false_confirmed: 0 }), null);
    assert.equal(benchFromConfirmIntentReport("order_placed", { n: 0, false_confirmed: 0 }), null);
  });

  it("computes false_confirmed_rate from n and false_confirmed", () => {
    const bench = benchFromConfirmIntentReport("lead_submit", { n: 50, false_confirmed: 1 });
    assert.ok(bench);
    assert.equal(bench.n, 50);
    assert.equal(bench.false_confirmed, 1);
    assert.equal(bench.false_confirmed_rate, 0.02);
  });
});

function stubReceipt(overrides: Partial<ConfirmReceiptRow> = {}): ConfirmReceiptRow {
  return {
    id: overrides.id ?? "cfm_01STATSLEADSUBMIT000000001",
    intent: overrides.intent ?? "lead_submit",
    verdict: overrides.verdict ?? "confirmed",
    confidence: 0.92,
    evidence_level: 2,
    canonical_json: "{}",
    payload_hash: "ab".repeat(32),
    signature: null,
    signer: null,
    observed_at: "2026-09-10T18:00:00Z",
    url_hash: "cd".repeat(32),
    claim_hash: "ef".repeat(32),
    created_at: overrides.created_at ?? "2026-09-10T18:00:00Z",
  };
}

describe("GET /stats Confirm paid_calls vs receipts honesty", () => {
  afterEach(() => {
    closePaidCallStore();
    closeReceiptStore();
    clearConfirmReceiptMemory();
  });

  it("does not attribute unscoped confirm-route rows to lead_submit", () => {
    const opened = initPaidCallStore(":memory:");
    if (!opened.ok) throw new Error("paid_call store failed");
    initReceiptStore(":memory:");
    const now = new Date("2026-09-11T19:00:00.000Z");
    for (let i = 0; i < 3; i += 1) {
      insertPaidCallRow(opened.db, {
        ts: `2026-09-10T18:0${i}:00Z`,
        route: "confirm",
        host: "example.com",
        url_sha256: hashUrl(`https://example.com/thanks-${i}`),
      });
    }
    const doc = buildStatsDocument(now);
    assert.equal(doc.intents.lead_submit.l7d.paid_calls, 0);
    assert.equal(doc.intents.lead_submit.l7d.receipts, 0);
    assert.equal(doc.intents.listing_published.l7d.paid_calls, 0);
    assert.equal(doc.intents.order_placed.l7d.paid_calls, 0);
    assert.equal(doc.store.confirm_unscoped_paid_calls.l7d, 3);
    assert.equal(doc.store.scope, "this_machine_volume");
    assert.match(doc.notes.join(" "), /3 L7d/);
    assert.match(doc.notes.join(" "), /cannot be reconstructed/i);
  });

  it("counts only intent-scoped paid_calls per Confirm intent", () => {
    const opened = initPaidCallStore(":memory:");
    if (!opened.ok) throw new Error("paid_call store failed");
    initReceiptStore(":memory:");
    const now = new Date("2026-09-11T19:00:00.000Z");
    insertPaidCallRow(opened.db, {
      ts: "2026-09-10T18:00:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/lead"),
      intent: "lead_submit",
      verdict: "unknown",
    });
    insertPaidCallRow(opened.db, {
      ts: "2026-09-10T18:01:00Z",
      route: "confirm",
      host: "example.com",
      url_sha256: hashUrl("https://example.com/listing"),
      intent: "listing_published",
      verdict: "confirmed",
    });
    insertPaidCallRow(opened.db, {
      ts: "2026-09-10T18:02:00Z",
      route: "confirm",
      host: "shop.example.com",
      url_sha256: hashUrl("https://shop.example.com/order"),
      intent: "order_placed",
      verdict: "failed",
    });
    rememberConfirmReceipt(stubReceipt({ id: "cfm_01LEAD00000000000000000001", intent: "lead_submit" }));
    rememberConfirmReceipt(
      stubReceipt({
        id: "cfm_01LIST00000000000000000001",
        intent: "listing_published",
        created_at: "2026-09-10T18:01:00Z",
      }),
    );
    const doc = buildStatsDocument(now);
    assert.equal(doc.intents.lead_submit.l7d.paid_calls, 1);
    assert.equal(doc.intents.lead_submit.l7d.receipts, 1);
    assert.equal(doc.intents.listing_published.l7d.paid_calls, 1);
    assert.equal(doc.intents.listing_published.l7d.receipts, 1);
    assert.equal(doc.intents.order_placed.l7d.paid_calls, 1);
    assert.equal(doc.intents.order_placed.l7d.receipts, 0);
    assert.equal(doc.store.confirm_unscoped_paid_calls.l7d, 0);
    assert.equal(doc.benches.lead_submit.false_confirmed_rate, 0);
    assert.equal(doc.benches.lead_submit.n, 77);
    assert.notEqual(doc.benches.listing_published.n, doc.intents.listing_published.l7d.paid_calls);
  });
});
