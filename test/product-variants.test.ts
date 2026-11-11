import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideVariants, linkedVariantSelector, schemaVariants } from "../src/product-variants.js";
import { verifyUrl } from "../src/verify.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function html(body: string, ld?: unknown): string {
  const script = ld === undefined ? "" : `<script type="application/ld+json">${JSON.stringify(ld)}</script>`;
  return `<!doctype html><html><head><title>Towels</title>${script}</head><body>${body}</body></html>`;
}

function site(pages: Record<string, { status: number; body: string; type?: string }>): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    const hit = pages[url] ?? pages[url.split("?")[0]];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status, headers: { "content-type": hit.type ?? "text/html" } });
  };
}

const ADD = `<h1>Plush Hand Towels</h1><button type="submit">Add to bag</button>`;

// Shaped like bollandbranch.com (headless, Nov 11, 2026): product.js 404,
// one sibling Product per color with isVariantOf; only Holly is out of stock.
const BB_PAGE = "https://shop.example/products/plush-hand-towels-pair/";
const BB_JS = "https://shop.example/products/plush-hand-towels-pair.js";
const BB_LD = [
  { "@type": "ProductGroup", name: "Plush Hand Towels", variesBy: ["https://schema.org/color"] },
  ...[
    ["White", "InStock"],
    ["Cream", "InStock"],
    ["Holly", "OutOfStock"],
  ].map(([color, availability]) => ({
    "@type": "Product",
    color,
    isVariantOf: { "@id": "#group" },
    url: `https://shop.example/products/plush-hand-towels-pair_/?color=${color}`,
    offers: { "@type": "Offer", availability: `https://schema.org/${availability}` },
  })),
];
const BB_HTML = html(`${ADD}<span>Holly product variant, out of stock</span>`, BB_LD);

// Shaped like buckmason.com: AggregateOffer InStock plus per-size Offers,
// two sizes out of stock, product.js 404 (headless).
const BM_PAGE = "https://pants.example/products/natural-hollywood-pleated-trouser";
const BM_LD = {
  "@type": "Product",
  name: "Natural Hollywood Pleated Trouser",
  color: "natural",
  offers: [
    { "@type": "AggregateOffer", availability: "https://schema.org/InStock" },
    { "@type": "Offer", sku: "NAT28", availability: "https://schema.org/OutOfStock", itemOffered: { size: "28" } },
    { "@type": "Offer", sku: "NAT29", availability: "https://schema.org/OutOfStock", itemOffered: { size: "29" } },
    { "@type": "Offer", sku: "NAT30", availability: "https://schema.org/InStock", itemOffered: { size: "30" } },
  ],
};

function shopifyJs(variants: Array<{ id: number; option1: string; available: boolean }>) {
  return JSON.stringify({
    title: "Duffle",
    available: variants.some((v) => v.available),
    options: [{ name: "Color", position: 1, values: variants.map((v) => v.option1) }],
    variants,
  });
}

const DUFFLE = "https://bags.example/products/duffle";
const DUFFLE_JS = "https://bags.example/products/duffle.js";
const DUFFLE_HTML = html(`${ADD}<span>Black — Sold out</span>`);

describe("variant rule 1: check the exact linked variant", () => {
  it("reads ?variant= and color/size params from the link", () => {
    assert.deepEqual(linkedVariantSelector("https://s.example/products/a?variant=123&Colour=Deep+Plum&utm_source=x"), {
      variantId: "123",
      options: [{ name: "color", value: "Deep Plum" }],
    });
    assert.deepEqual(linkedVariantSelector("https://s.example/products/a"), { options: [] });
  });

  it("?variant=<id> in stock is live even when another variant is sold out (product.js)", async () => {
    const fetcher = site({
      [DUFFLE]: { status: 200, body: DUFFLE_HTML },
      [DUFFLE_JS]: {
        status: 200,
        type: "application/json",
        body: shopifyJs([
          { id: 11, option1: "Black", available: false },
          { id: 22, option1: "Olive", available: true },
        ]),
      },
    });
    const live = await verifyUrl(`${DUFFLE}?variant=22`, fetcher);
    assert.equal(live.status, "live");
    assert.ok(live.signals.includes("linked_variant_available"));
    assert.equal(live.signals.includes("sold-out"), false);
  });

  it("?variant=<id> sold out is closed even when another variant is in stock", async () => {
    const fetcher = site({
      [DUFFLE]: { status: 200, body: DUFFLE_HTML },
      [DUFFLE_JS]: {
        status: 200,
        type: "application/json",
        body: shopifyJs([
          { id: 11, option1: "Black", available: false },
          { id: 22, option1: "Olive", available: true },
        ]),
      },
    });
    const closed = await verifyUrl(`${DUFFLE}?variant=11`, fetcher);
    assert.equal(closed.status, "closed");
    assert.ok(closed.signals.includes("linked_variant_unavailable"));
    const missing = await verifyUrl(`${DUFFLE}?variant=99`, fetcher);
    assert.equal(missing.status, "unknown");
    assert.ok(missing.signals.includes("linked_variant_not_found"));
  });

  it("?color=White maps to the White variant in schema.org offers (Boll & Branch shape)", async () => {
    const fetcher = site({ [BB_PAGE]: { status: 200, body: BB_HTML } });
    const white = await verifyUrl(`${BB_PAGE}?color=White`, fetcher);
    assert.equal(white.status, "live");
    assert.ok(white.signals.includes("linked_option_available"));
    assert.ok(white.signals.includes("schema_variant_available"));
    assert.equal(white.signals.includes("sold-out"), false);
    const holly = await verifyUrl(`${BB_PAGE}?color=Holly`, fetcher);
    assert.equal(holly.status, "closed");
    assert.ok(holly.signals.includes("linked_option_unavailable"));
  });

  it("?color= maps through product.js option names too", async () => {
    const fetcher = site({
      [DUFFLE]: { status: 200, body: DUFFLE_HTML },
      [DUFFLE_JS]: {
        status: 200,
        type: "application/json",
        body: shopifyJs([
          { id: 11, option1: "Black", available: false },
          { id: 22, option1: "Olive", available: true },
        ]),
      },
    });
    assert.equal((await verifyUrl(`${DUFFLE}?color=olive`, fetcher)).status, "live");
    assert.equal((await verifyUrl(`${DUFFLE}?color=Black`, fetcher)).status, "closed");
  });
});

