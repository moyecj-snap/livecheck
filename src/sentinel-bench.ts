import { createHmac } from "node:crypto";
import { observationHash, parseCheckRequest, runCheck } from "./check.js";
import {
  SENTINEL_SIGNATURE_HEADER,
  WATCH_CONFIRM_REFETCH_MS,
  WATCH_MIN_INTERVAL_S,
} from "./config.js";
import { isoTs } from "./paid-call.js";
import {
  LISTING_TITLE_SELECTOR,
  PRODUCT_DESC,
  PRODUCT_TITLE,
  honestyCases,
  noisyJobHtml,
  noisyProductHtml,
  type NoiseKind,
  type NoiseTick,
} from "./sentinel-bench-fixtures.js";
import {
  hmacSha256Hex,
  parseSentinelSignature,
  signCallbackBody,
  verifyCallbackSignature,
} from "./watch-callback.js";
import { tickDueWatchers } from "./watch-scheduler.js";
import {
  closeWatchStore,
  getWatcher,
  initWatchStore,
  insertWatcher,
  listWatchEvents,
  stopWatcher,
  type WatcherRow,
} from "./watch-store.js";
import { WatchError, hashOwnerToken, parseWatchRequest } from "./watch.js";

export const SENTINEL_BENCH_INTERVAL_S = WATCH_MIN_INTERVAL_S;
export const SENTINEL_BENCH_HONESTY_REPEATS = 20;
export const SENTINEL_BENCH_WATCH_TICKS = 12;
export const SENTINEL_TEXT_DIFF_FP_GATE = 0.02;
export const SENTINEL_STATUS_CHANGE_FP_GATE = 0;
export const HMAC_RECIPE =
  "X-Sentinel-Signature: t=<unix>,v1=<hex> — v1 is lowercase hex HMAC-SHA256 of the raw UTF-8 body with callback.secret; t is not part of the MAC";

const SECRET = "whsec_sentinel_bench";
const OWNER = "owt_01SENTINELBENCHOWNERTOKEN01";
const HOOK = "https://hooks.livecheck.test/sentinel";
const PAGE_ORIGIN = "https://bench.livecheck.test";

export type GateResult = {
  id: string;
  gate: string;
  pass: boolean;
  detail: string;
};

export type HonestySlice = {
  checks: number;
  fires: number;
  false_positive_rate: number;
  pass: boolean;
};

export type LatencySample = {
  id: string;
  offset_s: number;
  latency_ms: number;
};

export type ChainSlice = {
  funded_attached: boolean;
  funded_debit_usd: number | null;
  funded_status: string | null;
  skipped: boolean;
  skipped_reason: string | null;
  pass: boolean;
};

export type SentinelBenchReport = {
  generated_at: string;
  scale: {
    honesty_repeats: number;
    honesty_checks_per_detector: number;
    watch_ticks: number;
    latency_samples: number;
    interval_s: number;
    note: string;
  };
  honesty: {
    status_change: HonestySlice;
    text_diff: HonestySlice;
    watch_change_events: number;
    true_positive: { status_change: boolean; text_diff: boolean };
  };
  latency: {
    interval_s: number;
    n: number;
    p50_ms: number;
    p95_ms: number;
    p50_gate_ms: number;
    p95_gate_ms: number;
    samples: LatencySample[];
    pass: boolean;
  };
  hmac: {
    recipe: string;
    unit_pass: boolean;
    delivered: number;
    verified: number;
    pass: boolean;
  };
  chain: ChainSlice;
  on_change_confirm_deferred: boolean;
  gates: GateResult[];
  pass: boolean;
};

type PageState = { status: number; html: string };
type DeliveredHook = { body: string; header: string; atMs: number };

function pageUrl(page: "job" | "product", suffix = "stable", origin = PAGE_ORIGIN): string {
  return page === "job"
    ? `${origin}/jobs/1842/${suffix}`
    : `${origin}/products/ridge-wallet/${suffix}`;
}

function htmlFor(page: "job" | "product", tick: NoiseTick, closed = false): string {
  return page === "job" ? noisyJobHtml(tick, closed) : noisyProductHtml(tick, { soldOut: closed });
}

