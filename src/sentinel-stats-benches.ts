import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Landed main commit that recorded `bench/sentinel-report.json` (all gates PASS). */
export const SENTINEL_BENCH_COMMIT = "590627c";
export const SENTINEL_BENCH_REPORT_DOC = "docs/sentinel-benches.md";
export const SENTINEL_BENCH_REPORT_JSON = "bench/sentinel-report.json";
export const SENTINEL_BENCH_FP_GATE = "status_change=0; text_diff<=0.02";
export const SENTINEL_BENCH_NOTE =
  "CI/local scale benches; not a 1000-watcher 24h soak.";

export type SentinelFalsePositiveRate = {
  status_change: number;
  text_diff: number;
  n_checks: number;
  gate: string;
};

export type SentinelHmacBench = {
  verified: number;
  delivered: number;
  pass: boolean;
};

export type SentinelBenches = {
  false_positive_rate: SentinelFalsePositiveRate;
  median_latency_ms: number;
  latency_p95_ms: number;
  interval_s: number;
  hmac: SentinelHmacBench;
  chain_verify: "pass" | "fail";
  report: string;
  commit: string;
  note: string;
};

export type SentinelBenchesLoad = {
  benches: SentinelBenches;
  source: "report" | "fallback";
  path?: string;
};

/**
 * Hardcoded values from `bench/sentinel-report.json` on main @ 590627c.
 * Fly always has numbers even when the JSON is not in the image.
 */
export const FALLBACK_SENTINEL_BENCHES: SentinelBenches = {
  false_positive_rate: {
    status_change: 0,
    text_diff: 0,
    n_checks: 198,
    gate: SENTINEL_BENCH_FP_GATE,
  },
  median_latency_ms: 162500,
  latency_p95_ms: 315250,
  interval_s: 300,
  hmac: { verified: 20, delivered: 20, pass: true },
  chain_verify: "pass",
  report: SENTINEL_BENCH_REPORT_DOC,
  commit: SENTINEL_BENCH_COMMIT,
  note: SENTINEL_BENCH_NOTE,
};

type LoadedReport = {
  honesty?: {
    status_change?: { false_positive_rate?: unknown; checks?: unknown };
    text_diff?: { false_positive_rate?: unknown; checks?: unknown };
  };
  latency?: { p50_ms?: unknown; p95_ms?: unknown; interval_s?: unknown };
  hmac?: { verified?: unknown; delivered?: unknown; pass?: unknown };
  chain?: { pass?: unknown };
  scale?: { interval_s?: unknown; honesty_checks_per_detector?: unknown };
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function sentinelReportCandidates(): string[] {
  const cwd = process.cwd();
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(cwd, SENTINEL_BENCH_REPORT_JSON),
    resolve(here, "..", SENTINEL_BENCH_REPORT_JSON),
  ];
}

export function benchesFromSentinelReport(raw: LoadedReport): SentinelBenches | null {
  const statusRate = raw.honesty?.status_change?.false_positive_rate;
  const textRate = raw.honesty?.text_diff?.false_positive_rate;
  const nChecks =
    raw.honesty?.status_change?.checks ?? raw.scale?.honesty_checks_per_detector;
  const p50 = raw.latency?.p50_ms;
  const p95 = raw.latency?.p95_ms;
  const interval = raw.latency?.interval_s ?? raw.scale?.interval_s;
  if (
    !isFiniteNumber(statusRate) ||
    !isFiniteNumber(textRate) ||
    !isFiniteNumber(nChecks) ||
    !isFiniteNumber(p50) ||
    !isFiniteNumber(p95) ||
    !isFiniteNumber(interval)
  ) {
    return null;
  }

  const hmacVerified = isFiniteNumber(raw.hmac?.verified) ? raw.hmac.verified : FALLBACK_SENTINEL_BENCHES.hmac.verified;
  const hmacDelivered = isFiniteNumber(raw.hmac?.delivered)
    ? raw.hmac.delivered
    : FALLBACK_SENTINEL_BENCHES.hmac.delivered;
  const hmacPass = typeof raw.hmac?.pass === "boolean" ? raw.hmac.pass : hmacVerified === hmacDelivered && hmacDelivered > 0;
  const chainPass = raw.chain?.pass === true;

  return {
    false_positive_rate: {
      status_change: statusRate,
      text_diff: textRate,
      n_checks: nChecks,
      gate: SENTINEL_BENCH_FP_GATE,
    },
    median_latency_ms: p50,
    latency_p95_ms: p95,
    interval_s: interval,
    hmac: { verified: hmacVerified, delivered: hmacDelivered, pass: hmacPass },
    chain_verify: chainPass ? "pass" : "fail",
    report: SENTINEL_BENCH_REPORT_DOC,
    commit: SENTINEL_BENCH_COMMIT,
    note: SENTINEL_BENCH_NOTE,
  };
}

function tryLoadReport(path: string): SentinelBenches | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LoadedReport;
    return benchesFromSentinelReport(parsed);
  } catch {
    return null;
  }
}

export function resolveSentinelBenches(explicitPath?: string | null): SentinelBenchesLoad {
  const paths = explicitPath === null ? [] : explicitPath !== undefined ? [explicitPath] : sentinelReportCandidates();
  for (const path of paths) {
    const benches = tryLoadReport(path);
    if (benches) return { benches, source: "report", path };
  }
  return { benches: { ...FALLBACK_SENTINEL_BENCHES }, source: "fallback" };
}

let loaded: SentinelBenchesLoad = resolveSentinelBenches();

export function loadSentinelBenches(): SentinelBenches {
  return loaded.benches;
}

export function sentinelBenchesLoadInfo(): SentinelBenchesLoad {
  return loaded;
}

/** Test helper — re-read the report (or force fallback when path is null). */
export function resetSentinelBenches(explicitPath?: string | null): SentinelBenchesLoad {
  loaded = resolveSentinelBenches(explicitPath);
  return loaded;
}
