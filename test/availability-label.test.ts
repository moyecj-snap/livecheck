import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  detectInStoresOnly,
  hasInStoreOnlyProductData,
  hasProductStoreCta,
  hasVisibleProductNoLongerAvailable,
  hasHiddenProductNoLongerAvailableBox,
  hasOwnVisibleBuyPath,
  hasOwnVisibleProductPrice,
  hasWooProductSummaryBackorder,
  isHiddenNoLongerAvailableWithoutPurchasePath,
} from "../src/availability-label.js";
import { verifyUrl } from "../src/verify.js";
import { readingFromWooProducts, wooStoreApiUrl } from "../src/woocommerce.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const WOO_PAGE = "https://frames.example/product/trail-frame";
const WOO_API = "https://frames.example/wp-json/wc/store/v1/products?slug=trail-frame";
const WOO_HTML = `<!doctype html><html class="woocommerce"><head><title>Trail Frame</title></head><body>
  <h1>Trail Frame</h1><button>Add to cart</button>
  <script>window.cartTemplate = "Available on backorder";</script>
</body></html>`;

const SHOPIFY_PAGE = "https://watches.example/products/steel-watch";
const SHOPIFY_JS = "https://watches.example/products/steel-watch.js";

function shopifyHtml(body: string): string {
  return `<!doctype html><html><head><title>Steel Watch</title></head><body>${body}</body></html>`;
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

describe("WooCommerce Store API backorder", () => {
  it("builds the Store API URL from a /product/ slug", () => {
    assert.equal(wooStoreApiUrl(WOO_PAGE), WOO_API);
    assert.equal(wooStoreApiUrl("https://frames.example/product-category/bikes/"), null);
  });

  it("reads is_on_backorder and stock_availability.class, and ignores a mixed list without a slug match", () => {
    assert.equal(
      readingFromWooProducts(
        [{ slug: "trail-frame", is_on_backorder: true, stock_availability: { class: "available-on-backorder" }, name: "Trail Frame" }],
        "trail-frame",
      )?.backorder,
      true,
    );
    assert.equal(
      readingFromWooProducts(
        [{ slug: "trail-frame", is_on_backorder: false, stock_availability: { class: "in-stock" } }],
        "trail-frame",
      )?.backorder,
      false,
    );
    assert.equal(
      readingFromWooProducts(
        [{ slug: "trail-frame", is_on_backorder: false, stock_availability: { class: "available-on-backorder" } }],
        "trail-frame",
      )?.backorder,
      true,
    );
    assert.equal(
      readingFromWooProducts(
        [
          { slug: "trail-frame-in-stock", is_on_backorder: false },
          { slug: "trail-frame-bo", is_on_backorder: true },
        ],
        "trail-frame",
      ),
      null,
    );
  });

  it("labels a structured backorder live, even if HTML also contains the backorder phrase", async () => {
    const verdict = await verifyUrl(
      WOO_PAGE,
      fetcherFor({
        [WOO_PAGE]: { body: WOO_HTML },
        [WOO_API]: {
          type: "application/json",
          body: JSON.stringify([
            {
              slug: "trail-frame",
              name: "Trail Frame",
              is_on_backorder: true,
              is_in_stock: true,
              stock_availability: { text: "Ship in 4 weeks", class: "available-on-backorder" },
            },
          ]),
        },
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "backorder");
    assert.ok(verdict.signals.includes("backorder"));
    assert.equal(verdict.signals.includes("sold-out"), false);
    assert.equal(verdict.title, "Trail Frame");
  });

  it("does not label an in-stock product whose HTML still contains Available on backorder", async () => {
    const verdict = await verifyUrl(
      WOO_PAGE,
      fetcherFor({
        [WOO_PAGE]: { body: WOO_HTML },
        [WOO_API]: {
          type: "application/json",
          body: JSON.stringify([
            {
              slug: "trail-frame",
              name: "UDH Adapter",
              is_on_backorder: false,
              stock_availability: { text: "In stock", class: "in-stock" },
            },
          ]),
        },
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, undefined);
    assert.equal(verdict.signals.includes("backorder"), false);
  });

  it("never treats the HTML backorder phrase alone as a backorder", async () => {
    const verdict = await verifyUrl(WOO_PAGE, fetcherFor({ [WOO_PAGE]: { body: WOO_HTML } }));
    assert.equal(verdict.label, undefined);
    assert.equal(verdict.signals.includes("backorder"), false);
  });
});


describe("WooCommerce product-summary stock-status backorder", () => {
  const flaanimalHtml = `<!doctype html><html class="woocommerce"><head><title>Flaanimal 6.0 Steel</title></head><body>
  <div class="ral-product-columns">
    <h1>Flaanimal 6.0 Steel</h1>
    <div data-ral-section="stock" data-block-name="woocommerce/product-stock-indicator"
      class="wc-block-components-product-stock-indicator wc-block-components-product-stock-indicator--available-on-backorder">
      <div aria-live="polite">Available on backorder</div>
    </div>
    <form class="cart"><button type="submit">Add to cart</button></form>
  </div>
  <script>window.cartTemplate = "Available on backorder";</script>
</body></html>`;

  const classicSummaryHtml = `<!doctype html><html class="woocommerce"><body>
  <div class="product type-product">
    <div class="summary entry-summary">
      <h1>Flaanimal 6.0 Steel</h1>
      <p class="stock available-on-backorder">Available on backorder</p>
      <form class="cart"><button type="submit">Add to cart</button></form>
    </div>
  </div>
</body></html>`;

  const udhHtml = `<!doctype html><html class="woocommerce"><body>
  <div class="wp-block-woocommerce-add-to-cart-form wc-block-add-to-cart-form">
    <p class="stock in-stock">In stock</p>
    <form class="cart"><button type="submit">Add to cart</button></form>
  </div>
  <div class="wc-block-cart-item">
    <div data-wp-bind--hidden="!state.cartItem.show_backorder_badge" class="wc-block-components-product-badge wc-block-components-product-backorder-badge">Available on backorder</div>
  </div>
</body></html>`;

  const relatedOnlyHtml = `<!doctype html><html class="woocommerce"><body>
  <div class="summary entry-summary">
    <h1>UDH Adapter</h1>
    <p class="stock in-stock">In stock</p>
    <form class="cart"><button type="submit">Add to cart</button></form>
  </div>
  <div class="related products">
    <p class="stock available-on-backorder">Available on backorder</p>
  </div>
  <footer>Available on backorder</footer>
  <div class="woocommerce-tabs"><p class="stock available-on-backorder">Available on backorder</p></div>
</body></html>`;

  it("labels Flaanimal 6 backorder with status live from the product-stock-indicator in the main summary", async () => {
    const verdict = await verifyUrl(WOO_PAGE, fetcherFor({ [WOO_PAGE]: { body: flaanimalHtml } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "backorder");
    assert.ok(verdict.signals.includes("backorder"));
    assert.equal(hasWooProductSummaryBackorder(flaanimalHtml), true);
  });

  it("labels a classic p.stock.available-on-backorder in the product summary as backorder", async () => {
    const verdict = await verifyUrl(WOO_PAGE, fetcherFor({ [WOO_PAGE]: { body: classicSummaryHtml } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "backorder");
  });

  it("leaves the in-stock Rodeo UDH adapter unlabeled when backorder text is only a cart badge", async () => {
    const verdict = await verifyUrl(WOO_PAGE, fetcherFor({ [WOO_PAGE]: { body: udhHtml } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, undefined);
    assert.equal(verdict.signals.includes("backorder"), false);
    assert.equal(hasWooProductSummaryBackorder(udhHtml), false);
  });

  it("does not label when a backorder stock-status element is only outside the main product summary", async () => {
    const verdict = await verifyUrl(WOO_PAGE, fetcherFor({ [WOO_PAGE]: { body: relatedOnlyHtml } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, undefined);
    assert.equal(verdict.signals.includes("backorder"), false);
    assert.equal(hasWooProductSummaryBackorder(relatedOnlyHtml), false);
  });

  it("falls back to the product-summary stock-status element when the Store API returns two same-slug products", async () => {
    const verdict = await verifyUrl(
      WOO_PAGE,
      fetcherFor({
        [WOO_PAGE]: { body: flaanimalHtml },
        [WOO_API]: {
          type: "application/json",
          body: JSON.stringify([
            { slug: "trail-frame", name: "Flaanimal 6.0 Steel", type: "variation", is_on_backorder: false, stock_availability: { text: "In stock", class: "in-stock" } },
            { slug: "trail-frame", name: "Flaanimal 6.0 Steel", type: "variable", is_on_backorder: true, stock_availability: { text: "Available on backorder", class: "available-on-backorder" } },
          ]),
        },
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "backorder");
  });
});

describe("in_stores_only from a product-level store CTA or product data", () => {
  const stockistBlock = `
    <div class="product js-product">
      <div class="product-info">
        <div class="product-info__block">
          <a href="/pages/store-locator" class="btn btn--primary w-full">Find a stockist</a>
        </div>
      </div>
    </div>`;

  const headerOnly = `
    <header>
      <a id="HeaderDrawer-find-in-store" href="/pages/storelocator">Find In Store</a>
      <nav><a id="HeaderMenu-find-in-store" href="/pages/storelocator"><span>Find in Store</span></a></nav>
    </header>
    <form class="product-form"><button type="submit" disabled>Sold out</button></form>`;

  const storeChecker = `
    <nav class="base-navigation"><a href="/stores">Store Locator</a><button>Special Buys</button></nav>
    <div class="product-details">
      <div class="product-details__buying-area"><h1>Planters</h1><div class="base-label">While Stocks Last</div></div>
      <div class="store-stock-checker product-details__store-stock-checker">
        <button type="button" aria-label="Check store availability. Current store: 1, Example">Check Store Availability</button>
      </div>
    </div>`;

  const clearance = `
    <div class="productView productView--clearance-banner" data-event-type="product"
      data-product-category="Clearance Bargains/In Store" data-name="Speaker - In-Store Clearance">
      <div class="productView-clearance-banner">In-store Clearance item</div>
    </div>`;

  it("detects a product-info stockist button and ignores a header Find In Store link", () => {
    assert.equal(hasProductStoreCta(shopifyHtml(stockistBlock)), true);
    assert.equal(hasProductStoreCta(shopifyHtml(headerOnly)), false);
    assert.equal(detectInStoresOnly(shopifyHtml(headerOnly)), false);
  });

  it("detects a product-details Check Store Availability button, not a nav Store Locator", () => {
    assert.equal(hasProductStoreCta(shopifyHtml(storeChecker)), true);
    assert.equal(
      hasProductStoreCta(
        shopifyHtml(
          `<nav><a href="/stores">Store Locator</a></nav><div class="product-details"><h1>Planters</h1><button>Add to cart</button></div>`,
        ),
      ),
      false,
    );
  });

  it("detects in-store clearance product data and not a CSS-only class mention", () => {
    assert.equal(hasInStoreOnlyProductData(shopifyHtml(clearance)), true);
    assert.equal(
      hasInStoreOnlyProductData(
        shopifyHtml(`<script>.productView--clearance-banner{top:0}</script><div class="product-info"><button>Add to cart</button></div>`),
      ),
      false,
    );
  });

  it("does not label a live product that has both a stockist button and Add to cart", () => {
    const html = shopifyHtml(`
      <div class="product-info">
        <button>Add to cart</button>
        <div class="product-info__block"><a href="/pages/store-locator" class="btn btn--primary">Find a stockist</a></div>
      </div>`);
    assert.equal(hasProductStoreCta(html), false);
  });

  it("overrides Shopify sold-out when the product's own stockist button is present", async () => {
    const related = `<div class="product-card"><a href="/products/other" class="btn btn--primary w-full">Add to cart</a></div>`;
    const verdict = await verifyUrl(
      SHOPIFY_PAGE,
      fetcherFor({
        [SHOPIFY_PAGE]: { body: shopifyHtml(stockistBlock + related) },
        [SHOPIFY_JS]: { type: "application/json", body: JSON.stringify({ title: "Steel Watch", available: false }) },
      }),
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
    assert.ok(verdict.signals.includes("in_stores_only"));
    assert.equal(verdict.signals.includes("sold-out"), false);
    assert.equal(verdict.signals.includes("shopify_unavailable"), false);
  });

  it("keeps Shopify sold-out when Find In Store is only a header link (live-store negative uses the same header)", async () => {
    const sold = await verifyUrl(
      SHOPIFY_PAGE,
      fetcherFor({
        [SHOPIFY_PAGE]: { body: shopifyHtml(headerOnly) },
        [SHOPIFY_JS]: { type: "application/json", body: JSON.stringify({ title: "Steel Watch", available: false }) },
      }),
    );
    assert.equal(sold.status, "closed");
    assert.equal(sold.label, undefined);
    assert.ok(sold.signals.includes("sold-out"));

    const liveHeader = `
      <header><a id="HeaderMenu-find-in-store" href="/pages/storelocator"><span>Find in Store</span></a></header>
      <form class="product-form"><button type="submit">Add to cart</button></form>`;
    const live = await verifyUrl(
      SHOPIFY_PAGE,
      fetcherFor({
        [SHOPIFY_PAGE]: { body: shopifyHtml(liveHeader) },
        [SHOPIFY_JS]: { type: "application/json", body: JSON.stringify({ title: "Bandana", available: true }) },
      }),
    );
    assert.equal(live.status, "live");
    assert.equal(live.label, undefined);
  });

  it("labels a stores-only product with a product-level store availability button and no Add to cart", async () => {
    const verdict = await verifyUrl(SHOPIFY_PAGE, fetcherFor({ [SHOPIFY_PAGE]: { body: shopifyHtml(storeChecker) } }));
    // This URL is /products/ so Shopify product.js 404s; without a store CTA this
    // might become can't-tell, but the product button is an own field.
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
  });

  it("labels an in-store clearance product from product data, even with no Add to cart", async () => {
    const url = "https://audio.example/speaker-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: shopifyHtml(clearance) } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
  });
});

describe("visible 'no longer available' beats in-store wording", () => {
  const visibleGone = (name: string) => `
    <div class="productView productView--clearance-banner" data-event-type="product"
      data-product-category="Clearance Bargains/In Store" data-name="${name} - In-Store Clearance">
      <div class="productView-clearance-banner">In-store Clearance item</div>
      <div class="outofstock-cta">
        <h4 class="outofstock-cta__heading">Unfortunately this product is no longer available.</h4>
        <p class="outofstock-cta__text">For advice on an alternative product, contact Telesales.</p>
      </div>
      <button disabled class="productView-clearance-reminder-link">Check store availability</button>
    </div>`;

  const hiddenTemplate = `
    <div class="productView productView--clearance-banner" data-event-type="product"
      data-product-category="Clearance Bargains/In Store" data-name="Speaker - In-Store Clearance">
      <div class="productView-clearance-banner">In-store Clearance item</div>
      <div class="productView-price"><div class="productPrice__main">£599</div></div>
      <div class="outofstock-cta hidden">
        <h4 class="outofstock-cta__heading">Unfortunately this product is no longer available.</h4>
      </div>
      <button type="button" class="store-stock-checker">Check store availability</button>
    </div>`;

  it("treats a visible no-longer-available message as gone (Focal Theva stands)", async () => {
    const html = shopifyHtml(visibleGone("Focal Theva Stands"));
    assert.equal(hasVisibleProductNoLongerAvailable(html), true);
    const url = "https://audio.example/focal-theva-stands-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.label, undefined);
    assert.ok(verdict.signals.includes("no_longer_available"));
    assert.equal(verdict.signals.includes("in_stores_only"), false);
  });

  it("treats a visible no-longer-available message as gone (TEAC W1200)", async () => {
    const html = shopifyHtml(visibleGone("Teac W1200 (Silver)"));
    assert.equal(hasVisibleProductNoLongerAvailable(html), true);
    const url = "https://audio.example/teac-w1200-silver-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.label, undefined);
    assert.ok(verdict.signals.includes("no_longer_available"));
    assert.equal(verdict.signals.includes("in_stores_only"), false);
  });

  it("ignores a hidden no-longer-available template when the product is still in-store only", async () => {
    const html = shopifyHtml(hiddenTemplate);
    assert.equal(hasVisibleProductNoLongerAvailable(html), false);
    const url = "https://audio.example/dali-sonik-3-white-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
  });

  it("does not treat the word in-store in a URL or title as in_stores_only", () => {
    const html = shopifyHtml(`
      <head><title>Speaker Stands - In-Store Clearance</title></head>
      <h1>Speaker Stands - In-Store Clearance</h1>
      <p>Browse our in-store clearance range.</p>`);
    const url = "https://audio.example/speaker-stands-in-store-clearance/";
    assert.equal(detectInStoresOnly(html, url), false);
  });
});


describe("hidden 'no longer available' box plus no price and no buy path is gone", () => {
  const hiddenGone = (name: string) => `
    <div class="productView productView--clearance-banner" data-event-type="product"
      data-product-category="Clearance Bargains/In Store" data-name="${name} - In-Store Clearance">
      <div class="productView-clearance-banner">In-store Clearance item</div>
      <h1 class="productView-title">${name} - In-Store Clearance</h1>
      <div class="outofstock-cta hidden">
        <h4 class="outofstock-cta__heading">Unfortunately this product is no longer available.</h4>
        <p class="outofstock-cta__text">For advice on an alternative product, contact Telesales.</p>
      </div>
    </div>`;

  const fyne = `
    <div class="productView productView--clearance-banner" data-event-type="product"
      data-product-category="Clearance Bargains/In Store" data-name="Fyne Audio F501SP - In-Store Clearance">
      <div class="productView-clearance-banner">In-store Clearance item</div>
      <h1 class="productView-title">Fyne Audio F501SP (Piano Gloss White) - In-Store Clearance</h1>
      <div class="outofstock-cta hidden">
        <h4 class="outofstock-cta__heading">Unfortunately this product is no longer available.</h4>
      </div>
      <button disabled class="productView-clearance-reminder-link">Check store availability</button>
    </div>`;

  it("treats a hidden no-longer-available box with no price and no buy path as gone (Focal Theva stands)", async () => {
    const html = shopifyHtml(hiddenGone("Focal Theva Stands"));
    assert.equal(hasHiddenProductNoLongerAvailableBox(html), true);
    assert.equal(hasOwnVisibleProductPrice(html), false);
    assert.equal(hasOwnVisibleBuyPath(html), false);
    assert.equal(isHiddenNoLongerAvailableWithoutPurchasePath(html), true);
    const url = "https://audio.example/focal-theva-stands-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("no_longer_available"));
    assert.equal(verdict.signals.includes("in_stores_only"), false);
  });

  it("treats a hidden no-longer-available box with no price and no buy path as gone (TEAC W1200)", async () => {
    const html = shopifyHtml(hiddenGone("Teac W1200 (Silver)"));
    const url = "https://audio.example/teac-w1200-silver-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("no_longer_available"));
    assert.equal(verdict.signals.includes("in_stores_only"), false);
  });

  it("keeps Fyne in_stores_only when a Check store availability control remains outside the hidden box", async () => {
    const html = shopifyHtml(fyne);
    assert.equal(hasHiddenProductNoLongerAvailableBox(html), true);
    assert.equal(hasOwnVisibleProductPrice(html), false);
    assert.equal(hasOwnVisibleBuyPath(html), true);
    assert.equal(isHiddenNoLongerAvailableWithoutPurchasePath(html), false);
    const url = "https://audio.example/fyne-audio-f501sp-piano-gloss-white-in-store-clearance/";
    const verdict = await verifyUrl(url, fetcherFor({ [url]: { body: html } }));
    assert.equal(verdict.status, "live");
    assert.equal(verdict.label, "in_stores_only");
    assert.equal(verdict.signals.includes("no_longer_available"), false);
  });
});