function makeFetcher(
  pages: Map<string, PageState>,
  hooks: DeliveredHook[],
  nowMs: () => number,
): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.startsWith(HOOK) || url.includes("/hooks/") || url.includes("hooks.livecheck.test")) {
      const body = typeof init?.body === "string" ? init.body : "";
      hooks.push({ body, header: readHeader(init?.headers, SENTINEL_SIGNATURE_HEADER), atMs: nowMs() });
      return new Response("ok", { status: 200 });
    }
    const page = pages.get(url);
    if (!page) return new Response("missing bench fixture", { status: 404 });
    return new Response(page.html, {
      status: page.status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
}

function readHeader(headers: HeadersInit | undefined, name: string): string {
  if (!headers) return "";
  if (headers instanceof Headers) return headers.get(name) ?? "";
  if (Array.isArray(headers)) {
    const hit = headers.find(([key]) => key.toLowerCase() === name.toLowerCase());
    return hit?.[1] ?? "";
  }
  const rec = headers as Record<string, string>;
  for (const [key, value] of Object.entries(rec)) {
    if (key.toLowerCase() === name.toLowerCase()) return value;
  }
  return "";
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo] ?? 0;
  const b = sorted[hi] ?? a;
  return lo === hi ? a : a + (b - a) * (idx - lo);
}

function hmacUnitPass(): boolean {
  const body = '{"id":"evt_01BENCH","type":"change"}';
  const unix = 1_789_068_411;
  const expected = createHmac("sha256", SECRET).update(body, "utf8").digest("hex");
  const header = signCallbackBody(SECRET, body, unix);
  const parsed = parseSentinelSignature(header);
  return (
    hmacSha256Hex(SECRET, body) === expected &&
    header === `t=${unix},v1=${expected}` &&
    parsed?.t === unix &&
    parsed.v1 === expected &&
    verifyCallbackSignature(SECRET, body, header) &&
    !verifyCallbackSignature("wrong", body, header) &&
    !verifyCallbackSignature(SECRET, `${body} `, header) &&
    SENTINEL_SIGNATURE_HEADER === "X-Sentinel-Signature"
  );
}

function confirmOnChangeDeferred(): boolean {
  try {
    parseWatchRequest({
      target: { type: "url", url: "https://example.com/jobs/1", render: "never" },
      condition: { detector: "status_change", params: {} },
      callback: { url: "https://example.com/hook", secret: SECRET },
      on_change: { run: "confirm" },
    });
    return false;
  } catch (error) {
    return error instanceof WatchError && error.code === "invalid_target";
  }
}

function stubWatcher(overrides: Partial<WatcherRow>): WatcherRow {
  const now = "2026-09-10T18:00:00Z";
  const url = overrides.target_url ?? `${PAGE_ORIGIN}/jobs/1842/watch`;
  return {
    id: overrides.id ?? "wtc_01SENTINELBENCH0000000001",
    payer: overrides.payer ?? "0x1111111111111111111111111111111111111111",
    owner_token_hash: overrides.owner_token_hash ?? hashOwnerToken(OWNER),
    status: "active",
    tier: "standard",
    target_url: url,
    target: overrides.target ?? { type: "url", url, render: "never", selector: null },
    condition: overrides.condition ?? { detector: "status_change", params: {} },
    condition_key: overrides.condition_key ?? "sentinel-bench".padEnd(64, "0"),
    interval_s: overrides.interval_s ?? SENTINEL_BENCH_INTERVAL_S,
    checks_remaining: overrides.checks_remaining ?? 2880,
    expires_at: overrides.expires_at ?? "2026-12-10T18:00:00Z",
    first_check_at: overrides.first_check_at ?? now,
    next_check_at: overrides.next_check_at ?? now,
    baseline: overrides.baseline ?? { captured: true, hash: observationHash("live", "2xx"), summary: "live 2xx (200)" },
    last_observation: overrides.last_observation ?? {
      status: "live",
      signals: ["apply form present"],
      http_status: 200,
      http_class: "2xx",
      hash: observationHash("live", "2xx"),
      summary: "live 2xx (200)",
      checked_at: now,
      canonical_url: url,
    },
    callback_url: overrides.callback_url ?? HOOK,
    callback_secret: overrides.callback_secret ?? SECRET,
    callback_deliver: "on_change",
    run: overrides.run ?? "none",
    chain_budget_usd: overrides.chain_budget_usd ?? null,
    chain_balance_atomic: overrides.chain_balance_atomic ?? 0,
    chain_spent_atomic: overrides.chain_spent_atomic ?? 0,
    label: overrides.label ?? "sentinel-bench",
    context_json: overrides.context_json ?? JSON.stringify({ bench: true }),
    created_at: now,
    claimed_until: null,
    consecutive_failures: 0,
    unreachable: false,
    expiring_emitted: false,
    detector_state: {},
    ...overrides,
  };
}

