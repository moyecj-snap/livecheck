import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";
import { MAX_BODY_BYTES } from "../src/config.js";
import { PAGE_TRUNCATED_EVENT, PAGE_TRUNCATED_SIGNAL, setPageTruncationWriterForTests } from "../src/page-truncation.js";
import { fetchPage, verifyUrl } from "../src/verify.js";

// Nov 12, 2026 (Craig): page-read limit 1.5 MB -> 2 MB, log every truncated
// page with the store's hostname only, and a page cut before the listing's own
// availability field is can't tell, never live or closed.

const NOW = new Date("2026-11-12T19:30:00Z");
const ROBOTS = "User-agent: *\nAllow: /\n";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function serve(pages: Record<string, { body: string; status?: number; type?: string }>): typeof fetch {
  return async (input) => {
    const requested = requestUrl(input);
    if (requested.endsWith("/robots.txt")) return new Response(ROBOTS, { status: 200 });
    const hit = pages[requested];
    if (hit) return new Response(hit.body, { status: hit.status ?? 200, headers: { "content-type": hit.type ?? "text/html" } });
    return new Response("not found", { status: 404 });
  };
}

/** Whitespace filler: harmless to the HTML classifier and to JSON. */
function pad(bytes: number): string {
  return "\n".repeat(bytes);
}

function jsonLd(availability: string, extra: Record<string, unknown> = {}): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Field Jacket",
    ...extra,
    offers: { "@type": "Offer", price: "120.00", priceCurrency: "USD", availability: `https://schema.org/${availability}` },
  })}</script>`;
}

const LIVE_LOOKING = `<html><head><title>Field Jacket</title></head><body><h1>Field Jacket</h1><p>$120.00</p><button>Add to cart</button>`;

let lines: string[] = [];
beforeEach(() => {
  lines = [];
  setPageTruncationWriterForTests((line) => lines.push(line));
});
afterEach(() => setPageTruncationWriterForTests(null));

function truncationLines(): Record<string, unknown>[] {
  return lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === PAGE_TRUNCATED_EVENT);
}

describe("page-read limit is 2 MB", () => {
  it("MAX_BODY_BYTES is 2,000,000", () => {
    assert.equal(MAX_BODY_BYTES, 2_000_000);
  });

  it("a 1.7 MB page (between 1.5 and 2 MB) is read in full and not logged", async () => {
    const url = "https://store.example.com/product/field-jacket-12345";
    const tail = `${jsonLd("InStock")}<p id="end-marker">end</p></body></html>`;
    const body = `${LIVE_LOOKING}${pad(1_700_000 - LIVE_LOOKING.length - tail.length)}${tail}`;
    assert.equal(Buffer.byteLength(body), 1_700_000);
    const page = await fetchPage(url, serve({ [url]: { body } }));
    assert.equal(Buffer.byteLength(page.html), 1_700_000);
    assert.ok(page.html.includes('id="end-marker"'));
    assert.equal(page.truncated, undefined);
    assert.equal(truncationLines().length, 0);
  });

  it("a 2.5 MB page is cut at 2,000,000 bytes and flagged truncated", async () => {
    const url = "https://store.example.com/item/big";
    const body = `${LIVE_LOOKING}${pad(2_500_000)}</body></html>`;
    const page = await fetchPage(url, serve({ [url]: { body } }));
    assert.equal(Buffer.byteLength(page.html), 2_000_000);
    assert.equal(page.truncated, true);
  });
});

describe("truncation log: one line per cut page, hostname only", () => {
  it("logs the store's domain with no path, query string, or fragment", async () => {
    const url = "https://Shop.Example-Store.com/item/secret-handle?email=buyer%40example.com&token=abc123#frag";
    const body = `${LIVE_LOOKING}${pad(2_100_000)}</body></html>`;
    await verifyUrl(url, serve({ [url]: { body } }), NOW);
    const logged = truncationLines();
    assert.equal(logged.length, 1);
    const line = logged[0];
    assert.equal(line.domain, "shop.example-store.com");
    assert.equal(line.limit_bytes, 2_000_000);
    assert.equal(line.body_bytes, Buffer.byteLength(body));
    assert.equal(line.http_status, 200);
    const raw = lines.find((l) => l.includes(PAGE_TRUNCATED_EVENT)) ?? "";
    for (const leak of ["secret-handle", "email", "buyer", "token", "abc123", "frag", "/item", "?"]) {
      assert.ok(!raw.includes(leak), `log line must not include ${leak}`);
    }
    assert.deepEqual(Object.keys(line).sort(), ["body_bytes", "domain", "event", "http_status", "limit_bytes", "ts"]);
  });
});

const UGG_URL = "https://poshmark.com/listing/UGG-Womens-Black-Adirondack-Boots-6abc1b43d48e7e3b0287e12b";
const UGG_HTML = gunzipSync(
  readFileSync(new URL("./fixtures/poshmark/ugg-adirondack-live-2026-11-12.html.gz", import.meta.url)),
).toString("utf8");

describe("truncated before the listing's own availability field: can't tell", () => {
  it("generic store: live-looking text, own JSON-LD (OutOfStock) past the cut -> unknown, never live", async () => {
    const url = "https://store.example.com/product/field-jacket-12345";
    const body = `${LIVE_LOOKING}${pad(2_100_000)}${jsonLd("OutOfStock")}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body } }), NOW);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
    assert.ok(!verdict.signals.includes("in-stock"));
    assert.ok(verdict.confidence <= 0.5);
  });

  it("generic store: sold-out-looking text, own field past the cut -> unknown, never closed", async () => {
    const url = "https://store.example.com/product/field-jacket-12345";
    const early = `<html><head><title>Field Jacket</title></head><body><h1>Field Jacket</h1><p>$120.00</p><button disabled>Sold out</button>`;
    const body = `${early}${pad(2_100_000)}${jsonLd("InStock")}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body } }), NOW);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
    assert.ok(!verdict.signals.includes("sold-out"));
  });

  it("Poshmark: Buy Now on the page, the listing's own sold fields past the cut -> unknown, never live", async () => {
    const sold = UGG_HTML.replace('"availability":"https://schema.org/InStock"', '"availability":"https://schema.org/SoldOut"').replace(
      /("listingDetails":\{"id":"6abc1b43d48e7e3b0287e12b"[\s\S]{0,3000}?"inventory":\{"status":")available/,
      "$1sold_out",
    );
    const early = `<html><head><title>UGG Adirondack Boots</title></head><body><h1>UGG Adirondack Boots</h1><p>$120</p><button>Buy Now</button>`;
    const body = `${early}${pad(2_100_000)}${sold}`;
    const verdict = await verifyUrl(UGG_URL, serve({ [UGG_URL]: { body } }), NOW);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });

  it("Shopify product.js missing and no schema offers in the read part -> unknown", async () => {
    const url = "https://shop.example.com/products/field-jacket";
    const body = `${LIVE_LOOKING}${pad(2_100_000)}${jsonLd("OutOfStock")}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body } }), NOW);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });
});

