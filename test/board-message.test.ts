import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { isBoardUrlShape } from "../src/classify.js";
import { BOARD_PAGE_API_MESSAGE, boardPageApiMessage } from "../src/free-job-page.js";
import { PRICE_USD } from "../src/config.js";
import { closePaidCallStore, initPaidCallStore, listPaidCallRows } from "../src/paid-call-store.js";

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

describe("isBoardUrlShape", () => {
  it("is true for Greenhouse, Lever, and Ashby boards with no job id", () => {
    assert.equal(isBoardUrlShape("https://boards.greenhouse.io/acme"), true);
    assert.equal(isBoardUrlShape("https://job-boards.greenhouse.io/acme"), true);
    assert.equal(isBoardUrlShape("https://boards.greenhouse.io/acme/jobs"), true);
    assert.equal(isBoardUrlShape("https://jobs.lever.co/acme"), true);
    assert.equal(isBoardUrlShape("https://jobs.eu.lever.co/acme"), true);
    assert.equal(isBoardUrlShape("https://jobs.ashbyhq.com/linear"), true);
    assert.equal(isBoardUrlShape("https://jobs.ashbyhq.com/linear/jobs"), true);
    assert.equal(isBoardUrlShape("https://example.com/careers"), true);
    assert.equal(isBoardUrlShape("https://company.com/careers/"), true);
    assert.equal(isBoardUrlShape("https://company.com/jobs/?utm_source=x"), true);
    assert.equal(isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/External"), true);
    assert.equal(isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/en-US/External"), true);
  });

  it("is false for a posting, including one that only later redirects", () => {
    assert.equal(isBoardUrlShape("https://boards.greenhouse.io/acme/jobs/1842"), false);
    assert.equal(isBoardUrlShape("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1842"), false);
    assert.equal(isBoardUrlShape("https://jobs.lever.co/acme/16a1b500-13fe-4c22-ad89-372093b462da"), false);
    assert.equal(isBoardUrlShape("https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff"), false);
    assert.equal(isBoardUrlShape("https://www.figma.com/careers?gh_jid=6223155004"), false);
    assert.equal(isBoardUrlShape("https://shop.example/collections/rings"), false);
    assert.equal(isBoardUrlShape("https://company.com/careers/senior-engineer"), false);
    assert.equal(isBoardUrlShape("https://company.com/jobs/12345"), false);
    assert.equal(isBoardUrlShape("https://company.com/careers/jobs/backend-dev"), false);
    assert.equal(isBoardUrlShape("https://company.com/jobs/view/abc"), false);
    assert.equal(isBoardUrlShape("https://company.com/careers?gh_jid=6223155004"), false);
    assert.equal(
      isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/External/job/Remote/Senior-Engineer_R12345"),
      false,
    );
    assert.equal(
      isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Senior-Engineer_R12345"),
      false,
    );
    assert.equal(isBoardUrlShape("https://shop.example.com/products/widget"), false);
    assert.equal(isBoardUrlShape("https://example.myshopify.com/products/widget"), false);
    assert.equal(isBoardUrlShape("https://www.ebay.com/itm/1234567890"), false);
  });
});

describe("paid routes say when the URL is a board", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  const originalFetch = globalThis.fetch;

  let paidDb: ReturnType<typeof initPaidCallStore>["db"] | undefined;

  before(async () => {
    const opened = initPaidCallStore(":memory:");
    assert.equal(opened.ok, true);
    if (opened.ok) paidDb = opened.db;
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
    closePaidCallStore();
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

  async function post(path: string, url: string, headers: Record<string, string> = {}) {
    const logs: string[] = [];
    const write = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(" "));
      write(...args);
    };
    try {
      const res = await originalFetch(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ url }),
      });
      const body = (await res.json()) as {
        error?: string;
        status?: string;
        message?: string;
        billed?: boolean;
        price_usd?: number;
        signals?: string[];
        route?: string;
      };
      return { status: res.status, paymentRequired: res.headers.get("payment-required"), body, logs };
    } finally {
      console.log = write;
    }
  }

  it("rejects a Greenhouse, Lever, or Ashby board before payment", async () => {
    assert.ok(paidDb);
    const beforeRows = listPaidCallRows(paidDb).length;
    const beforeStats = await originalFetch(`${origin}/stats`);
    const beforeDoc = (await beforeStats.json()) as {
      traffic: { all: { payers: { l7d: { calls: number }; l30d: { calls: number } } }; revenue: { all: { l7d_usd: number; l30d_usd: number } } };
    };

    const cases = [
      ["/v1/verify", "https://boards.greenhouse.io/acme"],
      ["/v1/verify/job", "https://jobs.lever.co/acme"],
      ["/v1/verify/listing", "https://jobs.ashbyhq.com/linear"],
      ["/v1/verify", "https://example.com/careers"],
    ] as const;
    for (const [path, url] of cases) {
      const unpaid = await post(path, url);
      assert.equal(unpaid.status, 400, url);
      assert.equal(unpaid.paymentRequired, null, url);
      assert.equal(unpaid.body.error, "board_url", url);
      assert.equal(unpaid.body.message, BOARD_PAGE_API_MESSAGE, url);
      assert.equal(unpaid.body.billed, false, url);
      assert.equal(unpaid.body.price_usd, 0, url);
      assert.equal(unpaid.logs.some((line) => line.includes("livecheck.paid_call")), false, url);

      const withMock = await post(path, url, { "x-livecheck-mock": "1" });
      assert.equal(withMock.status, 400, url);
      assert.equal(withMock.body.billed, false, url);
      assert.equal(withMock.logs.some((line) => line.includes("livecheck.paid_call")), false, url);
    }

    assert.equal(listPaidCallRows(paidDb).length, beforeRows);
    const afterStats = await originalFetch(`${origin}/stats`);
    const afterDoc = (await afterStats.json()) as typeof beforeDoc;
    assert.deepEqual(afterDoc.traffic.all.payers, beforeDoc.traffic.all.payers);
    assert.deepEqual(afterDoc.traffic.revenue, beforeDoc.traffic.revenue);
  });

  it("bare /careers and /jobs are free; deeper career paths are 402", async () => {
    for (const url of ["https://company.com/careers", "https://company.com/jobs/", "https://company.com/careers?utm_source=x"]) {
      const free = await post("/v1/verify", url);
      assert.equal(free.status, 400, url);
      assert.equal(free.paymentRequired, null, url);
      assert.equal(free.body.error, "board_url", url);
      assert.equal(free.body.billed, false, url);
    }
    for (const url of [
      "https://company.com/careers/senior-engineer",
      "https://company.com/jobs/12345",
      "https://company.com/careers/jobs/backend-dev",
      "https://company.com/jobs/view/abc",
      "https://company.com/careers?gh_jid=6223155004",
    ]) {
      const charged = await post("/v1/verify", url);
      assert.equal(charged.status, 402, url);
      assert.ok(charged.paymentRequired, url);
      assert.notEqual(charged.body.error, "board_url", url);
    }
  });

  it("Workday site index is free and a /job/ posting is 402", async () => {
    for (const url of [
      "https://acme.wd5.myworkdayjobs.com/External",
      "https://acme.wd5.myworkdayjobs.com/en-US/External",
    ]) {
      const free = await post("/v1/verify/job", url);
      assert.equal(free.status, 400, url);
      assert.equal(free.paymentRequired, null, url);
      assert.equal(free.body.message, BOARD_PAGE_API_MESSAGE, url);
      assert.equal(free.body.billed, false, url);
      assert.equal(free.body.price_usd, 0, url);
    }
    for (const url of [
      "https://acme.wd5.myworkdayjobs.com/External/job/Remote/Senior-Engineer_R12345",
      "https://acme.wd5.myworkdayjobs.com/en-US/External/job/Remote/Senior-Engineer_R12345",
    ]) {
      const charged = await post("/v1/verify/job", url);
      assert.equal(charged.status, 402, url);
      assert.ok(charged.paymentRequired, url);
      assert.notEqual(charged.body.error, "board_url", url);
    }
  });

  it("Shopify and eBay product URLs are 402, and collections stay on the paid path", async () => {
    for (const url of [
      "https://shop.example.com/products/widget",
      "https://example.myshopify.com/products/widget",
      "https://www.ebay.com/itm/1234567890",
      "https://shop.example/collections/rings",
    ]) {
      const charged = await post("/v1/verify/listing", url);
      assert.equal(charged.status, 402, url);
      assert.ok(charged.paymentRequired, url);
      assert.notEqual(charged.body.error, "board_url", url);
    }
  });

  it("still charges when a posting URL redirects to a board", async () => {
    assert.ok(paidDb);
    const beforeRows = listPaidCallRows(paidDb).length;
    const posting = `${origin}/fixtures/jobs/9901`;
    const unpaid = await post("/v1/verify", posting);
    assert.equal(unpaid.status, 402);
    assert.ok(unpaid.paymentRequired);
    assert.equal(unpaid.body.message, undefined);

    const paidRedirect = await post("/v1/verify/job", posting, { "x-livecheck-mock": "1" });
    assert.equal(paidRedirect.status, 200);
    assert.equal(paidRedirect.body.price_usd, PRICE_USD);
    assert.equal(paidRedirect.body.billed, undefined);
    assert.equal(paidRedirect.body.status, "closed");
    assert.ok(paidRedirect.body.signals?.includes("redirected_to_board"));
    assert.equal(paidRedirect.logs.some((line) => line.includes("livecheck.paid_call")), true);
    assert.equal(listPaidCallRows(paidDb).length, beforeRows + 1);
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
