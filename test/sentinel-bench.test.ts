import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import {
  SENTINEL_BENCH_INTERVAL_S,
  SENTINEL_STATUS_CHANGE_FP_GATE,
  SENTINEL_TEXT_DIFF_FP_GATE,
  runSentinelBench,
  type SentinelBenchReport,
} from "../src/sentinel-bench.js";
import { compileAndApplyIgnore } from "../src/ignore-defaults.js";
import { noisyJobHtml, noisyProductHtml } from "../src/sentinel-bench-fixtures.js";
import { textDiffHash } from "../src/text-diff.js";

describe("Sentinel honesty + latency benches", () => {
  let report: SentinelBenchReport;

  before(async () => {
    report = await runSentinelBench();
  });

  it("strips rotating noise so listing titles hash equal", () => {
    const a = noisyJobHtml({ kind: "combined", tick: 0 });
    const b = noisyJobHtml({ kind: "promo", tick: 7 });
    const title = (html: string) => {
      const match = html.match(/<h1 class="listing-title">([\s\S]*?)<\/h1>/);
      return compileAndApplyIgnore((match?.[1] ?? "").replace(/<[^>]+>/g, " "));
    };
    assert.equal(textDiffHash(title(a)), textDiffHash(title(b)));
    const pa = noisyProductHtml({ kind: "clock", tick: 1 });
    const pb = noisyProductHtml({ kind: "tokens", tick: 9 });
    assert.equal(textDiffHash(title(pa)), textDiffHash(title(pb)));
  });

  it("gates status_change false positives at 0 (one-shot + watch events)", () => {
    assert.equal(report.honesty.status_change.fires, SENTINEL_STATUS_CHANGE_FP_GATE);
    assert.equal(report.honesty.watch_change_events, 0);
    assert.equal(report.honesty.status_change.pass, true);
    assert.ok(report.honesty.status_change.checks >= 100, `expected ≥100 checks, got ${report.honesty.status_change.checks}`);
  });

  it("gates text_diff with selector at ≤ 2% false fires", () => {
    assert.ok(
      report.honesty.text_diff.false_positive_rate <= SENTINEL_TEXT_DIFF_FP_GATE,
      `text_diff FP=${report.honesty.text_diff.false_positive_rate}`,
    );
    assert.equal(report.honesty.text_diff.pass, true);
    assert.ok(report.honesty.true_positive.status_change);
    assert.ok(report.honesty.true_positive.text_diff);
  });

  it("reports latency p50 ≤ interval+60s and p95 ≤ 2×interval", () => {
    assert.equal(report.latency.interval_s, SENTINEL_BENCH_INTERVAL_S);
    assert.equal(report.latency.n, report.scale.latency_samples);
    assert.ok(report.latency.p50_ms <= report.latency.p50_gate_ms, `p50=${report.latency.p50_ms}`);
    assert.ok(report.latency.p95_ms <= report.latency.p95_gate_ms, `p95=${report.latency.p95_ms}`);
    assert.equal(report.latency.pass, true);
  });

  it("asserts HMAC recipe on unit + delivered callbacks", () => {
    assert.match(report.hmac.recipe, /X-Sentinel-Signature/);
    assert.match(report.hmac.recipe, /HMAC-SHA256/);
    assert.equal(report.hmac.unit_pass, true);
    assert.equal(report.hmac.verified, report.hmac.delivered);
    assert.ok(report.hmac.delivered > 0);
    assert.equal(report.hmac.pass, true);
  });

  it("attaches chain Verify when funded and skips when insufficient", () => {
    assert.equal(report.chain.funded_attached, true);
    assert.equal(report.chain.funded_debit_usd, 0.01);
    assert.equal(report.chain.funded_status, "live");
    assert.equal(report.chain.skipped, true);
    assert.equal(report.chain.skipped_reason, "insufficient_balance");
    assert.equal(report.chain.pass, true);
  });

  it("accepts on_change.run=confirm and attaches a receipt when funded", () => {
    assert.equal(report.on_change_confirm_accepted, true);
    assert.equal(report.chain_confirm.funded_attached, true);
    assert.equal(report.chain_confirm.funded_debit_usd, 0.1);
    assert.equal(report.chain_confirm.funded_status, "confirmed");
    assert.equal(report.chain_confirm.skipped, true);
    assert.equal(report.chain_confirm.skipped_reason, "insufficient_balance");
    assert.ok(report.chain_confirm.receipt_id?.startsWith("cfm_"));
    assert.equal(report.chain_confirm.pass, true);
    assert.equal(report.pass, true, report.gates.filter((g) => !g.pass).map((g) => g.id).join(","));
  });
});