describe("truncated but the listing's own field was read: normal verdict", () => {
  it("generic store: own JSON-LD InStock before the cut -> live", async () => {
    const url = "https://store.example.com/product/field-jacket-12345";
    const body = `<html><head><title>Field Jacket</title>${jsonLd("InStock")}</head><body><h1>Field Jacket</h1><p>$120.00</p><button>Add to cart</button>${pad(2_100_000)}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body } }), NOW);
    assert.equal(truncationLines().length, 1);
    assert.equal(verdict.status, "live");
    assert.ok(!verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });

  it("generic store: own JSON-LD OutOfStock before the cut -> closed", async () => {
    const url = "https://store.example.com/product/field-jacket-12345";
    const body = `<html><head><title>Field Jacket</title>${jsonLd("OutOfStock")}</head><body><h1>Field Jacket</h1><p>$120.00</p><button disabled>Sold out</button>${pad(2_100_000)}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body } }), NOW);
    assert.equal(truncationLines().length, 1);
    assert.equal(verdict.status, "closed");
    assert.ok(!verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });

  it("Poshmark UGG: own fields in the read part, filler after -> live from poshmark_available", async () => {
    // The fixture is the 1.5 MB prod read (unclosed state script); filler goes after it.
    const body = `${UGG_HTML}${pad(2_100_000)}`;
    assert.ok(Buffer.byteLength(body) > MAX_BODY_BYTES);
    const verdict = await verifyUrl(UGG_URL, serve({ [UGG_URL]: { body } }), NOW);
    assert.equal(truncationLines().length, 1);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("poshmark_available"));
    assert.ok(!verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });

  it("Shopify: product.js answers for the listing -> its verdict stands on a cut page", async () => {
    const url = "https://shop.example.com/products/field-jacket";
    const productJs = JSON.stringify({
      title: "Field Jacket",
      available: false,
      variants: [{ id: 1, title: "M", available: false, option1: "M" }],
      options: [{ name: "Size", values: ["M"] }],
    });
    const body = `${LIVE_LOOKING}${pad(2_100_000)}</body></html>`;
    const verdict = await verifyUrl(
      url,
      serve({ [url]: { body }, "https://shop.example.com/products/field-jacket.js": { body: productJs, type: "application/json" } }),
      NOW,
    );
    assert.equal(truncationLines().length, 1);
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("shopify_unavailable"));
    assert.ok(!verdict.signals.includes(PAGE_TRUNCATED_SIGNAL));
  });

  it("HTTP 404 on a cut page stays closed (status code, not page text)", async () => {
    const url = "https://store.example.com/item/gone";
    const body = `<html><head><title>Not found</title></head><body><h1>Page not found</h1>${pad(2_100_000)}</body></html>`;
    const verdict = await verifyUrl(url, serve({ [url]: { body, status: 404 } }), NOW);
    assert.equal(verdict.status, "closed");
  });
});
