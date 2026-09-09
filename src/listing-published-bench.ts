import { classify } from "./classify.js";
import { classifyListingPublished } from "./listing-published.js";
import {
  listingPublishedBenchCases,
  type BenchExpect,
  type ListingPublishedBenchCase,
} from "./listing-published-bench-cases.js";
import type { ConfirmVerdictStatus, FetchedPage, VerifyVerdict } from "./types.js";

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
  true_live: number;
  true_closed: number;
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

function pageFromCase(c: ListingPublishedBenchCase): FetchedPage {
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
    redirected: Boolean(c.redirected),
    redirectChain: c.redirected && c.canonicalUrl ? [c.canonicalUrl] : [],
  };
}

export function runListingPublishedCase(c: ListingPublishedBenchCase): ConfirmVerdictStatus {
  if (c.verify) {
    const verify: VerifyVerdict = {
      url: c.url,
      canonical_url: c.canonicalUrl ?? c.url,
      status: c.verify.status,
      http_status: c.verify.http_status,
      checked_at: "2026-09-09T00:00:00Z",
      signals: [...c.verify.signals],
      confidence: c.verify.confidence ?? 0.5,
      price_usd: 0.01,
      ...(c.verify.title ? { title: c.verify.title } : {}),
    };
    const page = c.html ? pageFromCase(c) : undefined;
    return classifyListingPublished(verify, {
      cookiesUsed: c.cookiesUsed,
      claim: c.claim,
      page,
    }).verdict;
  }
  const page = pageFromCase(c);
  const verify = classify(page);
  return classifyListingPublished(verify, {
    cookiesUsed: c.cookiesUsed,
    claim: c.claim,
    page,
  }).verdict;
}

export function runListingPublishedBench(
  cases: ListingPublishedBenchCase[] = listingPublishedBenchCases(),
): BenchReport {
  const failures: BenchFailure[] = [];
  let confirmed = 0;
  let failed = 0;
  let unknown = 0;
  let false_confirmed = 0;

  for (const c of cases) {
    const got = runListingPublishedCase(c);
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
    true_live: cases.filter((c) => c.bucket === "true_live").length,
    true_closed: cases.filter((c) => c.bucket === "true_closed").length,
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
    "listing_published honesty bench",
    `N=${report.n}`,
    `true_live=${report.true_live} true_closed=${report.true_closed} trap=${report.trap}`,
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
