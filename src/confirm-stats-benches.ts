import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Landed main commits that recorded the listing / order honesty reports. */
export const LISTING_PUBLISHED_BENCH_COMMIT = "b10322b";
export const ORDER_PLACED_BENCH_COMMIT = "0e9faa1";
/** This branch's recorded lead_submit honesty report (FC=0, N=77). */
export const LEAD_SUBMIT_BENCH_COMMIT = "a17f56b";

export const CONFIRM_BENCH_REPORT_DOC = "docs/confirm-benches.md";
export const LEAD_SUBMIT_BENCH_REPORT_JSON = "bench/lead-submit-report.json";
export const LISTING_PUBLISHED_BENCH_REPORT_JSON = "bench/listing-published-report.json";
export const ORDER_PLACED_BENCH_REPORT_JSON = "bench/order-placed-report.json";

export const CONFIRM_BENCH_NOTE =
  "CI/local honesty benches; not a live dispute rate. Do not infer a false-confirmed rate from paid_calls.";

export type ConfirmIntentName = "lead_submit" | "listing_published" | "order_placed";

export type ConfirmIntentBench = {
  false_confirmed_rate: number;
  n: number;
  false_confirmed: number;
  report: string;
  commit: string;
};

export type ConfirmBenches = {
  lead_submit: ConfirmIntentBench;
  listing_published: ConfirmIntentBench;
  order_placed: ConfirmIntentBench;
  note: string;
  report: string;
};

export type ConfirmBenchesLoad = {
  benches: ConfirmBenches;
  source: "report" | "fallback" | "mixed";
  paths?: Partial<Record<ConfirmIntentName, string>>;
};

/**
 * Hardcoded values from the landed Confirm honesty reports.
 * Fly always has numbers even when the JSON is not in the image.
 */
export const FALLBACK_CONFIRM_BENCHES: ConfirmBenches = {
  lead_submit: {
    false_confirmed_rate: 0,
    n: 77,
    false_confirmed: 0,
    report: LEAD_SUBMIT_BENCH_REPORT_JSON,
    commit: LEAD_SUBMIT_BENCH_COMMIT,
  },
  listing_published: {
    false_confirmed_rate: 0,
    n: 102,
    false_confirmed: 0,
    report: LISTING_PUBLISHED_BENCH_REPORT_JSON,
    commit: LISTING_PUBLISHED_BENCH_COMMIT,
  },
  order_placed: {
    false_confirmed_rate: 0,
    n: 100,
    false_confirmed: 0,
    report: ORDER_PLACED_BENCH_REPORT_JSON,
    commit: ORDER_PLACED_BENCH_COMMIT,
  },
  note: CONFIRM_BENCH_NOTE,
  report: CONFIRM_BENCH_REPORT_DOC,
};

type LoadedIntentReport = {
  n?: unknown;
  false_confirmed?: unknown;
};

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

const INTENT_FILES: Record<ConfirmIntentName, { json: string; commit: string }> = {
  lead_submit: { json: LEAD_SUBMIT_BENCH_REPORT_JSON, commit: LEAD_SUBMIT_BENCH_COMMIT },
  listing_published: { json: LISTING_PUBLISHED_BENCH_REPORT_JSON, commit: LISTING_PUBLISHED_BENCH_COMMIT },
  order_placed: { json: ORDER_PLACED_BENCH_REPORT_JSON, commit: ORDER_PLACED_BENCH_COMMIT },
};

export function confirmReportCandidates(): Record<ConfirmIntentName, string[]> {
  const cwd = process.cwd();
  const here = dirname(fileURLToPath(import.meta.url));
  const roots = [cwd, resolve(here, "..")];
  const out = {} as Record<ConfirmIntentName, string[]>;
  for (const intent of Object.keys(INTENT_FILES) as ConfirmIntentName[]) {
    out[intent] = roots.map((root) => resolve(root, INTENT_FILES[intent].json));
  }
  return out;
}

export function benchFromConfirmIntentReport(
  intent: ConfirmIntentName,
  raw: LoadedIntentReport,
): ConfirmIntentBench | null {
  const n = raw.n;
  const falseConfirmed = raw.false_confirmed;
  if (!isFiniteNumber(n) || n <= 0 || !isFiniteNumber(falseConfirmed) || falseConfirmed < 0) {
    return null;
  }
  return {
    false_confirmed_rate: falseConfirmed / n,
    n,
    false_confirmed: falseConfirmed,
    report: INTENT_FILES[intent].json,
    commit: INTENT_FILES[intent].commit,
  };
}

function tryLoadIntentReport(intent: ConfirmIntentName, path: string): ConfirmIntentBench | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as LoadedIntentReport;
    return benchFromConfirmIntentReport(intent, parsed);
  } catch {
    return null;
  }
}

export function resolveConfirmBenches(
  explicit?: Partial<Record<ConfirmIntentName, string | null>> | null,
): ConfirmBenchesLoad {
  const fallback = structuredClone(FALLBACK_CONFIRM_BENCHES);
  if (explicit === null) {
    return { benches: fallback, source: "fallback" };
  }

  const candidates = confirmReportCandidates();
  const benches = structuredClone(FALLBACK_CONFIRM_BENCHES);
  const paths: Partial<Record<ConfirmIntentName, string>> = {};
  let fromReport = 0;

  for (const intent of Object.keys(INTENT_FILES) as ConfirmIntentName[]) {
    const override = explicit?.[intent];
    const search = override === null ? [] : override !== undefined ? [override] : candidates[intent];
    let loaded: ConfirmIntentBench | null = null;
    let loadedPath: string | undefined;
    for (const path of search) {
      loaded = tryLoadIntentReport(intent, path);
      if (loaded) {
        loadedPath = path;
        break;
      }
    }
    if (loaded && loadedPath) {
      benches[intent] = loaded;
      paths[intent] = loadedPath;
      fromReport += 1;
    }
  }

  const source = fromReport === 3 ? "report" : fromReport === 0 ? "fallback" : "mixed";
  return { benches, source, ...(Object.keys(paths).length ? { paths } : {}) };
}

let loaded: ConfirmBenchesLoad = resolveConfirmBenches();

export function loadConfirmBenches(): ConfirmBenches {
  return loaded.benches;
}

export function confirmBenchesLoadInfo(): ConfirmBenchesLoad {
  return loaded;
}

/** Test helper — re-read reports (or force fallback when path map is null). */
export function resetConfirmBenches(
  explicit?: Partial<Record<ConfirmIntentName, string | null>> | null,
): ConfirmBenchesLoad {
  loaded = resolveConfirmBenches(explicit);
  return loaded;
}
