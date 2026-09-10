import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_USD,
  OPENAPI_CONFIRM_DESCRIPTION,
  OPENAPI_CONFIRM_INTENT_DESCRIPTION,
  OPENAPI_CONFIRM_SUMMARY,
  CHECK_PAYMENT_DESCRIPTION,
  CHECK_PRICE_ATOMIC_USDC,
  CHECK_PRICE_USD,
  CHAIN_TOPUP_PAYMENT_DESCRIPTION,
  CHAIN_TOPUP_PRICE_ATOMIC_USDC,
  CHAIN_TOPUP_PRICE_USD,
  WATCH_PAYMENT_DESCRIPTION,
  WATCH_PRICE_ATOMIC_USDC,
  WATCH_PRICE_USD,
  ORDER_PLACED_PRICE_ATOMIC_USDC,
  ORDER_PLACED_PRICE_USD,
  CONFIRM_RESOURCE_TAGS,
  CONFIRM_SERVICE_NAME,
  DEFAULT_PORT,
  PRICE_ATOMIC_USDC,
  PRICE_USD,
  VERIFY_DESCRIPTION,
  port,
} from "../src/config.js";

describe("PORT bind", () => {
  it("defaults to 43127 when PORT is unset", () => {
    const previous = process.env.PORT;
    delete process.env.PORT;
    try {
      assert.equal(port(), DEFAULT_PORT);
      assert.equal(port(), 43127);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });

  it("honors process.env.PORT when set", () => {
    const previous = process.env.PORT;
    process.env.PORT = "8080";
    try {
      assert.equal(port(), 8080);
    } finally {
      if (previous === undefined) delete process.env.PORT;
      else process.env.PORT = previous;
    }
  });
});

describe("listing price and description", () => {
  it("is $0.01 USDC (10000 atomic) with the approved Bazaar copy", () => {
    assert.equal(PRICE_USD, 0.01);
    assert.equal(PRICE_ATOMIC_USDC, "10000");
    assert.equal(
      VERIFY_DESCRIPTION,
      "Before you scrape a job posting, Shopify or HTML product page, or eBay item, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.",
    );
    assert.equal(CONFIRM_PRICE_USD, 0.1);
    assert.equal(CONFIRM_PRICE_ATOMIC_USDC, "100000");
    assert.equal(ORDER_PLACED_PRICE_USD, 0.25);
    assert.equal(ORDER_PLACED_PRICE_ATOMIC_USDC, "250000");
    assert.equal(CHECK_PRICE_USD, 0.02);
    assert.equal(CHECK_PRICE_ATOMIC_USDC, "20000");
    assert.equal(WATCH_PRICE_USD, 2.5);
    assert.equal(WATCH_PRICE_ATOMIC_USDC, "2500000");
    assert.equal(CHAIN_TOPUP_PRICE_USD, 0.5);
    assert.equal(CHAIN_TOPUP_PRICE_ATOMIC_USDC, "500000");
    assert.equal(
      [...CHAIN_TOPUP_PAYMENT_DESCRIPTION].every((ch) => ch.charCodeAt(0) < 128),
      true,
    );
    assert.equal(
      [...WATCH_PAYMENT_DESCRIPTION].every((ch) => ch.charCodeAt(0) < 128),
      true,
    );
    assert.equal(
      [...CHECK_PAYMENT_DESCRIPTION].every((ch) => ch.charCodeAt(0) < 128),
      true,
    );
    assert.equal(
      CONFIRM_DESCRIPTION,
      "Livecheck Confirm — independent side-effect verification (actor ≠ verifier). POST /v1/confirm with {url, intent} (+ optional claim). Returns confirmed|failed|unknown; thank-you fluff alone never confirmed — durable ref/id required. Intents: lead_submit $0.10 (lead/contact thank-you), listing_published $0.10 (listing go-live; claim title/sku/id optional) on /v1/confirm; order_placed $0.25 on POST /v1/confirm/order (order confirm/status; claim optional). Signed receipts + GET /stats. Same origin as Livecheck verify ($0.01). Not Trust Oracle / L3.",
    );
    assert.match(CONFIRM_DESCRIPTION, /Livecheck/);
    assert.match(CONFIRM_DESCRIPTION, /listing_published/);
    assert.match(CONFIRM_DESCRIPTION, /order_placed/);
    assert.match(CONFIRM_DESCRIPTION, /\/v1\/confirm\/order/);
    assert.match(OPENAPI_CONFIRM_SUMMARY, /lead_submit \(\$0\.10\)/);
    assert.doesNotMatch(OPENAPI_CONFIRM_SUMMARY, /order_placed/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /POST \/v1\/confirm\/order \(\$0\.25\)/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /listing_published \(\$0\.10\)/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /GET \/v1\/receipt\/\{id\}/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /livecheck-keys\.json/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /missing ≠ false-confirmed rate of 0/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /Trust Oracle \/ L3/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /400 unsupported_intent/);
    assert.match(OPENAPI_CONFIRM_INTENT_DESCRIPTION, /claim\.title\/sku\/id optional/);
    assert.notEqual(OPENAPI_CONFIRM_DESCRIPTION, CONFIRM_DESCRIPTION);
    assert.equal(CONFIRM_SERVICE_NAME, "Livecheck");
    assert.deepEqual([...CONFIRM_RESOURCE_TAGS], ["livecheck", "confirm"]);
  });
});
