import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  EBAY_BROWSE_BASE,
  EBAY_OAUTH_SCOPE,
  EBAY_OAUTH_URL,
  parseEbayItemUrl,
  resetEbayDisabledLog,
  resetEbayTokenCache,
  restfulItemIds,
  verdictFromBrowseItem,
} from "../src/ebay.js";
import { verifyUrl } from "../src/verify.js";

const ITEM_URL = "https://www.ebay.com/itm/vintage-watch/123456789012";
const ENV_KEYS = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_DEV_ID", "EBAY_MARKETPLACE_ID"] as const;

const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetEbayTokenCache();
  resetEbayDisabledLog();
}

function enableEbay(): void {
  process.env.EBAY_CLIENT_ID = "test-ebay-client-id";
  process.env.EBAY_CLIENT_SECRET = "test-ebay-client-secret";
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockEbayFetch(handlers: {
  token?: () => Response;
  item?: (url: string) => Response;
  html?: (url: string) => Response;
}): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url === EBAY_OAUTH_URL) {
      const body = typeof init?.body === "string" ? init.body : "";
      assert.match(body, /grant_type=client_credentials/);
      assert.match(body, new RegExp(encodeURIComponent(EBAY_OAUTH_SCOPE)));
      return (handlers.token ?? (() => jsonResponse(200, { access_token: "tok", expires_in: 7200 })))();
    }
    if (url.startsWith(EBAY_BROWSE_BASE)) {
      assert.equal(url.includes("finding"), false);
      assert.equal(url.includes("completed"), false);
      assert.equal(url.includes("sold"), false);
      return (handlers.item ?? (() => jsonResponse(500, { error: "no item handler" })))(url);
    }
    if (handlers.html) return handlers.html(url);
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

afterEach(() => restoreEnv());

describe("parseEbayItemUrl", () => {
  it("extracts numeric ids from /itm/{id} and /itm/{slug}/{id} on regional hosts", () => {
    const us = parseEbayItemUrl("https://www.ebay.com/itm/123456789012");
    assert.equal(us?.itemId, "123456789012");
    assert.equal(us?.marketplaceId, "EBAY_US");
    const slug = parseEbayItemUrl(ITEM_URL);
    assert.equal(slug?.itemId, "123456789012");
    const uk = parseEbayItemUrl("https://www.ebay.co.uk/itm/987654321098");
    assert.equal(uk?.itemId, "987654321098");
    assert.equal(uk?.marketplaceId, "EBAY_GB");
    const de = parseEbayItemUrl("https://www.ebay.de/itm/foo-bar/111222333444");
    assert.equal(de?.marketplaceId, "EBAY_DE");
    const au = parseEbayItemUrl("https://www.ebay.com.au/itm/555666777888");
    assert.equal(au?.marketplaceId, "EBAY_AU");
    assert.equal(parseEbayItemUrl("https://www.ebay.com/sch/i.html?_nkw=watch"), null);
    assert.equal(parseEbayItemUrl("https://amazon.com/itm/123456789012"), null);
    assert.deepEqual(restfulItemIds("287092450439"), ["v1|287092450439|0"]);
    assert.deepEqual(restfulItemIds("287092450439", "https://www.ebay.com/itm/287092450439?var=589132013901"), [
      "v1|287092450439|0",
      "v1|287092450439|589132013901",
    ]);
  });
});

describe("verdictFromBrowseItem", () => {
  const ref = parseEbayItemUrl(ITEM_URL)!;
  const now = new Date("2026-09-03T17:00:00Z");

  it("maps IN_STOCK that has not ended to live + ebay-in-stock", () => {
    const verdict = verdictFromBrowseItem(
      ref,
      {
        title: "Vintage watch",
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
        itemEndDate: "2026-12-01T00:00:00.000Z",
      },
      200,
      now,
    );
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay-in-stock"));
    assert.equal(verdict.title, "Vintage watch");
    assert.equal("price" in verdict, false);
    assert.equal(verdict.price_usd, 0.01);
  });

  it("maps ended listings to closed + ebay-ended even if IN_STOCK", () => {
    const verdict = verdictFromBrowseItem(
      ref,
      {
        estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
        itemEndDate: "2026-01-01T00:00:00.000Z",
      },
      200,
      now,
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("ebay-ended"));
  });
});

