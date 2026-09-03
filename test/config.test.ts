import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PORT, PRICE_ATOMIC_USDC, PRICE_USD, VERIFY_DESCRIPTION, port } from "../src/config.js";

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
      "Before you scrape a job, product, or eBay item page, POST the specific URL you already have and Livecheck returns live, closed, or unknown plus title and signals (apply form, in-stock, sold-out, 404); not a search engine.",
    );
  });
});