async function runHonestyOneShot(
  fetcher: typeof fetch,
  pages: Map<string, PageState>,
): Promise<{
  status_change: HonestySlice;
  text_diff: HonestySlice;
  true_positive: { status_change: boolean; text_diff: boolean };
}> {
  const cases = honestyCases(SENTINEL_BENCH_HONESTY_REPEATS);
  let statusFires = 0;
  let textFires = 0;
  let statusChecks = 0;
  let textChecks = 0;
  let statusBaseline: string | null = null;
  let textBaseline: string | null = null;
  let textBaselineText: string | null = null;
  let baselinePage: string | null = null;

  for (const c of cases) {
    const url = pageUrl(c.page, "honesty");
    if (baselinePage !== c.page) {
      statusBaseline = null;
      textBaseline = null;
      textBaselineText = null;
      baselinePage = c.page;
    }
    pages.set(url, { status: 200, html: htmlFor(c.page, { kind: c.kind, tick: c.tick }) });

    const statusParsed = parseCheckRequest({
      target: { type: "url", url, render: "never" },
      condition: { detector: "status_change", params: {} },
      baseline_hash: statusBaseline,
    });
    const status = await runCheck(statusParsed, fetcher);
    if (statusBaseline) {
      statusChecks += 1;
      if (status.fired === true) statusFires += 1;
    }
    statusBaseline = status.observation.hash;

    const textParsed = parseCheckRequest({
      target: { type: "url", url, render: "never" },
      condition: { detector: "text_diff", params: { selector: LISTING_TITLE_SELECTOR } },
      baseline_hash: textBaseline,
      baseline_text: textBaselineText,
    });
    const text = await runCheck(textParsed, fetcher);
    if (textBaseline) {
      textChecks += 1;
      if (text.fired === true) textFires += 1;
    }
    textBaseline = text.observation.hash;
    textBaselineText = text.content ?? textBaselineText;
  }
  const statusRate = statusChecks === 0 ? 0 : statusFires / statusChecks;
  const textRate = textChecks === 0 ? 0 : textFires / textChecks;

  const liveUrl = pageUrl("job", "tp-status");
  pages.set(liveUrl, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 0 }) });
  const live = await runCheck(
    parseCheckRequest({
      target: { type: "url", url: liveUrl, render: "never" },
      condition: { detector: "status_change", params: {} },
    }),
    fetcher,
  );
  pages.set(liveUrl, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 1 }, true) });
  const closed = await runCheck(
    parseCheckRequest({
      target: { type: "url", url: liveUrl, render: "never" },
      condition: { detector: "status_change", params: {} },
      baseline_hash: live.observation.hash,
    }),
    fetcher,
  );

  const prodUrl = pageUrl("product", "tp-text");
  pages.set(prodUrl, {
    status: 200,
    html: noisyProductHtml({ kind: "combined", tick: 0 }, { title: PRODUCT_TITLE, desc: PRODUCT_DESC }),
  });
  const before = await runCheck(
    parseCheckRequest({
      target: { type: "url", url: prodUrl, render: "never" },
      condition: { detector: "text_diff", params: { selector: LISTING_TITLE_SELECTOR } },
    }),
    fetcher,
  );
  pages.set(prodUrl, {
    status: 200,
    html: noisyProductHtml(
      { kind: "combined", tick: 1 },
      { title: `${PRODUCT_TITLE} Titanium`, desc: "Completely rewritten product story for collectors." },
    ),
  });
  const after = await runCheck(
    parseCheckRequest({
      target: { type: "url", url: prodUrl, render: "never" },
      condition: { detector: "text_diff", params: { selector: LISTING_TITLE_SELECTOR } },
      baseline_hash: before.observation.hash,
      baseline_text: before.content,
    }),
    fetcher,
  );

  return {
    status_change: {
      checks: statusChecks,
      fires: statusFires,
      false_positive_rate: statusRate,
      pass: statusFires === SENTINEL_STATUS_CHANGE_FP_GATE,
    },
    text_diff: {
      checks: textChecks,
      fires: textFires,
      false_positive_rate: textRate,
      pass: textRate <= SENTINEL_TEXT_DIFF_FP_GATE,
    },
    true_positive: {
      status_change: closed.fired === true && closed.observation.status === "closed",
      text_diff: after.fired === true,
    },
  };
}

