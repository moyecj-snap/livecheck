import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PAYMENT_DESCRIPTION,
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
  WATCH_RENEW_PAYMENT_DESCRIPTION,
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
      "Live status checks for AI agents. Is this product still available or sold out (Shopify, eBay)? Is this job posting still open (Greenhouse, Lever, Ashby, Workday)? Real-time answer with evidence. $0.01 per check via x402 or Stripe MPP.",
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
    assert.ok(WATCH_PAYMENT_DESCRIPTION.length >= 200);
    assert.ok(
      WATCH_PAYMENT_DESCRIPTION.length <= 300,
      `watch 402 description must stay in the verify band, got ${WATCH_PAYMENT_DESCRIPTION.length}`,
    );
    assert.match(WATCH_PAYMENT_DESCRIPTION, /\$2\.50/);
    assert.match(WATCH_PAYMENT_DESCRIPTION, /2500000/);
    assert.equal(
      [...WATCH_RENEW_PAYMENT_DESCRIPTION].every((ch) => ch.charCodeAt(0) < 128),
      true,
    );
    assert.equal(WATCH_RENEW_PAYMENT_DESCRIPTION.includes("$2.50"), true);
    assert.equal(
      [...CHECK_PAYMENT_DESCRIPTION].every((ch) => ch.charCodeAt(0) < 128),
      true,
    );
    assert.equal(
      CONFIRM_DESCRIPTION,
      "Livecheck Confirm checks whether an agent's action took effect, such as a contact form submitted or a listing published, using evidence gathered outside the agent's session. Returns confirmed, failed or unknown. $0.10 per check via x402. Intents: lead_submit, listing_published. order_placed is POST /v1/confirm/order ($0.25).",
    );
    assert.match(CONFIRM_DESCRIPTION, /^Livecheck Confirm /);
    assert.match(CONFIRM_DESCRIPTION, /confirmed, failed or unknown/);
    assert.equal(CONFIRM_DESCRIPTION.startsWith(CONFIRM_PAYMENT_DESCRIPTION), true);
    assert.ok(CONFIRM_PAYMENT_DESCRIPTION.length <= 240);
    assert.match(CONFIRM_PAYMENT_DESCRIPTION, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(CONFIRM_PAYMENT_DESCRIPTION, /MPP/);
    assert.match(CONFIRM_DESCRIPTION, /listing_published/);
    assert.match(CONFIRM_DESCRIPTION, /order_placed/);
    assert.match(CONFIRM_DESCRIPTION, /\/v1\/confirm\/order/);
    assert.match(OPENAPI_CONFIRM_SUMMARY, /lead_submit \(\$0\.10\)/);
    assert.doesNotMatch(OPENAPI_CONFIRM_SUMMARY, /order_placed/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /POST \/v1\/confirm\/order \(\$0\.25\)/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /listing_published \(\$0\.10\)/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /GET \/v1\/receipt\/\{id\}/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /livecheck-keys\.json/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /missing ≠ live FC of 0/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /false_confirmed_rate/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /Trust Oracle \/ L3/);
    assert.match(OPENAPI_CONFIRM_DESCRIPTION, /400 unsupported_intent/);
    assert.match(OPENAPI_CONFIRM_INTENT_DESCRIPTION, /claim\.title\/sku\/id optional/);
    assert.notEqual(OPENAPI_CONFIRM_DESCRIPTION, CONFIRM_DESCRIPTION);
    assert.equal(CONFIRM_SERVICE_NAME, "Livecheck");
    assert.deepEqual([...CONFIRM_RESOURCE_TAGS], ["livecheck", "confirm"]);
  });
});
