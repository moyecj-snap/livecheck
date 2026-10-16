import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { validateDiscoveryExtension } from "@x402/extensions/bazaar";
import {
  VERIFY_EXAMPLE,
  VERIFY_LISTING_EXAMPLE,
  VERIFY_LISTING_EXAMPLE_URL,
  verifyBazaarExtensions,
  verifyJobBazaarExtensions,
  verifyListingBazaarExtensions,
} from "../src/bazaar.js";
import { advertisedResourceInfo, fillCatalogPaymentPayload } from "../src/catalog-payload.js";
import {
  LIVECHECK_SERVICE_NAME,
  VERIFY_DESCRIPTION,
  VERIFY_JOB_PAYMENT_DESCRIPTION,
  VERIFY_LISTING_PAYMENT_DESCRIPTION,
  VERIFY_RESOURCE_TAGS,
} from "../src/config.js";
import { verifyPaymentRoutes } from "../src/payments.js";
import {
  advertisePaymentRequired,
  paymentRequiredBody,
  verifyJobPaymentRequiredBody,
  verifyListingPaymentRequiredBody,
} from "../src/x402-payload.js";
import type { BazaarExt } from "./bazaar-schema.js";

const PAY_TO = "0x2222222222222222222222222222222222222222";
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function body(ext: Record<string, unknown>): { url?: string } {
  return ((ext.bazaar as BazaarExt).info?.input?.body ?? {}) as { url?: string };
}
function example(ext: Record<string, unknown>): Record<string, unknown> {
  return (ext.bazaar as { info: { output: { example: Record<string, unknown> } } }).info.output.example;
}

