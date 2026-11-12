import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { EBAY_BROWSE_BASE, EBAY_OAUTH_URL, resetEbayDisabledLog, resetEbayTokenCache } from "../src/ebay.js";
import { verifyUrl } from "../src/verify.js";

// Live eBay item from the Nov 1 13-product test (p9). eBay returns HTTP 403 for
// item HTML to both the box and the prod machine (checked Nov 12, 2026,
// ~10:49 AM PT), so the page below is eBay-shaped, not a saved eBay page: the
// item's own JSON-LD offer is InStock with Buy It Now, and the page also has a
// "Similar sold items" carousel whose tiles read "Sold out" / OutOfStock.
const ITEM_ID = "177509485369";
const ITEM_URL = `https://www.ebay.com/itm/${ITEM_ID}`;
const ENV_KEYS = ["EBAY_CLIENT_ID", "EBAY_CLIENT_SECRET", "EBAY_DEV_ID", "EBAY_MARKETPLACE_ID"] as const;
const saved: Record<string, string | undefined> = {};
for (const key of ENV_KEYS) saved[key] = process.env[key];

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetEbayTokenCache();
  resetEbayDisabledLog();
});

function similarSoldTile(id: string): string {
  return `<li class="s-item"><a href="https://www.ebay.com/itm/${id}"><span class="s-item__title">Similar camera ${id}</span></a><span class="s-item__sold">Sold out</span></li>`;
}

function itemPage(ownAvailability: "InStock" | "OutOfStock"): string {
  const ownLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "Vintage Camera",
    offers: { "@type": "Offer", url: ITEM_URL, price: "45.00", priceCurrency: "USD", availability: `https://schema.org/${ownAvailability}` },
  };
  const similarLd = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Similar sold items",
    itemListElement: ["111111111111", "222222222222"].map((id, i) => ({
      "@type": "ListItem",
      position: i + 1,
      item: { "@type": "Product", name: `Similar camera ${id}`, offers: { "@type": "Offer", url: `https://www.ebay.com/itm/${id}`, availability: "https://schema.org/OutOfStock" } },
    })),
  };
  const buy = ownAvailability === "InStock" ? `<a class="ux-call-to-action" href="#">Buy It Now</a><button>Add to cart</button>` : "";
  return `<!doctype html><html><head><title>Vintage Camera | eBay</title>
<script type="application/ld+json">${JSON.stringify(ownLd)}</script>
<script type="application/ld+json">${JSON.stringify(similarLd)}</script></head>
<body><h1 class="x-item-title__mainTitle">Vintage Camera</h1>${buy}
<section class="similar-sold"><h2>Similar sold items</h2><ul>${similarSoldTile("111111111111")}${similarSoldTile("222222222222")}</ul></section>
</body></html>`;
}

function site(html: string, browse?: unknown): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /itm/watch/\n", { status: 200 });
    if (url === EBAY_OAUTH_URL) return Response.json({ access_token: "tok", expires_in: 7200 });
    if (url.startsWith(EBAY_BROWSE_BASE)) return Response.json(browse ?? {});
    if (url.startsWith(ITEM_URL)) return new Response(html, { status: 200, headers: { "content-type": "text/html" } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe("eBay: similar sold items never close a live item", () => {
  it("Browse API path: live item stays live and the item HTML is never read", async () => {
    process.env.EBAY_CLIENT_ID = "test-ebay-client-id";
    process.env.EBAY_CLIENT_SECRET = "test-ebay-client-secret";
    const { fetchImpl, urls } = site(itemPage("InStock"), {
      title: "Vintage Camera",
      estimatedAvailabilities: [{ estimatedAvailabilityStatus: "IN_STOCK" }],
    });
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "live");
    assert.deepEqual(verdict.signals, ["ebay-in-stock"]);
    assert.equal(urls.some((u) => u.startsWith(ITEM_URL)), false);
  });

  it("HTML fallback (no eBay creds): live item with a similar-sold-items carousel is not closed", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const { fetchImpl } = site(itemPage("InStock"));
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("ebay_item_available"));
    assert.ok(!verdict.signals.includes("sold-out"));
  });

  it("HTML fallback: the item's own OutOfStock offer is still closed", async () => {
    delete process.env.EBAY_CLIENT_ID;
    delete process.env.EBAY_CLIENT_SECRET;
    const { fetchImpl } = site(itemPage("OutOfStock"));
    const verdict = await verifyUrl(ITEM_URL, fetchImpl);
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("ebay_item_unavailable"));
  });
});
