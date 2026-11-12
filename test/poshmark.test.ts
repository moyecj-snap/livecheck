import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { describe, it } from "node:test";
import { poshmarkListingId, poshmarkOwnAvailability } from "../src/own-listing.js";
import { verifyUrl } from "../src/verify.js";

// Real pages, fetched Thu Nov 12, 2026 ~10:43 AM PT through Livecheck's own
// fetchPage (Livecheck user agent, robots.txt allows /listing/<slug>), so each
// is already cut at MAX_BODY_BYTES the way prod reads it. The cut leaves the
// window.__INITIAL_STATE__ script unclosed. Only the anonymous csrftoken value
// was replaced with REDACTED.
function fixture(name: string): string {
  return gunzipSync(readFileSync(new URL(`./fixtures/poshmark/${name}`, import.meta.url))).toString("utf8");
}

const UGG_URL = "https://poshmark.com/listing/UGG-Womens-Black-Adirondack-Boots-6abc1b43d48e7e3b0287e12b";
const UGG_HTML = fixture("ugg-adirondack-live-2026-11-12.html.gz");
// Resale coverage test POSH3: sold, served as HTTP 404 with the sold page.
const SOLD_URL = "https://poshmark.com/listing/Patagonia-Down-Sweater-Jacket-Mens-Medium-68cade7ac71ba1d3e3706d3e";
const SOLD_HTML = fixture("patagonia-down-sweater-sold-2026-11-12.html.gz");

const ROBOTS = "User-agent: *\nDisallow: /search\nDisallow: /listing/*/buy\n";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function serve(url: string, body: string, status: number): typeof fetch {
  return async (input) => {
    const requested = requestUrl(input);
    if (requested.endsWith("/robots.txt")) return new Response(ROBOTS, { status: 200 });
    if (requested === url) return new Response(body, { status, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  };
}

/**
 * The 9:00 AM PT run on Nov 12 read this live listing as closed
 * (signals not_a_specific_posting, sold-out). The similar-listings data on the
 * page changes from load to load and that exact load was not saved, so this
 * puts a "sold out" description on the first similar listing in the real page
 * (another seller's item, inside the unclosed state script). The UGG listing's
 * own fields are untouched: inventory.status=available, JSON-LD InStock.
 */
function withSoldOutSimilarListing(html: string): string {
  const at = html.indexOf('"similarListings":[{');
  assert.ok(at > 0, "fixture has a similarListings block");
  const desc = html.indexOf('"description":"', at);
  assert.ok(desc > at, "similar listing has a description");
  const start = desc + '"description":"'.length;
  return `${html.slice(0, start)}Sold out in stores, last pair. ${html.slice(start)}`;
}

describe("Poshmark: the listing's own availability field decides", () => {
  it("parses the listing id from a /listing/<slug>-<id> URL only", () => {
    assert.equal(poshmarkListingId(UGG_URL), "6abc1b43d48e7e3b0287e12b");
    assert.equal(poshmarkListingId("https://poshmark.com/listing/6abc1b43d48e7e3b0287e12b"), "6abc1b43d48e7e3b0287e12b");
    assert.equal(poshmarkListingId("https://poshmark.com/brand/UGG"), null);
    assert.equal(poshmarkListingId("https://example.com/listing/UGG-6abc1b43d48e7e3b0287e12b"), null);
  });

  it("reads the UGG listing's own JSON-LD and inventory, not the similar listings", () => {
    const own = poshmarkOwnAvailability(UGG_HTML, "6abc1b43d48e7e3b0287e12b");
    assert.equal(own.schema, "available");
    assert.equal(own.inventory, "available");
    const sold = poshmarkOwnAvailability(SOLD_HTML, "68cade7ac71ba1d3e3706d3e");
    assert.equal(sold.schema, "sold");
    assert.equal(sold.inventory, "sold_out");
  });

  it("live UGG listing (Buy Now, 1 available) with a sold-out similar listing is live, not closed", async () => {
    const page = withSoldOutSimilarListing(UGG_HTML);
    const verdict = await verifyUrl(UGG_URL, serve(UGG_URL, page, 200), new Date("2026-11-12T18:43:00Z"));
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("poshmark_available"));
    assert.ok(!verdict.signals.includes("sold-out"));
    assert.ok(!verdict.signals.includes("not_a_specific_posting"));
  });

  it("the unmodified real UGG page is live from its own field", async () => {
    const verdict = await verifyUrl(UGG_URL, serve(UGG_URL, UGG_HTML, 200), new Date("2026-11-12T18:43:00Z"));
    assert.equal(verdict.status, "live");
    assert.deepEqual(verdict.signals.slice(0, 2), ["poshmark_available", "in-stock"]);
    assert.ok(verdict.confidence >= 0.9);
  });

  it("the genuinely sold Poshmark listing (POSH3, HTTP 404) stays closed", async () => {
    const verdict = await verifyUrl(SOLD_URL, serve(SOLD_URL, SOLD_HTML, 404), new Date("2026-11-12T18:43:00Z"));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("http_404"));
    assert.ok(verdict.signals.includes("poshmark_sold_out"));
  });

  it("the same sold page served as HTTP 200 is closed from its own field", async () => {
    const verdict = await verifyUrl(SOLD_URL, serve(SOLD_URL, SOLD_HTML, 200), new Date("2026-11-12T18:43:00Z"));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("poshmark_sold_out"));
  });

  it("no own field and a sold-out reading from page text is can't tell, not closed", async () => {
    const url = "https://poshmark.com/listing/Thing-0123456789abcdef01234567";
    const body = `<html><head><title>Thing</title></head><body><h1>Thing</h1><button>Buy Now</button><h2>Sold Listings</h2><span>Sold out</span></body></html>`;
    const verdict = await verifyUrl(url, serve(url, body, 200), new Date("2026-11-12T18:43:00Z"));
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("poshmark_availability_unavailable"));
  });

  it("own inventory reserved/not_for_sale on a sold-out-looking page is can't tell", async () => {
    const page = withSoldOutSimilarListing(UGG_HTML)
      .replace('"listingDetails":{"id":"6abc1b43d48e7e3b0287e12b"', '"listingDetails":{"id":"6abc1b43d48e7e3b0287e12b","x":1')
      .replace(/("listingDetails":\{"id":"6abc1b43d48e7e3b0287e12b"[\s\S]{0,3000}?"inventory":\{"status":")available/, "$1reserved")
      .replace('"availability":"https://schema.org/InStock"', '"availability":"https://schema.org/PreOrder"');
    const verdict = await verifyUrl(UGG_URL, serve(UGG_URL, page, 200), new Date("2026-11-12T18:43:00Z"));
    assert.notEqual(verdict.status, "closed");
  });
});