describe("variant rule 2: no variant in the link", () => {
  it("is live when any variant can be bought, despite a sold-out swatch (product.js)", async () => {
    const fetcher = site({
      [DUFFLE]: { status: 200, body: DUFFLE_HTML },
      [DUFFLE_JS]: {
        status: 200,
        type: "application/json",
        body: shopifyJs([
          { id: 11, option1: "Black", available: false },
          { id: 22, option1: "Olive", available: true },
        ]),
      },
    });
    const verdict = await verifyUrl(DUFFLE, fetcher);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("some_variants_available"));
  });

  it("is closed only when every variant is unavailable", async () => {
    const fetcher = site({
      [DUFFLE]: { status: 200, body: DUFFLE_HTML },
      [DUFFLE_JS]: {
        status: 200,
        type: "application/json",
        body: shopifyJs([
          { id: 11, option1: "Black", available: false },
          { id: 22, option1: "Olive", available: false },
        ]),
      },
    });
    const verdict = await verifyUrl(DUFFLE, fetcher);
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes("all_variants_unavailable"));
  });

  it("reads per-size schema.org offers and ignores AggregateOffer (Buck Mason shape)", async () => {
    const someOut = site({ [BM_PAGE]: { status: 200, body: html(ADD, BM_LD) } });
    const live = await verifyUrl(BM_PAGE, someOut);
    assert.equal(live.status, "live");
    assert.ok(live.signals.includes("schema_variant_available"));

    const allOutLd = {
      ...BM_LD,
      offers: BM_LD.offers.map((o) =>
        o["@type"] === "Offer" ? { ...o, availability: "https://schema.org/OutOfStock" } : o,
      ),
    };
    const allOut = site({ [BM_PAGE]: { status: 200, body: html(ADD, allOutLd) } });
    const closed = await verifyUrl(BM_PAGE, allOut);
    assert.equal(closed.status, "closed");
    assert.ok(closed.signals.includes("all_variants_unavailable"));
  });

  it("decideVariants: unclear readings never become closed", () => {
    assert.deepEqual(decideVariants([{ available: false, options: {} }, { available: null, options: {} }], { options: [] }), {
      status: "unknown",
      signal: "variants_unclear",
    });
    assert.equal(schemaVariants(html(ADD, BM_LD)).length, 3);
  });
});

describe("variant rule 3: backup lookup fails -> can't tell", () => {
  it("product.js 404 on a headless store with a 200 sold-out-looking page is unknown, not closed", async () => {
    const page = "https://headless.example/products/trouser";
    const fetcher = site({
      [page]: { status: 200, body: html(`${ADD}<button aria-label="Size 28 not available">Sold out</button>`) },
      "https://headless.example/products/trouser.js": { status: 404, body: '{"error":"not_found"}', type: "application/json" },
    });
    const verdict = await verifyUrl(page, fetcher);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("variant_check_unavailable"));
    assert.equal(verdict.signals.includes("sold-out"), false);
  });

  it("a whole-page HTTP 404 stays closed", async () => {
    const verdict = await verifyUrl("https://headless.example/products/gone", site({}));
    assert.equal(verdict.status, "closed");
  });

  it("the Boll & Branch White link is never closed when product.js 404s", async () => {
    const fetcher = site({ [BB_PAGE]: { status: 200, body: BB_HTML }, [BB_JS]: { status: 404, body: "<html>404</html>" } });
    const verdict = await verifyUrl(`${BB_PAGE}?color=White`, fetcher);
    assert.notEqual(verdict.status, "closed");
  });
});