async function runWatchHonesty(
  pages: Map<string, PageState>,
  hooks: DeliveredHook[],
  clock: { now: Date },
): Promise<number> {
  const url = pageUrl("job", "watch-honesty");
  const kinds: NoiseKind[] = ["clock", "counters", "tokens", "promo", "combined"];
  pages.set(url, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 0 }) });
  insertWatcher(
    stubWatcher({
      id: "wtc_01SENTINELHONESTY000000001",
      payer: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      condition_key: "honesty-status".padEnd(64, "0"),
      target_url: url,
      target: { type: "url", url, render: "never", selector: null },
      next_check_at: isoTs(clock.now),
    }),
  );
  const fetcher = makeFetcher(pages, hooks, () => clock.now.getTime());
  for (let i = 0; i < SENTINEL_BENCH_WATCH_TICKS; i += 1) {
    pages.set(url, { status: 200, html: noisyJobHtml({ kind: kinds[i % kinds.length] ?? "combined", tick: i + 1 }) });
    await tickDueWatchers(clock.now, fetcher);
    const row = getWatcher("wtc_01SENTINELHONESTY000000001");
    const next = row?.next_check_at ? new Date(row.next_check_at) : new Date(clock.now.getTime() + SENTINEL_BENCH_INTERVAL_S * 1000);
    clock.now = next;
  }
  const changes = listWatchEvents("wtc_01SENTINELHONESTY000000001").filter((event) => event.kind === "change").length;
  stopWatcher("wtc_01SENTINELHONESTY000000001");
  return changes;
}

const LATENCY_OFFSETS_S = [0, 5, 15, 30, 45, 60, 75, 90, 120, 150, 165, 180, 210, 225, 240, 255, 270, 285, 299, 300];

