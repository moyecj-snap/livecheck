import { classify } from "./classify.js";
import { jobRedirectBenchCases, type JobBenchCase, type JobBenchExpect } from "./job-redirect-bench-cases.js";
import type { FetchedPage } from "./types.js";

export type JobBenchFailure = {
  id: string;
  bucket: string;
  expect: JobBenchExpect;
  got: string;
  reason: "closed_to_live" | "expect_mismatch";
};

export type JobBenchReport = {
  n: number;
  live: number;
  closed: number;
  unknown: number;
  closed_to_live: number;
  false_live: number;
  expect_mismatches: number;
  failures: JobBenchFailure[];
};

function pageFromCase(c: JobBenchCase): FetchedPage {
  const html = c.html;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    requestedUrl: c.requestedUrl,
    canonicalUrl: c.canonicalUrl,
    httpStatus: c.httpStatus,
    title: titleMatch?.[1]?.trim() ?? null,
    html,
    text: html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    redirected: c.redirected,
    redirectChain: c.redirected ? [c.canonicalUrl] : [],
  };
}

export function runJobRedirectBench(cases: JobBenchCase[] = jobRedirectBenchCases()): JobBenchReport {
  const failures: JobBenchFailure[] = [];
  let live = 0;
  let closed = 0;
  let unknown = 0;
  for (const c of cases) {
    const got = classify(pageFromCase(c)).status;
    if (got === "live") live += 1;
    else if (got === "closed") closed += 1;
    else unknown += 1;
    if (c.expect === "closed" && got === "live") {
      failures.push({ id: c.id, bucket: c.bucket, expect: c.expect, got, reason: "closed_to_live" });
    } else if (got !== c.expect) {
      failures.push({ id: c.id, bucket: c.bucket, expect: c.expect, got, reason: "expect_mismatch" });
    }
  }
  return {
    n: cases.length,
    live,
    closed,
    unknown,
    closed_to_live: failures.filter((f) => f.reason === "closed_to_live").length,
    false_live: failures.filter((f) => f.expect !== "live" && f.got === "live").length,
    expect_mismatches: failures.filter((f) => f.reason === "expect_mismatch").length,
    failures,
  };
}

export function formatJobBenchReport(report: JobBenchReport): string {
  const lines = [
    "job redirect bench",
    `N=${report.n}`,
    `live=${report.live} closed=${report.closed} unknown=${report.unknown}`,
    `closed_to_live=${report.closed_to_live}`,
    `false_live=${report.false_live}`,
    `expect_mismatches=${report.expect_mismatches}`,
  ];
  for (const failure of report.failures) {
    lines.push(`  ${failure.reason} ${failure.id} expect=${failure.expect} got=${failure.got}`);
  }
  return lines.join("\n");
}
