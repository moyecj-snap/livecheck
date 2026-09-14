import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { leadSubmitBenchCases } from "../src/lead-submit-bench-cases.js";
import { runLeadSubmitBench } from "../src/lead-submit-bench.js";

describe("lead_submit honesty bench", () => {
  const cases = leadSubmitBenchCases();
  const report = runLeadSubmitBench(cases);

  it("has N ≥ 50 labeled fixtures across true-submitted, true-failed, and traps", () => {
    assert.ok(report.n >= 50, `expected N≥50, got ${report.n}`);
    assert.ok(report.true_submitted >= 10, `expected true_submitted coverage, got ${report.true_submitted}`);
    assert.ok(report.true_failed >= 10, `expected true_failed coverage, got ${report.true_failed}`);
    assert.ok(report.trap >= 10, `expected trap coverage, got ${report.trap}`);
  });

  it("gates false_confirmed = 0", () => {
    assert.equal(
      report.false_confirmed,
      0,
      `false_confirmed=${report.false_confirmed} ids=${report.false_confirmed_ids.join(",")}`,
    );
    assert.equal(report.fc_zero, true);
  });

  it("does not treat expect mismatches as an FC leak when FC=0", () => {
    const falseConfirmed = report.failures.filter((f) => f.reason === "false_confirmed");
    assert.deepEqual(falseConfirmed, []);
  });
});
