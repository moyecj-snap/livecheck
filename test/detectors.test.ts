import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { CheckError, parseCheckRequest } from "../src/check.js";
import { compileAndApplyIgnore } from "../src/ignore-defaults.js";
import { compareNumeric, parseLooseNumber, pickAmount, queryJsonPath } from "../src/numeric.js";
import { textChangeRatio, textDiffFired, textDiffHash, TEXT_DIFF_NO_SELECTOR_MAX_CONFIDENCE } from "../src/text-diff.js";

describe("ignore-by-default", () => {
  it("strips timestamps, counters, session/CSRF, ads, and cookie banners before hashing", () => {
    const raw = [
      "Ridge Wallet",
      "Posted 2 hours ago",
      "2026-09-10T18:00:00Z",
      "23 watching",
      "1,204 sold",
      "session_id=abc123def",
      "csrf_token=deadbeef",
      "We use cookies to improve your experience. Accept all cookies",
      "google_ads_slot_99",
      "Aluminum wallet.",
    ].join(" ");
    const cleaned = compileAndApplyIgnore(raw);
    assert.match(cleaned, /Ridge Wallet/);
    assert.match(cleaned, /Aluminum wallet/);
    assert.doesNotMatch(cleaned, /watching/);
    assert.doesNotMatch(cleaned, /sold/);
    assert.doesNotMatch(cleaned, /2026-09-10T18:00:00Z/);
    assert.doesNotMatch(cleaned, /session_id/);
    assert.doesNotMatch(cleaned, /csrf_token/);
    assert.doesNotMatch(cleaned, /Accept all cookies/i);
    const noisy = compileAndApplyIgnore(`${raw} 88 watching Posted 1 minute ago`);
    assert.equal(textDiffHash(cleaned), textDiffHash(noisy));
  });
});

describe("text_diff helpers", () => {
  it("defaults min_change_ratio to 0.02 and uses baseline text when present", () => {
    const previous = "Aluminum wallet. Ships today.";
    const tiny = "Aluminum wallet. Ships tonight.";
    const rewritten = "Titanium wallet. Limited drop. Completely rewritten product story for collectors.";
    assert.ok(textChangeRatio(previous, tiny) < 0.5);
    assert.equal(
      textDiffFired({
        currentNormalized: tiny,
        currentHash: textDiffHash(tiny),
        baselineHash: textDiffHash(previous),
        baselineText: previous,
        minChangeRatio: 0.8,
      }),
      false,
    );
    assert.equal(
      textDiffFired({
        currentNormalized: rewritten,
        currentHash: textDiffHash(rewritten),
        baselineHash: textDiffHash(previous),
        baselineText: previous,
        minChangeRatio: 0.02,
      }),
      true,
    );
    assert.equal(
      textDiffFired({
        currentNormalized: rewritten,
        currentHash: textDiffHash(rewritten),
        baselineHash: textDiffHash(previous),
        baselineText: null,
        minChangeRatio: 0.02,
      }),
      true,
    );
    assert.equal(
      textDiffFired({
        currentNormalized: previous,
        currentHash: textDiffHash(previous),
        baselineHash: null,
        baselineText: null,
        minChangeRatio: 0.02,
      }),
      null,
    );
  });

  it("parses text_diff params and caps confidence language without selector", () => {
    const parsed = parseCheckRequest({
      target: { type: "url", url: "https://example.com/p", render: "never" },
      condition: { detector: "text_diff", params: { ignore: ["sku-\\d+"] } },
    });
    assert.equal(parsed.condition.detector, "text_diff");
    if (parsed.condition.detector !== "text_diff") throw new Error("expected text_diff");
    assert.equal(parsed.condition.params.selector, null);
    assert.equal(parsed.condition.params.min_change_ratio, 0.02);
    assert.deepEqual(parsed.condition.params.ignore, ["sku-\\d+"]);
    assert.ok(TEXT_DIFF_NO_SELECTOR_MAX_CONFIDENCE <= 0.6);
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com/p" },
          condition: { detector: "text_diff", params: { ignore: ["("] } },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_condition",
    );
  });
});

