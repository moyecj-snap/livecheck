import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { listingPublishedBenchCases } from "../src/listing-published-bench-cases.js";
import { runListingPublishedBench } from "../src/listing-published-bench.js";

describe("listing_published honesty bench", () => {
  const cases = listingPublishedBenchCases();
  const report = runListingPublishedBench(cases);

  it("has N ≥ 50 labeled fixtures across true-live, true-closed, and traps", () => {
    assert.ok(report.n >= 50, `expected N≥50, got ${report.n}`);
    assert.ok(report.true_live >= 10, `expected true_live coverage, got ${report.true_live}`);
    assert.ok(report.true_closed >= 10, `expected true_closed coverage, got ${report.true_closed}`);
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
