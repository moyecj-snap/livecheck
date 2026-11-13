import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { detectInStoresOnly } from "../src/availability-label.js";
import {
  applyStructuredPageConflict,
  hasWorkingProductFormAddToCart,
  jsonLdNotForSaleOnStore,
  parseWooFormVariations,
} from "../src/structured-availability.js";
import { verifyUrl } from "../src/verify.js";
import type { VerifyVerdict } from "../src/types.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetcherFor(routes: Record<string, { body: string; type?: string; status?: number }>): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, {
      status: hit.status ?? 200,
      headers: { "content-type": hit.type ?? "text/html" },
    });
  };
}

function page(url: string, html: string, extra: Record<string, { body: string; type?: string }> = {}) {
  return fetcherFor({ [url]: { body: html }, ...extra });
}

const WOO_VARS = [
  {
    attributes: { attribute_pa_color: "white" },
    availability_html: '<p class="stock out-of-stock">Out of stock</p>\n',
    is_in_stock: false,
    is_purchasable: true,
    variation_id: 39728,
  },
  {
    attributes: { attribute_pa_color: "black" },
    availability_html: '<p class="stock in-stock">In stock</p>\n',
    is_in_stock: true,
    is_purchasable: true,
    variation_id: 39729,
  },
];

function wooHtml(variations = WOO_VARS): string {
  const encoded = JSON.stringify(variations)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;");
  return `<!doctype html><html class="woocommerce"><head><title>Art Markers</title></head><body>
    <h1>Art Markers</h1>
    <form class="variations_form cart" method="post" data-product_id="39725" data-product_variations="${encoded}">
      <select name="attribute_pa_color"><option value="white">White</option><option value="black">Black</option></select>
      <button type="submit" class="single_add_to_cart_button">Add to cart</button>
    </form>
  </body></html>`;
}

describe("WooCommerce form variations", () => {
  it("parses is_in_stock and color attributes from data-product_variations", () => {
    const variants = parseWooFormVariations(wooHtml());
    assert.equal(variants.length, 2);
    assert.deepEqual(
      variants.map((v) => ({ id: v.id, available: v.available, color: v.options.color })),
      [
        { id: "39728", available: false, color: "white" },
        { id: "39729", available: true, color: "black" },
      ],
    );
  });

  it("treats an unlinked variable product as live when any variant is in stock, even if the HTML also says Out of stock", async () => {
    const url = "https://markers.example/product/art-markers/";
    const verdict = await verifyUrl(url, page(url, wooHtml()));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, undefined);
    assert.ok(verdict.signals.includes("woo_available"));
    assert.ok(verdict.signals.includes("some_variants_available"));
    assert.equal(verdict.signals.includes("sold-out"), false);
  });

  it("judges a linked color on that variant only", async () => {
    const live = "https://markers.example/product/art-markers/?color=Black";
    const sold = "https://markers.example/product/art-markers/?color=White";
    const html = wooHtml();
    const liveVerdict = await verifyUrl(live, page(live, html));
    const soldVerdict = await verifyUrl(sold, page(sold, html));
    assert.equal(liveVerdict.status, "live");
    assert.ok(liveVerdict.signals.includes("linked_option_available"));
    assert.equal(soldVerdict.status, "closed");
    assert.ok(soldVerdict.signals.includes("linked_option_unavailable"));
  });

  it("is sold out only when every form variant is unavailable", async () => {
    const url = "https://markers.example/product/clip/";
    const allOut = WOO_VARS.map((v) => ({ ...v, is_in_stock: false }));
    const verdict = await verifyUrl(url, page(url, wooHtml(allOut)));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("all_variants_unavailable"));
  });
});