describe("numeric_threshold helpers", () => {
  it("parses $1,299.00, 1 299,00 euro, and 149", () => {
    assert.equal(parseLooseNumber("$1,299.00"), 1299);
    assert.equal(pickAmount("$1,299.00", "USD"), 1299);
    assert.equal(pickAmount("1 299,00 €", "EUR"), 1299);
    assert.equal(parseLooseNumber("149"), 149);
    assert.equal(parseLooseNumber("1,500"), 1500);
    assert.equal(pickAmount("Sale $1,299.00", "USD"), 1299);
  });

  it("compares ops including change_pct", () => {
    assert.equal(compareNumeric("lt", 999, 1000, null), true);
    assert.equal(compareNumeric("lte", 1000, 1000, null), true);
    assert.equal(compareNumeric("gt", 1001, 1000, null), true);
    assert.equal(compareNumeric("gte", 1000, 1000, null), true);
    assert.equal(compareNumeric("eq", 149, 149, null), true);
    assert.equal(compareNumeric("change_pct", 120, 10, 100), true);
    assert.equal(compareNumeric("change_pct", 105, 10, 100), false);
    assert.equal(compareNumeric("change_pct", 50, 10, null), false);
  });

  it("reads jsonpath and requires selector or jsonpath", () => {
    assert.equal(queryJsonPath({ offers: { price: 149 } }, "$.offers.price"), 149);
    const parsed = parseCheckRequest({
      target: { type: "url", url: "https://example.com/p" },
      condition: { detector: "numeric_threshold", params: { jsonpath: "$.offers.price", op: "lt", value: 200 } },
    });
    assert.equal(parsed.condition.detector, "numeric_threshold");
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com/p" },
          condition: { detector: "numeric_threshold", params: { op: "lt", value: 200 } },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_condition",
    );
    assert.throws(
      () =>
        parseCheckRequest({
          target: { type: "url", url: "https://example.com/p" },
          condition: { detector: "numeric_threshold", params: { selector: ".price", op: "nope", value: 1 } },
        }),
      (error: unknown) => error instanceof CheckError && error.code === "invalid_condition",
    );
  });
});

describe("POST /v1/check text_diff and numeric_threshold", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => close());

  it("text_diff with selector hashes after ignore-by-default; no selector caps confidence", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const first = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "text_diff", params: { selector: "h1" } },
      }),
    });
    assert.equal(first.status, 200);
    const firstBody = (await first.json()) as {
      observation: { hash: string };
      fired: boolean | null;
      confidence: number;
      content?: string;
    };
    assert.equal(firstBody.fired, null);
    assert.ok(firstBody.confidence > 0.6);
    assert.equal(firstBody.content, undefined);

    const stampBaseline = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "text_diff", params: { selector: ".stamp" } },
      }),
    });
    const stampHash = ((await stampBaseline.json()) as { observation: { hash: string } }).observation.hash;
    const stampAgain = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd-changed`, render: "never" },
        condition: { detector: "text_diff", params: { selector: ".stamp" } },
        baseline_hash: stampHash,
      }),
    });
    assert.equal(((await stampAgain.json()) as { fired: boolean | null }).fired, false);

    const changed = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd-changed`, render: "never" },
        condition: { detector: "text_diff", params: { selector: "h1" } },
        baseline_hash: firstBody.observation.hash,
      }),
    });
    assert.equal(((await changed.json()) as { fired: boolean }).fired, true);

    const full = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "text_diff", params: {} },
      }),
    });
    const fullBody = (await full.json()) as { confidence: number };
    assert.ok(fullBody.confidence <= 0.6);
  });

  it("numeric_threshold parses money and jsonpath", async () => {
    const headers = { "content-type": "application/json", "x-livecheck-mock": "1" };
    const usd = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-usd`, render: "never" },
        condition: { detector: "numeric_threshold", params: { selector: ".price", op: "eq", value: 1299 } },
      }),
    });
    assert.equal(usd.status, 200);
    assert.equal(((await usd.json()) as { fired: boolean }).fired, true);

    const eur = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-eur`, render: "never" },
        condition: {
          detector: "numeric_threshold",
          params: { selector: ".price", op: "lte", value: 1299, currency: "EUR" },
        },
      }),
    });
    assert.equal(((await eur.json()) as { fired: boolean }).fired, true);

    const bare = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-149`, render: "never" },
        condition: { detector: "numeric_threshold", params: { selector: ".price", op: "lt", value: 200 } },
      }),
    });
    assert.equal(((await bare.json()) as { fired: boolean }).fired, true);

    const json = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price.json`, render: "never" },
        condition: { detector: "numeric_threshold", params: { jsonpath: "$.offers.price", op: "eq", value: 149 } },
      }),
    });
    assert.equal(json.status, 200);
    assert.equal(((await json.json()) as { fired: boolean }).fired, true);

    const pct = await fetch(`${origin}/v1/check`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        target: { type: "url", url: `${origin}/fixtures/products/price-149`, render: "never" },
        condition: {
          detector: "numeric_threshold",
          params: { selector: ".price", op: "change_pct", value: 10, baseline_value: 100 },
        },
      }),
    });
    assert.equal(((await pct.json()) as { fired: boolean }).fired, true);
  });
});