async function runLatency(
  pages: Map<string, PageState>,
  hooks: DeliveredHook[],
): Promise<{ samples: LatencySample[]; hmacVerified: number }> {
  const samples: LatencySample[] = [];
  let hmacVerified = 0;
  const t0 = Date.parse("2026-09-10T18:00:00Z");

  for (let i = 0; i < LATENCY_OFFSETS_S.length; i += 1) {
    const offset = LATENCY_OFFSETS_S[i] ?? 0;
    const id = `wtc_01SENTINELLAT${String(i).padStart(16, "0")}`;
    const url = pageUrl("job", `lat-${i}`, `https://bench-lat-${i}.livecheck.test`);
    const hookStart = hooks.length;
    pages.set(url, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 0 }) });
    const lastCheck = new Date(t0);
    const due = new Date(t0 + SENTINEL_BENCH_INTERVAL_S * 1000);
    insertWatcher(
      stubWatcher({
        id,
        payer: `0x${(0x100000000000 + i).toString(16).padStart(40, "0")}`,
        condition_key: `latency-${i}`.padEnd(64, "0"),
        target_url: url,
        target: { type: "url", url, render: "never", selector: null },
        interval_s: SENTINEL_BENCH_INTERVAL_S,
        first_check_at: isoTs(lastCheck),
        next_check_at: isoTs(due),
        created_at: isoTs(lastCheck),
      }),
    );

    const inject = new Date(t0 + offset * 1000);
    pages.set(url, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 99 + i }, true) });

    const clock = { now: inject };
    const fetcher = makeFetcher(pages, hooks, () => clock.now.getTime());
    const horizon = t0 + (2 * SENTINEL_BENCH_INTERVAL_S + 90) * 1000;
    let deliveredAt: number | null = null;

    for (let step = 0; step < 8; step += 1) {
      const row = getWatcher(id);
      if (!row) break;
      const nextDue = Date.parse(row.next_check_at);
      clock.now = new Date(Math.max(clock.now.getTime(), nextDue, inject.getTime()));
      if (clock.now.getTime() > horizon) break;
      await tickDueWatchers(clock.now, fetcher);
      const delivered = hooks.slice(hookStart).find((h) => {
        try {
          return (JSON.parse(h.body) as { watcher_id?: string; type?: string }).type === "change";
        } catch {
          return false;
        }
      });
      if (delivered) {
        deliveredAt = clock.now.getTime();
        if (verifyCallbackSignature(SECRET, delivered.body, delivered.header)) hmacVerified += 1;
        break;
      }
    }

    if (deliveredAt != null) {
      samples.push({ id, offset_s: offset, latency_ms: deliveredAt - inject.getTime() });
    }
    stopWatcher(id);
  }

  return { samples, hmacVerified };
}

async function runChain(
  pages: Map<string, PageState>,
  hooks: DeliveredHook[],
): Promise<ChainSlice> {
  const fundedId = "wtc_01SENTINELCHAINFUNDED0001";
  const skippedId = "wtc_01SENTINELCHAINSKIPPED001";
  const url = pageUrl("job", "chain");
  pages.set(url, { status: 200, html: noisyJobHtml({ kind: "combined", tick: 0 }) });
  const closedHash = observationHash("closed", "4xx");
  const now = new Date("2026-09-10T20:00:00Z");
  insertWatcher(
    stubWatcher({
      id: fundedId,
      payer: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      condition_key: "chain-funded".padEnd(64, "0"),
      target_url: url,
      target: { type: "url", url, render: "never", selector: null },
      run: "verify",
      chain_budget_usd: 5,
      chain_balance_atomic: 500_000,
      next_check_at: isoTs(now),
      baseline: { captured: true, hash: closedHash, summary: "closed 4xx (404)" },
      last_observation: {
        status: "closed",
        signals: ["http 404"],
        http_status: 404,
        http_class: "4xx",
        hash: closedHash,
        summary: "closed 4xx (404)",
        checked_at: isoTs(now),
        canonical_url: url,
      },
    }),
  );
  insertWatcher(
    stubWatcher({
      id: skippedId,
      payer: "0xcccccccccccccccccccccccccccccccccccccccc",
      condition_key: "chain-skip".padEnd(64, "0"),
      target_url: url,
      target: { type: "url", url, render: "never", selector: null },
      run: "verify",
      chain_budget_usd: 5,
      chain_balance_atomic: 0,
      next_check_at: isoTs(now),
      baseline: { captured: true, hash: closedHash, summary: "closed 4xx (404)" },
      last_observation: {
        status: "closed",
        signals: ["http 404"],
        http_status: 404,
        http_class: "4xx",
        hash: closedHash,
        summary: "closed 4xx (404)",
        checked_at: isoTs(now),
        canonical_url: url,
      },
    }),
  );

  const clock = { now };
  const fetcher = makeFetcher(pages, hooks, () => clock.now.getTime());
  await tickDueWatchers(clock.now, fetcher);
  clock.now = new Date(clock.now.getTime() + WATCH_CONFIRM_REFETCH_MS);
  await tickDueWatchers(clock.now, fetcher);

  const funded = listWatchEvents(fundedId).find((event) => event.kind === "change");
  const skipped = listWatchEvents(skippedId).find((event) => event.kind === "change");
  const fundedPayload = funded ? (JSON.parse(funded.payload_json) as {
    chain?: { run?: string; result?: { status?: string }; debit_usd?: number; skipped?: string };
  }) : {};
  const skippedPayload = skipped ? (JSON.parse(skipped.payload_json) as {
    chain?: { skipped?: string; result?: unknown };
  }) : {};

  const funded_attached =
    fundedPayload.chain?.run === "verify" &&
    fundedPayload.chain.result?.status === "live" &&
    fundedPayload.chain.debit_usd === 0.01 &&
    getWatcher(fundedId)?.chain_balance_atomic === 490_000;
  const skippedOk = skippedPayload.chain?.skipped === "insufficient_balance" && skippedPayload.chain.result === undefined;

  return {
    funded_attached,
    funded_debit_usd: fundedPayload.chain?.debit_usd ?? null,
    funded_status: fundedPayload.chain?.result?.status ?? null,
    skipped: skippedOk,
    skipped_reason: skippedPayload.chain?.skipped ?? null,
    pass: funded_attached && skippedOk,
  };
}