describe("verifyUrl eBay adapter", () => {
  it("returns live for mocked Browse IN_STOCK and does not scrape eBay HTML", async () => {
    enableEbay();
    const { fetchImpl, urls } = mockEbayFetch({
      item: () =>
        jsonResponse(200, {
          title: "Vintage watch",
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
          itemEndDate: "2026-12-01T00:00:00.000Z",
        }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl, new Date("2026-09-03T17:00:00Z"));
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay-in-stock"));
    assert.ok(urls.includes(EBAY_OAUTH_URL));
    assert.ok(urls.some((u) => u.includes("get_item_by_legacy_id") && u.includes("123456789012")));
    assert.equal(
      urls.some((u) => u.includes("ebay.com/itm")),
      false,
    );
  });

  it("returns live for LIMITED_STOCK", async () => {
    enableEbay();
    const { fetchImpl } = mockEbayFetch({
      item: () =>
        jsonResponse(200, {
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: "LIMITED_STOCK" }],
        }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay-in-stock"));
  });

  it("returns closed + sold-out for OUT_OF_STOCK", async () => {
    enableEbay();
    const { fetchImpl } = mockEbayFetch({
      item: () =>
        jsonResponse(200, {
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: "OUT_OF_STOCK" }],
        }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("sold-out"));
  });

  it("returns closed for an ended listing", async () => {
    enableEbay();
    const { fetchImpl } = mockEbayFetch({
      item: () =>
        jsonResponse(200, {
          estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
          itemEndDate: "2020-01-01T00:00:00.000Z",
        }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl, new Date("2026-09-03T17:00:00Z"));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("ebay-ended"));
  });

  it("returns live when legacy 404s but getItem v1|{id}|0 is IN_STOCK", async () => {
    enableEbay();
    const restful = `${EBAY_BROWSE_BASE}/item/${encodeURIComponent("v1|123456789012|0")}`;
    const { fetchImpl, urls } = mockEbayFetch({
      item: (url) => {
        if (url.includes("get_item_by_legacy_id")) {
          return jsonResponse(404, { errors: [{ errorId: 11001 }] });
        }
        if (url === restful) {
          return jsonResponse(200, {
            itemId: "v1|123456789012|0",
            title: "Variation listing",
            estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
          });
        }
        return jsonResponse(404, { errors: [{ errorId: 11001 }] });
      },
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay-in-stock"));
    assert.equal(verdict.signals.includes("ebay-ended"), false);
    assert.equal(verdict.signals.includes("http_404"), false);
    assert.ok(urls.some((u) => u.includes("get_item_by_legacy_id")));
    assert.ok(urls.includes(restful));
  });

  it("uses a var= suffix after |0 404s on a variation listing", async () => {
    enableEbay();
    const variationUrl = "https://www.ebay.com/itm/287092450439?var=589132013901";
    const parent = `${EBAY_BROWSE_BASE}/item/${encodeURIComponent("v1|287092450439|0")}`;
    const variation = `${EBAY_BROWSE_BASE}/item/${encodeURIComponent("v1|287092450439|589132013901")}`;
    const { fetchImpl, urls } = mockEbayFetch({
      item: (url) => {
        if (url.includes("get_item_by_legacy_id") || url === parent) {
          return jsonResponse(404, { errors: [{ errorId: 11001 }] });
        }
        if (url === variation) {
          return jsonResponse(200, {
            itemId: "v1|287092450439|589132013901",
            estimatedAvailabilities: [{ estimatedAvailabilityStatus: "LIMITED_STOCK" }],
          });
        }
        return jsonResponse(404, {});
      },
    });
    const verdict = await verifyUrl(variationUrl, fetchImpl);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay-in-stock"));
    assert.ok(urls.includes(parent));
    assert.ok(urls.includes(variation));
  });

  it("returns closed only after legacy and getItem fallbacks all 404", async () => {
    enableEbay();
    const { fetchImpl, urls } = mockEbayFetch({
      item: () => jsonResponse(404, { errors: [{ errorId: 11001 }] }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.http_status, 404);
    assert.ok(urls.some((u) => u.includes("get_item_by_legacy_id")));
    assert.ok(urls.some((u) => u.includes(`/item/${encodeURIComponent("v1|123456789012|0")}`)));
  });

  it("returns unknown on Browse API errors and does not throw", async () => {
    enableEbay();
    const { fetchImpl } = mockEbayFetch({
      item: () => jsonResponse(503, { errors: [{ message: "unavailable" }] }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("ebay_api_error"));
  });

  it("falls back to the HTML classifier when creds are missing and does not call eBay APIs", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const { fetchImpl, urls } = mockEbayFetch({
      html: () =>
        new Response("<html><title>eBay listing</title><body>Item</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "unknown");
    assert.equal(
      urls.some((u) => u.startsWith("https://api.ebay.com")),
      false,
    );
    assert.ok(urls.some((u) => u.includes("ebay.com/itm")));
  });
});