describe("JSON-LD product description not for sale on this store", () => {
  const url = "https://www.coffee.example/products/cold-brew-48oz";
  const js = "https://www.coffee.example/products/cold-brew-48oz.js";

  function coffeeHtml(desc: string, availability = "http://schema.org/OutOfStock"): string {
    const ld = {
      "@context": "https://schema.org/",
      "@type": "Product",
      name: "Cold Brew",
      description: desc,
      offers: [{ "@type": "Offer", availability, price: 5.99, priceCurrency: "USD" }],
    };
    return `<!doctype html><html><head><title>Cold Brew</title>
      <script type="application/ld+json">${JSON.stringify(ld)}</script>
      </head><body>
      <header><a id="HeaderMenu-find-in-store" href="/pages/storelocator"><span>Find in Store</span></a></header>
      <form class="product-form"><button type="submit" disabled>Sold out</button></form>
      </body></html>`;
  }

  const notForSale =
    "This product is not available for sale on coffee.example. Please visit your local grocer for availability.";

  it("reads only the product JSON-LD description, never a header Find In Store link", () => {
    assert.equal(jsonLdNotForSaleOnStore(coffeeHtml(notForSale), url), true);
    assert.equal(jsonLdNotForSaleOnStore(coffeeHtml("A bold brew."), url), false);
    assert.equal(jsonLdNotForSaleOnStore(coffeeHtml("This product is not available for sale on other-store.example."), url), false);
    assert.equal(detectInStoresOnly(coffeeHtml(notForSale), url), true);
    assert.equal(detectInStoresOnly(coffeeHtml("A bold brew."), url), false);
  });

  it("overrides Shopify sold-out when the product JSON-LD says it is not for sale on this store", async () => {
    const html = coffeeHtml(notForSale);
    const verdict = await verifyUrl(
      url,
      fetcherFor({
        [url]: { body: html },
        [js]: { type: "application/json", body: JSON.stringify({ title: "Cold Brew", available: false, variants: [{ id: 1, available: false }] }) },
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
    assert.equal(verdict.signals.includes("sold-out"), false);
  });

  it("keeps Shopify sold-out when JSON-LD has no not-for-sale statement, even with a header Find In Store link", async () => {
    const verdict = await verifyUrl(
      url,
      fetcherFor({
        [url]: { body: coffeeHtml("A bold brew.") },
        [js]: { type: "application/json", body: JSON.stringify({ title: "Bandana", available: false, variants: [{ id: 1, available: false }] }) },
      }),
    );
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.label, undefined);
    assert.ok(verdict.signals.includes("sold-out"));
  });
});

describe("structured data vs product-form Add to cart conflict", () => {
  const url = "https://tray.example/products/gallery-tray";
  const js = "https://tray.example/products/gallery-tray.js";
  const formHtml = `<!doctype html><html><head><title>Tray</title></head><body>
    <form action="/cart/add" method="post" class="product-form" id="AddToCartForm">
      <select name="id" id="productSelect" class="product-single__variants">
        <option selected="selected" value="1">Default Title</option>
      </select>
      <div class="product-btn">
        <button type="submit" name="add" id="AddToCart" class="btn btn-primary">
          <span id="AddToCartText">Add to cart</span>
        </button>
      </div>
    </form>
  </body></html>`;

  it("detects a working product-form Add to cart and not a bare page button", () => {
    assert.equal(hasWorkingProductFormAddToCart(formHtml), true);
    assert.equal(hasWorkingProductFormAddToCart(`<html><body><button>Add to cart</button><p>In stock.</p></body></html>`), false);
  });

  it("returns can't tell when product.js is sold out and the product form still has Add to cart", async () => {
    const verdict = await verifyUrl(
      url,
      fetcherFor({
        [url]: { body: formHtml },
        [js]: { type: "application/json", body: JSON.stringify({ title: "Gallery Tray", available: false, variants: [{ id: 1, available: false }] }) },
      }),
    );
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("structured_page_conflict"));
    assert.equal(verdict.signals.includes("sold-out"), false);
    assert.equal(verdict.label, undefined);
  });

  it("ignores a later related-product Add to cart when the primary product button is Sold out", () => {
    const html = `<!doctype html><html><head><title>Combo</title></head><body>
      <form action="/cart/add" method="post" class="product-form">
        <button type="submit" name="add" id="AddToCart" class="sold-out" disabled>
          <span>Sold out</span>
        </button>
      </form>
      <form action="/cart/add" method="post" class="product-form">
        <button type="submit" name="add" id="AddToCart" class="button">
          <span>Add to Cart</span>
        </button>
      </form>
    </body></html>`;
    assert.equal(hasWorkingProductFormAddToCart(html), false);
  });

  it("ignores earlier product-card Add to cart forms whose variant id is not this product", () => {
    const html = `<!doctype html><html><head><title>Playhouse</title></head><body>
      <form method="post" action="/cart/add" id="ProductCardBasicAtcForm" class="shopify-product-form">
        <input type="hidden" name="id" value="111" />
        <button type="submit" class="btn">Add to cart</button>
      </form>
      <form method="post" action="/cart/add" id="mic5-pdp-form" class="shopify-product-form">
        <input type="hidden" name="id" value="222" data-mic5-variant-id />
        <button type="submit" id="mic5-atc" aria-label="Add to cart: Playhouse, $199.00" disabled>Sold out</button>
      </form>
      <form method="post" action="/cart/add" id="ph-decor-p1" class="shopify-product-form">
        <input type="hidden" name="id" value="333" />
        <button type="submit" class="btn">Add to cart</button>
      </form>
    </body></html>`;
    assert.equal(hasWorkingProductFormAddToCart(html, ["222"]), false);
    const page: VerifyVerdict = {
      url: "https://kids.example/products/playhouse",
      canonical_url: "https://kids.example/products/playhouse",
      status: "closed",
      http_status: 200,
      checked_at: "2026-11-12T00:00:00Z",
      signals: ["shopify_unavailable", "sold-out", "all_variants_unavailable"],
      confidence: 0.9,
      price_usd: 0.01,
    };
    const after = applyStructuredPageConflict(page, html, ["222"]);
    assert.equal(after.status, "closed");
    assert.ok(!after.signals.includes("structured_page_conflict"));
  });

  it("does not relabel an already-decided sold-out page that has no product-form Add to cart", () => {
    const page: VerifyVerdict = {
      url,
      canonical_url: url,
      status: "closed",
      http_status: 200,
      checked_at: "2026-11-12T00:00:00Z",
      signals: ["shopify_unavailable", "sold-out"],
      confidence: 0.9,
      price_usd: 0.01,
    };
    const next = applyStructuredPageConflict(page, `<html><body><button>Add to cart</button></body></html>`);
    assert.equal(next.status, "closed");
    assert.ok(next.signals.includes("sold-out"));
  });
});
