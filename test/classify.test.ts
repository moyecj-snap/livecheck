import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify } from "../src/classify.js";
import { FIXTURES } from "../src/fixtures.js";
import type { FetchedPage } from "../src/types.js";

function page(partial: Partial<FetchedPage> & Pick<FetchedPage, "requestedUrl" | "html" | "httpStatus">): FetchedPage {
  const html = partial.html;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    canonicalUrl: partial.canonicalUrl ?? partial.requestedUrl,
    text: html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    title: titleMatch?.[1]?.trim() ?? null,
    redirected: Boolean(partial.redirected),
    redirectChain: partial.redirectChain ?? [],
    ...partial,
  };
}

describe("classify fixtures", () => {
  it("marks 200 + Apply Now as live", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/northwind/jobs/1842",
        httpStatus: 200,
        html: FIXTURES["live-apply-now"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("apply form present"));
    assert.ok(verdict.signals.includes("no closure banner"));
    assert.equal(verdict.price_usd, 0.05);
  });

  it("marks Greenhouse 'closed to new applications' as closed", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/acme/jobs/2201",
        httpStatus: 200,
        html: FIXTURES["closed-to-new-applications"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.some((s) => s.includes("closed to new applications")));
  });

  it("marks Lever 'closed to new applications' as closed", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://jobs.lever.co/harbor/3301-account-executive",
        httpStatus: 200,
        html: FIXTURES["closed-to-new-applications-lever"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.some((s) => s.includes("closed to new applications")));
  });

  it("marks a Greenhouse job redirect to the board as closed", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/acme/jobs/9901",
        canonicalUrl: "https://boards.greenhouse.io/acme",
        httpStatus: 200,
        html: FIXTURES["greenhouse-board"].body!,
        redirected: true,
        redirectChain: ["https://boards.greenhouse.io/acme"],
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("redirected_to_board"));
  });

  it("marks HTTP 404 as closed", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/acme/jobs/4040",
        httpStatus: 404,
        html: FIXTURES["gone-404"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("http_404"));
    assert.equal(verdict.http_status, 404);
  });

  it("flags a careers homepage as not a specific posting", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://example.com/careers",
        httpStatus: 200,
        html: FIXTURES.careers.body!,
      }),
    );
    assert.notEqual(verdict.status, "live");
    assert.ok(verdict.signals.includes("not_a_specific_posting"));
  });
});
