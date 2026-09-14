import { classifyLeadSubmit } from "./confirm.js";
import {
  leadSubmitBenchCases,
  type BenchExpect,
  type LeadSubmitBenchCase,
} from "./lead-submit-bench-cases.js";
import type { ConfirmVerdictStatus, FetchedPage } from "./types.js";

export type BenchFailure = {
  id: string;
  bucket: string;
  expect: BenchExpect;
  got: ConfirmVerdictStatus;
  reason: "false_confirmed" | "expect_mismatch";
  signals: string[];
};

export type BenchReport = {
  n: number;
  true_submitted: number;
  true_failed: number;
  trap: number;
  confirmed: number;
  failed: number;
  unknown: number;
  false_confirmed: number;
  expect_mismatches: number;
  false_confirmed_ids: string[];
  failures: BenchFailure[];
  fc_zero: boolean;
};

function pageFromCase(c: LeadSubmitBenchCase): FetchedPage {
  const html = c.html ?? "";
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const requestedUrl = c.url;
  const canonicalUrl = c.canonicalUrl ?? requestedUrl;
  return {
    requestedUrl,
    canonicalUrl,
    httpStatus: c.httpStatus ?? 200,
    title: c.title ?? titleMatch?.[1]?.trim() ?? null,
    html,
    text: html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    redirected: false,
    redirectChain: [],
  };
}

export function runLeadSubmitCase(c: LeadSubmitBenchCase): ConfirmVerdictStatus {
  const page = pageFromCase(c);
  return classifyLeadSubmit(page, { cookiesUsed: c.cookiesUsed }).verdict;
}

export function runLeadSubmitBench(cases: LeadSubmitBenchCase[] = leadSubmitBenchCases()): BenchReport {
  const failures: BenchFailure[] = [];
  let confirmed = 0;
  let failed = 0;
  let unknown = 0;
  let false_confirmed = 0;

  for (const c of cases) {
    const got = runLeadSubmitCase(c);
    if (got === "confirmed") confirmed += 1;
    else if (got === "failed") failed += 1;
    else unknown += 1;

    const isFalseConfirmed = got === "confirmed" && c.expect !== "confirmed";
    if (isFalseConfirmed) {
      false_confirmed += 1;
      failures.push({
        id: c.id,
        bucket: c.bucket,
        expect: c.expect,
        got,
        reason: "false_confirmed",
        signals: [],
      });
    } else if (got !== c.expect) {
      failures.push({
        id: c.id,
        bucket: c.bucket,
        expect: c.expect,
        got,
        reason: "expect_mismatch",
        signals: [],
      });
    }
  }

  return {
    n: cases.length,
    true_submitted: cases.filter((c) => c.bucket === "true_submitted").length,
    true_failed: cases.filter((c) => c.bucket === "true_failed").length,
    trap: cases.filter((c) => c.bucket === "trap").length,
    confirmed,
    failed,
    unknown,
    false_confirmed,
    expect_mismatches: failures.filter((f) => f.reason === "expect_mismatch").length,
    false_confirmed_ids: failures.filter((f) => f.reason === "false_confirmed").map((f) => f.id),
    failures,
    fc_zero: false_confirmed === 0,
  };
}

export function formatBenchReport(report: BenchReport): string {
  const lines = [
    "lead_submit honesty bench",
    `N=${report.n}`,
    `true_submitted=${report.true_submitted} true_failed=${report.true_failed} trap=${report.trap}`,
    `confirmed=${report.confirmed} failed=${report.failed} unknown=${report.unknown}`,
    `false_confirmed=${report.false_confirmed}`,
    `expect_mismatches=${report.expect_mismatches}`,
    report.fc_zero ? "FC=0 PASS" : "FC≠0 FAIL",
  ];
  if (report.failures.length) {
    lines.push("failures:");
    for (const failure of report.failures) {
      lines.push(`  ${failure.reason} ${failure.id} expect=${failure.expect} got=${failure.got}`);
    }
  }
  return lines.join("\n");
}
