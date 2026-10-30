import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { BOARD_PAGE_API_MESSAGE, boardPageApiMessage } from "../src/free-job-page.js";
import { PRICE_USD } from "../src/config.js";

const BOARD_HTML = `<!doctype html><html><head><title>Acme Careers</title></head><body>
  <h1>Open roles</h1>
  <div class="job-card">Engineer</div>
  <div class="job-card">Designer</div>
  <div class="job-card">Product manager</div>
  <p>Browse every opening on this page.</p>
</body></html>`;

const APPLY_HTML = `<!doctype html><html><head><title>Engineer</title></head><body>
  <h1>Engineer</h1>
  <p>The team is hiring for this role and reviewing applications this week.</p>
  <a href="/apply">Apply now</a>
</body></html>`;

const COLLECTION_HTML = `<!doctype html><html><head><title>Rings</title></head><body>
  <div class="product-card">One</div>
  <div class="product-card">Two</div>
  <div class="product-card">Three</div>
</body></html>`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("boardPageApiMessage", () => {
  it("reuses the free page's board signals and tells the caller to pass one posting", () => {
    assert.equal(
      boardPageApiMessage({ status: "unknown", signals: ["not_a_specific_posting", "careers_homepage"] }),
      BOARD_PAGE_API_MESSAGE,
    );
    assert.equal(
      boardPageApiMessage({ status: "unknown", signals: ["challenge_page", "not_a_specific_posting"] }),
      BOARD_PAGE_API_MESSAGE,
    );
    assert.match(BOARD_PAGE_API_MESSAGE, /job board or careers index/i);
    assert.match(BOARD_PAGE_API_MESSAGE, /one job posting/);
  });

  it("stays quiet for a real answer, a product collection, and a posting that redirected", () => {
    assert.equal(boardPageApiMessage({ status: "live", signals: ["apply form present"] }), undefined);
    assert.equal(boardPageApiMessage({ status: "closed", signals: ["http_404"] }), undefined);
    assert.equal(
      boardPageApiMessage({ status: "closed", signals: ["redirected_to_board", "not_a_specific_posting"] }),
      undefined,
    );
    assert.equal(boardPageApiMessage({ status: "unknown", signals: ["collection_or_category"] }), undefined);
    assert.equal(boardPageApiMessage({ status: "unknown", signals: ["challenge_page"] }), undefined);
    assert.equal(
      boardPageApiMessage({ status: "live", signals: ["ats_api_listed", "not_a_specific_posting"] }),
      undefined,
    );
  });
});

describe("paid routes say when the URL is a board", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  const originalFetch = globalThis.fetch;

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.startsWith(origin)) return originalFetch(input, init);
      if (url === "https://boards.greenhouse.io/acme/jobs/1842") {
        return new Response(APPLY_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      if (url === "https://shop.example/collections/rings") {
        return new Response(COLLECTION_HTML, { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response(BOARD_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
  });

  after(() => {
    globalThis.fetch = originalFetch;
    close();
  });

  async function paid(path: string, url: string) {
    const res = await originalFetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url }),
    });
    const body = (await res.json()) as {
      status?: string;
      message?: string;
      price_usd?: number;
      signals?: string[];
      route?: string;
    };
    return { status: res.status, body };
  }

  it("returns 200 with the board sentence on verify, verify/job, and verify/listing", async () => {
    for (const path of ["/v1/verify", "/v1/verify/job", "/v1/verify/listing"]) {
      const { status, body } = await paid(path, "https://example.com/careers");
      assert.equal(status, 200, path);
      assert.equal(body.status, "unknown", path);
      assert.equal(body.message, BOARD_PAGE_API_MESSAGE, path);
      assert.equal(body.price_usd, PRICE_USD, path);
      assert.ok(body.signals?.includes("not_a_specific_posting"), path);
    }
    const lever = await paid("/v1/verify/job", "https://jobs.lever.co/acme");
    assert.equal(lever.status, 200);
    assert.equal(lever.body.message, BOARD_PAGE_API_MESSAGE);
    const greenhouse = await paid("/v1/verify", "https://boards.greenhouse.io/acme");
    assert.equal(greenhouse.status, 200);
    assert.equal(greenhouse.body.message, BOARD_PAGE_API_MESSAGE);
  });

  it("does not add the sentence to a single posting or a product collection", async () => {
    const job = await paid("/v1/verify/job", "https://boards.greenhouse.io/acme/jobs/1842");
    assert.equal(job.status, 200);
    assert.equal(job.body.status, "live");
    assert.equal(job.body.message, undefined);
    assert.equal(job.body.price_usd, PRICE_USD);

    const collection = await paid("/v1/verify/listing", "https://shop.example/collections/rings");
    assert.equal(collection.status, 200);
    assert.equal(collection.body.message, undefined);
    assert.equal(collection.body.status, "unknown");
  });
});