export async function runSentinelBench(): Promise<SentinelBenchReport> {
  initWatchStore(":memory:");
  const pages = new Map<string, PageState>();
  const hooks: DeliveredHook[] = [];
  const clock = { now: new Date("2026-09-10T18:00:00Z") };
  const fetcher = makeFetcher(pages, hooks, () => clock.now.getTime());

  try {
    const honesty = await runHonestyOneShot(fetcher, pages);
    const watchChangeEvents = await runWatchHonesty(pages, hooks, clock);
    const { samples, hmacVerified } = await runLatency(pages, hooks);
    const chain = await runChain(pages, hooks);
    const hmacUnit = hmacUnitPass();
    const confirmDeferred = confirmOnChangeDeferred();

    const p50 = percentile(samples.map((s) => s.latency_ms), 0.5);
    const p95 = percentile(samples.map((s) => s.latency_ms), 0.95);
    const p50Gate = (SENTINEL_BENCH_INTERVAL_S + 60) * 1000;
    const p95Gate = 2 * SENTINEL_BENCH_INTERVAL_S * 1000;
    const latencyPass = samples.length === LATENCY_OFFSETS_S.length && p50 <= p50Gate && p95 <= p95Gate;

    honesty.status_change.pass =
      honesty.status_change.fires === SENTINEL_STATUS_CHANGE_FP_GATE && watchChangeEvents === 0;
    const hmacPass = hmacUnit && hmacVerified === samples.length && samples.length > 0;

    const gates: GateResult[] = [
      {
        id: "status_change_fp",
        gate: "status_change false fires = 0 and watch change events = 0 on noisy fixtures",
        pass: honesty.status_change.pass,
        detail: `fires=${honesty.status_change.fires}/${honesty.status_change.checks} watch_change_events=${watchChangeEvents}`,
      },
      {
        id: "text_diff_fp",
        gate: `text_diff with selector ${LISTING_TITLE_SELECTOR} false-fire rate ≤ ${SENTINEL_TEXT_DIFF_FP_GATE}`,
        pass: honesty.text_diff.pass,
        detail: `rate=${honesty.text_diff.false_positive_rate.toFixed(4)} fires=${honesty.text_diff.fires}/${honesty.text_diff.checks}`,
      },
      {
        id: "true_positive",
        gate: "injected live→closed and title rewrite still fire",
        pass: honesty.true_positive.status_change && honesty.true_positive.text_diff,
        detail: `status_change=${honesty.true_positive.status_change} text_diff=${honesty.true_positive.text_diff}`,
      },
      {
        id: "latency_p50",
        gate: `p50 ≤ interval_s + 60s (${SENTINEL_BENCH_INTERVAL_S + 60}s)`,
        pass: samples.length > 0 && p50 <= p50Gate,
        detail: `p50=${Math.round(p50)}ms n=${samples.length}`,
      },
      {
        id: "latency_p95",
        gate: `p95 ≤ 2×interval_s (${2 * SENTINEL_BENCH_INTERVAL_S}s)`,
        pass: samples.length > 0 && p95 <= p95Gate,
        detail: `p95=${Math.round(p95)}ms n=${samples.length}`,
      },
      {
        id: "hmac",
        gate: HMAC_RECIPE,
        pass: hmacPass,
        detail: `unit=${hmacUnit} delivered_verified=${hmacVerified}/${samples.length}`,
      },
      {
        id: "chain_verify",
        gate: "on_change.verify + balance attaches result; insufficient → skipped",
        pass: chain.pass,
        detail: `funded_attached=${chain.funded_attached} skipped=${chain.skipped_reason ?? "no"}`,
      },
      {
        id: "on_change_confirm_deferred",
        gate: "on_change.run=confirm stays rejected (Confirm chain deferred)",
        pass: confirmDeferred,
        detail: confirmDeferred ? "parseWatchRequest throws invalid_target" : "confirm was accepted",
      },
    ];

    return {
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      scale: {
        honesty_repeats: SENTINEL_BENCH_HONESTY_REPEATS,
        honesty_checks_per_detector: Math.max(0, honestyCases(SENTINEL_BENCH_HONESTY_REPEATS).length - 1),
        watch_ticks: SENTINEL_BENCH_WATCH_TICKS,
        latency_samples: LATENCY_OFFSETS_S.length,
        interval_s: SENTINEL_BENCH_INTERVAL_S,
        note: "CI/local scale — not a 1000-watcher 24h soak. Virtual time for latency; no Fly deploy; no real $2.50 spends.",
      },
      honesty: {
        ...honesty,
        watch_change_events: watchChangeEvents,
      },
      latency: {
        interval_s: SENTINEL_BENCH_INTERVAL_S,
        n: samples.length,
        p50_ms: Math.round(p50),
        p95_ms: Math.round(p95),
        p50_gate_ms: p50Gate,
        p95_gate_ms: p95Gate,
        samples,
        pass: latencyPass,
      },
      hmac: {
        recipe: HMAC_RECIPE,
        unit_pass: hmacUnit,
        delivered: samples.length,
        verified: hmacVerified,
        pass: hmacPass,
      },
      chain,
      on_change_confirm_deferred: confirmDeferred,
      gates,
      pass: gates.every((g) => g.pass),
    };
  } finally {
    closeWatchStore();
  }
}

