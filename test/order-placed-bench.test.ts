import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { orderPlacedBenchCases } from "../src/order-placed-bench-cases.js";
import { runOrderPlacedBench } from "../src/order-placed-bench.js";

describe("order_placed honesty bench", () => {
  const cases = orderPlacedBenchCases();
  const report = runOrderPlacedBench(cases);

  it("has N ≥ 50 labeled fixtures across true-placed, true-failed, and traps", () => {
    assert.ok(report.n >= 50, `expected N≥50, got ${report.n}`);
    assert.ok(report.true_placed >= 10, `expected true_placed coverage, got ${report.true_placed}`);
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
