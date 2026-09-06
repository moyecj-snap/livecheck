import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_PRICE_ATOMIC_USDC,
  CONFIRM_PRICE_USD,
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
      "Before you scrape a job or product page, POST the URL. Livecheck fetches the source and returns live, closed, or unknown plus title and signals (apply form, sold-out, 404). Not a search engine.",
    );
  });

  it("pins $0.10 Confirm copy that includes Livecheck for CDP search", () => {
    assert.equal(CONFIRM_PRICE_USD, 0.1);
    assert.equal(CONFIRM_PRICE_ATOMIC_USDC, "100000");
    assert.match(CONFIRM_DESCRIPTION, /Livecheck/);
    assert.equal(
      CONFIRM_DESCRIPTION,
      "Livecheck Confirm — use after your agent submits a lead/contact form (intent=lead_submit): POST {url, intent} where url is the thank-you or result page. Returns confirmed|failed|unknown with Level-2+ evidence (confirmation/ref/ticket id required for confirmed). Independent cookieless verifier — actor ≠ verifier — so you do not grade your own homework before the next paid or irreversible step. Not URL/stock liveness (use /v1/verify), not payment/tx settlement, not a thank-you-page classifier.",
    );
  });
});