describe("bazaar enrichment metadata", () => {
  it("verify/listing advertises a real product page, not a job URL", () => {
    const ext = verifyListingBazaarExtensions();
    assert.equal(body(ext).url, VERIFY_LISTING_EXAMPLE_URL);
    assert.doesNotMatch(VERIFY_LISTING_EXAMPLE_URL, /greenhouse|lever|ashby|workday|jobs?\//i);
    assert.match(VERIFY_LISTING_EXAMPLE_URL, /^https:\/\/[^/]+\/products\/[a-z0-9-]+$/);
    const ex = example(ext);
    assert.equal(ex.status, "live");
    assert.equal(ex.route, "verify/listing");
    assert.deepEqual(ex.signals, ["in-stock"]);
    assert.equal(ex.url, VERIFY_LISTING_EXAMPLE.url);
  });

  it("verify/job keeps a job example and labels its route", () => {
    const ext = verifyJobBazaarExtensions();
    assert.equal(body(ext).url, VERIFY_EXAMPLE.url);
    assert.equal(example(ext).route, "verify/job");
    assert.equal(example(verifyBazaarExtensions()).route, "verify");
  });

  it("all three verify declarations pass the bazaar validator with POST JSON", () => {
    for (const ext of [verifyBazaarExtensions(), verifyJobBazaarExtensions(), verifyListingBazaarExtensions()]) {
      const bazaar = ext.bazaar as BazaarExt;
      assert.equal(bazaar.info?.input?.method, "POST");
      assert.equal(bazaar.info?.input?.bodyType, "json");
      const result = validateDiscoveryExtension(bazaar as never);
      assert.equal(result.valid, true, JSON.stringify(result.errors));
    }
  });

  it("per-route descriptions are ASCII, under CDP's 500-character cap, and make no absolute claims", () => {
    for (const d of [VERIFY_DESCRIPTION, VERIFY_JOB_PAYMENT_DESCRIPTION, VERIFY_LISTING_PAYMENT_DESCRIPTION]) {
      assert.ok(d.length <= 500, `${d.length} chars`);
      assert.match(d, PRINTABLE_ASCII);
      assert.doesNotMatch(d, /never wrong|100%|guarantee/i);
    }
    assert.notEqual(VERIFY_JOB_PAYMENT_DESCRIPTION, VERIFY_LISTING_PAYMENT_DESCRIPTION);
  });

  it("serviceName and tags follow the bazaar validation rules", () => {
    assert.ok(LIVECHECK_SERVICE_NAME.length <= 32 && PRINTABLE_ASCII.test(LIVECHECK_SERVICE_NAME));
    assert.ok(VERIFY_RESOURCE_TAGS.length <= 5);
    for (const t of VERIFY_RESOURCE_TAGS) assert.ok(t.length <= 32 && PRINTABLE_ASCII.test(t), t);
  });

  it("live route config carries per-route description, bazaar, serviceName and tags; price unchanged", () => {
    const routes = verifyPaymentRoutes(PAY_TO) as unknown as Record<string, Record<string, unknown>>;
    const cases = [
      ["POST /v1/verify", VERIFY_DESCRIPTION, VERIFY_EXAMPLE.url],
      ["POST /v1/verify/job", VERIFY_JOB_PAYMENT_DESCRIPTION, VERIFY_EXAMPLE.url],
      ["POST /v1/verify/listing", VERIFY_LISTING_PAYMENT_DESCRIPTION, VERIFY_LISTING_EXAMPLE_URL],
    ] as const;
    const accepts = routes["POST /v1/verify"]!.accepts;
    for (const [key, desc, url] of cases) {
      const r = routes[key]!;
      assert.equal(r.description, desc, key);
      assert.equal(r.serviceName, LIVECHECK_SERVICE_NAME);
      assert.deepEqual(r.tags, [...VERIFY_RESOURCE_TAGS]);
      assert.equal(body(r.extensions as Record<string, unknown>).url, url, key);
      assert.deepEqual(r.accepts, accepts, `${key} accept must match /v1/verify`);
    }
    // Confirm routes untouched by this change.
    assert.equal(routes["POST /v1/confirm/order"]!.serviceName, undefined);
  });

  it("advertised 402 and catalog backfill use the listing example on /v1/verify/listing", () => {
    const url = "https://livecheck.fly.dev/v1/verify/listing";
    const adv = advertisePaymentRequired({ x402Version: 2, accepts: [] }, url) as {
      resource: Record<string, unknown>;
      extensions: Record<string, unknown>;
    };
    assert.equal(adv.resource.description, VERIFY_LISTING_PAYMENT_DESCRIPTION);
    assert.equal(adv.resource.serviceName, LIVECHECK_SERVICE_NAME);
    assert.equal(body(adv.extensions).url, VERIFY_LISTING_EXAMPLE_URL);

    const info = advertisedResourceInfo("verify_listing");
    assert.equal(info.description, VERIFY_LISTING_PAYMENT_DESCRIPTION);
    const filled = fillCatalogPaymentPayload({ x402Version: 2, resource: { url }, accepted: {}, payload: {} });
    assert.equal(body(filled.payload.extensions as Record<string, unknown>).url, VERIFY_LISTING_EXAMPLE_URL);
  });

  it("mock-mode 402 bodies are per route with the same $0.01 accept", () => {
    const base = paymentRequiredBody("https://livecheck.fly.dev/v1/verify");
    const job = verifyJobPaymentRequiredBody("https://livecheck.fly.dev/v1/verify/job");
    const listing = verifyListingPaymentRequiredBody("https://livecheck.fly.dev/v1/verify/listing");
    assert.equal(base.resource.description, VERIFY_DESCRIPTION);
    assert.equal(job.resource.description, VERIFY_JOB_PAYMENT_DESCRIPTION);
    assert.equal(listing.resource.description, VERIFY_LISTING_PAYMENT_DESCRIPTION);
    assert.equal(body(listing.extensions).url, VERIFY_LISTING_EXAMPLE_URL);
    assert.deepEqual(job.accepts, base.accepts);
    assert.deepEqual(listing.accepts, base.accepts);
  });
});
