import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLEAR_LIVE_JOB_CONFIDENCE, classify } from "../src/classify.js";
import { FIXTURES } from "../src/fixtures.js";
import { PRICE_USD } from "../src/config.js";
import {
  STRIPE_CLOSED_REDIRECT_URL,
  STRIPE_CLOSED_SEARCH_URL,
  STRIPE_LIVE_LISTING_URL,
  STRIPE_LIVE_SEARCH_URL,
} from "../src/job-redirect-bench-cases.js";
import type { FetchedPage } from "../src/types.js";

function page(partial: Partial<FetchedPage> & Pick<FetchedPage, "requestedUrl" | "html" | "httpStatus">): FetchedPage {
  const html = partial.html;
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    canonicalUrl: partial.canonicalUrl ?? partial.requestedUrl,
    text: html
      .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
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
    assert.equal(verdict.confidence, CLEAR_LIVE_JOB_CONFIDENCE);
    assert.ok(verdict.confidence > 0.82);
    assert.equal(verdict.price_usd, PRICE_USD);
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
    assert.equal(verdict.confidence, 0.95);
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

  it("marks a Greenhouse apply page with recaptcha as live, not challenge_page", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/northwind/jobs/1842",
        httpStatus: 200,
        html: FIXTURES["live-apply-recaptcha"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("apply form present"));
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("marks a Lever-like apply page containing recaptcha as live", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://jobs.lever.co/northwind/staff-backend-engineer",
        httpStatus: 200,
        html: FIXTURES["live-apply-recaptcha"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("apply form present"));
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("marks a Cloudflare interstitial as unknown challenge_page", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://boards.greenhouse.io/northwind/jobs/1842",
        httpStatus: 200,
        html: FIXTURES["cloudflare-challenge"].body!,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
    assert.equal(verdict.signals.includes("apply form present"), false);
    assert.ok(verdict.confidence <= 0.6);
  });

  it("marks a just-a-moment interstitial on a product URL as challenge_page, not in-stock", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/ridge-wallet",
        httpStatus: 200,
        html: FIXTURES["cloudflare-challenge"].body!,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
    assert.equal(verdict.signals.includes("in-stock"), false);
  });

  it("marks a challenge-platform script with no product signal as challenge_page", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://example.com/",
        httpStatus: 200,
        html: `<!doctype html><html><head><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></head><body><p>Empty shell</p></body></html>`,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
    assert.equal(verdict.signals.includes("in-stock"), false);
  });

  it("marks a Shopify product with recaptcha and Add to cart as live + in-stock", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/ridge-wallet",
        httpStatus: 200,
        html: FIXTURES["products/ridge-wallet"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("challenge_page"), false);
    assert.equal(verdict.confidence, 0.8);
  });

  it("marks a Shopify sold-out product as closed + sold-out", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://groovelife.com/products/groove-ring",
        httpStatus: 200,
        html: FIXTURES["products/groove-ring"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("sold-out"));
    assert.equal(verdict.status, "closed");
  });

  it("does not mark a collection page live even when the template has Add to cart", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://groovelife.com/collections/rings",
        httpStatus: 200,
        html: FIXTURES["collections/rings"].body!,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("collection_or_category"));
    assert.equal(verdict.signals.includes("in-stock"), false);
  });

  it("marks Shopify Add to cart + locale sold_out JSON as live + in-stock", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/ridge-wallet",
        httpStatus: 200,
        html: FIXTURES["products/ridge-wallet-locale"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("sold-out"), false);
  });

  it("marks a visible Sold out button without add-to-cart as closed + sold-out", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://groovelife.com/products/groove-ring",
        httpStatus: 200,
        html: FIXTURES["products/groove-ring"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("sold-out"));
    assert.equal(verdict.signals.includes("in-stock"), false);
  });

  it("marks product HTML with only a Cloudflare bot-mgmt script as live + in-stock", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://groovelife.com/products/groove-ring",
        httpStatus: 200,
        html: FIXTURES["products/groove-ring-challenge-platform"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("marks locale sold_out JSON plus sold-out CSS class with Add to cart as live", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/ridge-wallet",
        httpStatus: 200,
        html: FIXTURES["products/ridge-wallet-locale-class"].body!,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("sold-out"), false);
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("marks schema.org OutOfStock as closed + sold-out", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/ridge-wallet",
        httpStatus: 200,
        html: FIXTURES["products/ridge-wallet-schema-oos"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("sold-out"));
  });

  it("keeps /collections/all unknown when the template includes Apply now", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/collections/all",
        httpStatus: 200,
        html: FIXTURES["collections/all-apply"].body!,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("collection_or_category"));
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.signals.includes("apply form present"), false);
    assert.notEqual(verdict.status, "live");
  });

  it("keeps a non-specific apply page below the clear-live score", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://example.com/opening",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Opening</title></head><body>
          <h1>Opening</h1><p>One role, not a board.</p>
          <form action="/apply" method="post"><button>Apply Now</button></form>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.confidence, 0.78);
    assert.ok(verdict.confidence < CLEAR_LIVE_JOB_CONFIDENCE);
  });

  it("does not treat a Workday JavaScript shell with Apply as a clear live posting", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://acme.myworkdayjobs.com/en-US/careers/job/12345",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Job</title></head>
          <body><div id="root"></div><a href="#">Apply</a>
          <p>Enable JavaScript to view this application.</p></body></html>`,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("js_shell"));
    assert.ok(verdict.confidence <= 0.5);
    assert.ok(verdict.confidence < CLEAR_LIVE_JOB_CONFIDENCE);
    assert.equal(verdict.signals.includes("challenge_page"), false);
  });

  it("scores a rendered Workday posting with an apply form as clear live", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://acme.myworkdayjobs.com/en-US/careers/job/Commercial-Policy-Lead_JR12345",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Commercial Policy Lead</title></head><body>
          <h1>Commercial Policy Lead</h1>
          <article><p>Own commercial policy for the Discord marketplace. This posting includes the full description, location, and team in the HTML response, so it is not an empty JavaScript shell.</p></article>
          <form action="/apply" method="post"><button type="submit">Apply Now</button></form>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.confidence, CLEAR_LIVE_JOB_CONFIDENCE);
    assert.equal(verdict.signals.includes("js_shell"), false);
  });

  it("marks a 404 product URL as closed", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://ridge.com/products/missing",
        httpStatus: 404,
        html: FIXTURES["products/missing"].body!,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("http_404"));
  });

  it("judges a search link that redirects to a Stripe listing as live", () => {
    const verdict = classify(
      page({
        requestedUrl: STRIPE_LIVE_SEARCH_URL,
        canonicalUrl: STRIPE_LIVE_LISTING_URL,
        redirected: true,
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Stripe Careers | Abuse Investigator</title></head><body>
          <h1>Abuse Investigator</h1>
          <a class="hds-button careers-listing-details__apply-button" href="/careers/apply/abuse-investigator/8172508">Apply now</a>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.signals.includes("collection_or_category"), false);
    assert.equal(verdict.signals.includes("redirected_to_board"), false);
  });

  it("recognizes /careers/listing/<slug>/<id> as a job page", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://stripe.com/careers/listing/abuse-investigator/8172508",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Abuse Investigator</title></head><body>
          <h1>Abuse Investigator</h1>
          <a href="/careers/apply/abuse-investigator/8172508">Apply now</a>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "live");
  });

  it("returns closed when a job link redirects to the Stripe careers search", () => {
    const verdict = classify(
      page({
        requestedUrl: STRIPE_CLOSED_SEARCH_URL,
        canonicalUrl: STRIPE_CLOSED_REDIRECT_URL,
        redirected: true,
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Open roles</title></head><body>
          <h1>Open roles</h1>
          <div class="job-card">Role A</div>
          <div class="job-card">Role B</div>
          <div class="job-card">Role C</div>
          <a href="/careers/listing/role-a/1">Apply now</a>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("redirected_to_board"));
  });

  it("returns unknown, never live, when a job link redirects to an unclear page", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://jobs.example.com/jobs/7782",
        canonicalUrl: "https://jobs.example.com/notice/7782",
        redirected: true,
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Notice</title></head><body>
          <p>Thanks for visiting.</p><a href="/apply">Apply now</a>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("redirected_away_from_job"));
  });

  it("keeps a real search query page unknown", () => {
    const verdict = classify(
      page({
        requestedUrl: "https://example.com/search?q=engineer",
        httpStatus: 200,
        html: `<!doctype html><html><head><title>Search</title></head><body>
          <h1>Search results</h1><a href="/jobs/1">Apply now</a>
        </body></html>`,
      }),
    );
    assert.equal(verdict.status, "unknown");
  });
});
