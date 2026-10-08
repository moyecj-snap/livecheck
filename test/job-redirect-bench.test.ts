import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runJobRedirectBench } from "../src/job-redirect-bench.js";
import {
  STRIPE_FILLED_LISTING_URL,
  STRIPE_FILLED_REDIRECT_URL,
  STRIPE_FILLED_SEARCH_URL,
  STRIPE_LIVE_LISTING_URL,
  STRIPE_LIVE_SEARCH_URL,
  STRIPE_NEVER_EXISTED_REDIRECT_URL,
  STRIPE_NEVER_EXISTED_SEARCH_URL,
  jobRedirectBenchCases,
} from "../src/job-redirect-bench-cases.js";

describe("job redirect bench", () => {
  it("keeps closed→live at 0 and covers both redirect directions", () => {
    const report = runJobRedirectBench();
    assert.equal(report.closed_to_live, 0);
    assert.equal(report.false_live, 0);
    assert.equal(report.expect_mismatches, 0);
    assert.equal(report.n, jobRedirectBenchCases().length);

    const byId = new Map(jobRedirectBenchCases().map((item) => [item.id, item]));
    const live = byId.get("stripe-search-redirects-to-listing");
    const listing = byId.get("stripe-careers-listing-is-a-job-page");
    const closed = byId.get("stripe-never-existed-gh-jid-redirects-to-search");
    const filled = byId.get("stripe-filled-program-manager-redirects-to-search");
    const search = byId.get("search-query-page-stays-unknown");
    const unclear = byId.get("job-redirects-to-unclear-page");
    assert.equal(live?.expect, "live");
    assert.equal(live?.requestedUrl, STRIPE_LIVE_SEARCH_URL);
    assert.equal(live?.redirect_to, STRIPE_LIVE_LISTING_URL);
    assert.equal(listing?.expect, "live");
    assert.equal(listing?.bucket, "job_page");
    assert.equal(closed?.expect, "closed");
    assert.equal(closed?.requestedUrl, STRIPE_NEVER_EXISTED_SEARCH_URL);
    assert.equal(closed?.redirect_to, STRIPE_NEVER_EXISTED_REDIRECT_URL);
    assert.equal(filled?.expect, "closed");
    assert.equal(filled?.requestedUrl, STRIPE_FILLED_SEARCH_URL);
    assert.equal(filled?.redirect_to, STRIPE_FILLED_REDIRECT_URL);
    assert.equal(STRIPE_FILLED_LISTING_URL.includes("7569678"), true);
    assert.equal(search?.expect, "unknown");
    assert.equal(unclear?.expect, "unknown");
    assert.equal(report.failures.length, 0);
  });
});