export function formatSentinelBenchText(report: SentinelBenchReport): string {
  const lines = [
    "sentinel honesty + latency bench (acceptance checklist light)",
    `interval_s=${report.scale.interval_s} honesty_checks=${report.scale.honesty_checks_per_detector} latency_n=${report.latency.n}`,
    `status_change FP=${report.honesty.status_change.fires}/${report.honesty.status_change.checks} watch_change_events=${report.honesty.watch_change_events}`,
    `text_diff FP rate=${report.honesty.text_diff.false_positive_rate.toFixed(4)} (${report.honesty.text_diff.fires}/${report.honesty.text_diff.checks}) selector=${LISTING_TITLE_SELECTOR}`,
    `latency p50=${report.latency.p50_ms}ms p95=${report.latency.p95_ms}ms gates p50≤${report.latency.p50_gate_ms}ms p95≤${report.latency.p95_gate_ms}ms`,
    `hmac recipe: ${report.hmac.recipe}`,
    `hmac unit=${report.hmac.unit_pass} verified=${report.hmac.verified}/${report.hmac.delivered}`,
    `chain funded_attached=${report.chain.funded_attached} skipped=${report.chain.skipped_reason}`,
    `on_change.confirm deferred=${report.on_change_confirm_deferred}`,
    report.pass ? "GATES PASS" : "GATES FAIL",
  ];
  for (const gate of report.gates) {
    lines.push(`  ${gate.pass ? "PASS" : "FAIL"} ${gate.id} — ${gate.detail}`);
  }
  return lines.join("\n");
}

