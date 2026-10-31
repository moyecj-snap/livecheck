import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shopifyProductJsUrl } from "../src/shopify.js";
import { verifyUrl } from "../src/verify.js";

const PRODUCT = "https://ridge-wallet.example/collections/wallets/products/ridge-wallet";
const JS = "https://ridge-wallet.example/products/ridge-wallet.js";
const SOLD_HTML = `<!doctype html><html><head><title>Ridge</title></head><body><button>Add to cart</button><p>In stock.</p></body></html>`;
const LIVE_HTML = `<!doctype html><html><head><title>Ridge</title></head><body><p>Sold out</p></body></html>`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("Shopify product .js", () => {
  it("builds the handle.js URL and ignores collection pages", () => {
    assert.equal(shopifyProductJsUrl(PRODUCT), JS);
    assert.equal(shopifyProductJsUrl("https://shop.example/products/hat.js"), "https://shop.example/products/hat.js");
    assert.equal(shopifyProductJsUrl("https://shop.example/collections/rings"), null);
  });

  it("uses available:false even when the HTML says add to cart", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url === JS) {
        return new Response(JSON.stringify({ title: "Ridge Wallet", available: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(SOLD_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const verdict = await verifyUrl(PRODUCT, fetcher);
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.title, "Ridge Wallet");
    assert.ok(verdict.signals.includes("shopify_unavailable"));
    assert.ok(verdict.signals.includes("sold-out"));
    assert.equal(verdict.signals.includes("in-stock"), false);
    assert.ok(seen.includes(JS));
  });

  it("uses available:true even when the HTML says sold out", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url === JS) {
        return new Response(JSON.stringify({ title: "Ridge Wallet", available: true }), { status: 200 });
      }
      return new Response(LIVE_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const verdict = await verifyUrl(PRODUCT, fetcher);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("shopify_available"));
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("sold-out"), false);
  });

  it("keeps the HTML verdict when the .js endpoint is missing", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.endsWith(".js")) return new Response("nope", { status: 404 });
      return new Response(SOLD_HTML, { status: 200, headers: { "content-type": "text/html" } });
    };
    const verdict = await verifyUrl(PRODUCT, fetcher);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("in-stock"));
    assert.equal(verdict.signals.includes("shopify_available"), false);
    const collection = await verifyUrl("https://ridge-wallet.example/collections/wallets", fetcher);
    assert.equal(seen.filter((url) => url.endsWith(".js")).length, 1);
    assert.equal(collection.signals.includes("shopify_available"), false);
    assert.equal(collection.signals.includes("shopify_unavailable"), false);
  });
});