export function formatSentinelBenchMarkdown(report: SentinelBenchReport): string {
  const rows = report.gates
    .map((g) => `| ${g.pass ? "PASS" : "FAIL"} | ${g.id} | ${g.gate} | ${g.detail} |`)
    .join("\n");
  return `# Sentinel benches (acceptance checklist light)

Local/CI scale — not a 1000-watcher 24h soak. No Fly deploy, no Bazaar GA push, no price changes, no real $2.50 spends. Confirm chain (\`on_change.run=confirm\`) stays deferred.

Generated: \`${report.generated_at}\`

## Commands

\`\`\`bash
npm run bench:sentinel
npm test -- test/sentinel-bench.test.ts
\`\`\`

## Scale

| Knob | Value |
| --- | --- |
| honesty repeats / noise kind | ${report.scale.honesty_repeats} |
| honesty checks / detector | ${report.scale.honesty_checks_per_detector} |
| watch honesty ticks | ${report.scale.watch_ticks} |
| latency samples | ${report.scale.latency_samples} |
| interval_s | ${report.scale.interval_s} |

${report.scale.note}

Fixtures rotate timestamps, view/sold counters, session/CSRF tokens, ad slots, cookie banners, and promo copy. \`text_diff\` uses selector \`${LISTING_TITLE_SELECTOR}\`. \`GET /stats\` Sentinel bench fields stay structured **null** (no dispute endpoint / no published live rate).

## Gate results

| Result | Id | Gate | Detail |
| --- | --- | --- | --- |
${rows}

**Overall: ${report.pass ? "PASS" : "FAIL"}**

## Honesty

| Detector | Checks | Fires | FP rate | Gate | Pass |
| --- | ---: | ---: | ---: | --- | --- |
| status_change | ${report.honesty.status_change.checks} | ${report.honesty.status_change.fires} | ${report.honesty.status_change.false_positive_rate.toFixed(4)} | 0 fires + 0 watch \`change\` events | ${report.honesty.status_change.pass ? "PASS" : "FAIL"} |
| text_diff + selector | ${report.honesty.text_diff.checks} | ${report.honesty.text_diff.fires} | ${report.honesty.text_diff.false_positive_rate.toFixed(4)} | ≤ 2% | ${report.honesty.text_diff.pass ? "PASS" : "FAIL"} |

Watch \`change\` events on noisy-only ticks: **${report.honesty.watch_change_events}**

True-positive sanity: status_change live→closed **${report.honesty.true_positive.status_change}**; text_diff title rewrite **${report.honesty.true_positive.text_diff}**.

## Latency (virtual time)

Detection + HMAC callback delivery after an injected fixture change. Standard 2-of-3 (~20s confirm re-fetch) is included.

| Metric | Value | Gate |
| --- | ---: | ---: |
| n | ${report.latency.n} | ${report.scale.latency_samples} samples |
| p50 | ${report.latency.p50_ms} ms | ≤ ${report.latency.p50_gate_ms} ms (\`interval_s + 60s\`) |
| p95 | ${report.latency.p95_ms} ms | ≤ ${report.latency.p95_gate_ms} ms (\`2×interval_s\`) |

Pass: **${report.latency.pass ? "PASS" : "FAIL"}**

## HMAC

Recipe: \`${report.hmac.recipe}\`

Unit assertion (same as \`test/watch-callback.test.ts\`): **${report.hmac.unit_pass ? "PASS" : "FAIL"}**. Delivered latency callbacks verified: **${report.hmac.verified}/${report.hmac.delivered}**.

## Chain Verify

Mock/internal only — \`resolveChangeChain\` via the scheduler; no public \`POST /v1/verify\`, no facilitator fee.

| Path | Result |
| --- | --- |
| \`on_change.run=verify\` + $0.50 balance | attached=${report.chain.funded_attached} status=${report.chain.funded_status} debit=${report.chain.funded_debit_usd} |
| insufficient balance | skipped=${report.chain.skipped} reason=${report.chain.skipped_reason} |

\`on_change.run=confirm\` deferred: **${report.on_change_confirm_deferred}**

## Held

- Bazaar GA listing push
- Fly deploy
- GitHub moyecj-snap mirror
- Price changes
- Real $2.50 watch spends
`;
}
