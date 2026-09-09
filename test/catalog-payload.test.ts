import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FacilitatorClient } from "@x402/core/server";
import { VERIFY_DESCRIPTION } from "../src/config.js";
import {
  decodeExtensionResponsesHeader,
  fillCatalogPaymentPayload,
  paymentPayloadHasBazaar,
  paymentPayloadResourceUrl,
  summarizeCatalogPayload,
} from "../src/catalog-payload.js";
import { wrapFacilitatorForCatalog } from "../src/facilitator-catalog.js";
import { NETWORK } from "../src/config.js";
import { assertInfoInputMatchesSchema, type BazaarExt } from "./bazaar-schema.js";

const advertised = "https://livecheck.fly.dev/v1/verify";

describe("fillCatalogPaymentPayload", () => {
  it("backfills missing resource and bazaar onto the settle envelope", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const inbound = { x402Version: 2, payload: { authorization: "omit-from-logs" } };
      const { payload, resourceFilled, bazaarFilled } = fillCatalogPaymentPayload(inbound);
      assert.equal(resourceFilled, true);
      assert.equal(bazaarFilled, true);
      assert.equal(paymentPayloadResourceUrl(payload), advertised);
      assert.equal((payload.resource as { description?: string }).description, VERIFY_DESCRIPTION);
      assert.ok(paymentPayloadHasBazaar(payload));
      assertInfoInputMatchesSchema(payload.extensions?.bazaar as BazaarExt, "settle-filled bazaar");
      const summary = summarizeCatalogPayload(inbound);
      assert.equal(summary.resource_present, false);
      assert.equal(summary.bazaar_echo, false);
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("upgrades http://livecheck.fly.dev resource to https advertised URL", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const { payload, resourceFilled } = fillCatalogPaymentPayload({
        resource: { url: "http://livecheck.fly.dev/v1/verify", description: "old" },
        extensions: { bazaar: { info: {} } },
      });
      assert.equal(resourceFilled, true);
      assert.equal(paymentPayloadResourceUrl(payload), advertised);
      assert.equal((payload.resource as { description?: string }).description, VERIFY_DESCRIPTION);
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("does not overwrite a confirm/order resource with the confirm URL", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const { payload, resourceFilled } = fillCatalogPaymentPayload({
        resource: { url: "http://livecheck.fly.dev/v1/confirm/order", description: "old" },
      });
      assert.equal(resourceFilled, true);
      assert.equal(paymentPayloadResourceUrl(payload), "https://livecheck.fly.dev/v1/confirm/order");
      assert.notEqual(paymentPayloadResourceUrl(payload), "https://livecheck.fly.dev/v1/confirm");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("does not overwrite a confirm resource with the verify URL", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const { payload, resourceFilled } = fillCatalogPaymentPayload({
        resource: { url: "http://livecheck.fly.dev/v1/confirm", description: "old" },
      });
      assert.equal(resourceFilled, true);
      assert.equal(paymentPayloadResourceUrl(payload), "https://livecheck.fly.dev/v1/confirm");
      assert.notEqual(paymentPayloadResourceUrl(payload), advertised);
      const resource = payload.resource as {
        description?: string;
        serviceName?: string;
        tags?: string[];
      };
      assert.match(resource.description ?? "", /Livecheck Confirm/);
      assert.equal(resource.serviceName, "Livecheck");
      assert.deepEqual(resource.tags, ["livecheck", "confirm"]);
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });

  it("leaves a matching https resource and existing bazaar echo in place", () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    try {
      const bazaar = { info: { input: { bodyType: "json" } } };
      const { payload, resourceFilled, bazaarFilled } = fillCatalogPaymentPayload({
        resource: { url: advertised, description: VERIFY_DESCRIPTION, mimeType: "application/json" },
        extensions: { bazaar },
      });
      assert.equal(resourceFilled, false);
      assert.equal(bazaarFilled, false);
      assert.equal(payload.extensions?.bazaar, bazaar);
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });
});

describe("decodeExtensionResponsesHeader", () => {
  it("labels an empty object as empty {}, not rejected", () => {
    const encoded = Buffer.from("{}", "utf8").toString("base64");
    const log = decodeExtensionResponsesHeader(encoded, ["EXTENSION-RESPONSES"]);
    assert.equal(log.present, true);
    assert.equal(log.empty, true);
    assert.equal(log.bazaar_status, null);
    assert.deepEqual(log.keys, []);
  });

  it("reads bazaar.status and rejectedReason", () => {
    const encoded = Buffer.from(
      JSON.stringify({ bazaar: { status: "rejected", rejectedReason: "missing resource" } }),
      "utf8",
    ).toString("base64");
    const log = decodeExtensionResponsesHeader(encoded);
    assert.equal(log.empty, false);
    assert.equal(log.bazaar_status, "rejected");
    assert.equal(log.rejected_reason, "missing resource");
  });

  it("treats a missing header as absent", () => {
    const log = decodeExtensionResponsesHeader(null);
    assert.equal(log.present, false);
    assert.equal(log.empty, true);
  });
});

describe("wrapFacilitatorForCatalog", () => {
  it("sends filled resource + bazaar to inner settle without touching the signed payload blob", async () => {
    const previous = process.env.LIVECHECK_PUBLIC_URL;
    process.env.LIVECHECK_PUBLIC_URL = "https://livecheck.fly.dev";
    const seen: unknown[] = [];
    const inner = {
      async getSupported() {
        return { kinds: [], extensions: [], signers: {} };
      },
      async verify(payload) {
        seen.push(payload);
        return { isValid: true };
      },
      async settle(payload) {
        seen.push(payload);
        return { success: true, transaction: "0xabc", network: NETWORK };
      },
    } satisfies FacilitatorClient;
    try {
      const wrapped = wrapFacilitatorForCatalog(inner);
      const inbound = {
        x402Version: 2,
        accepted: {
          scheme: "exact",
          network: NETWORK,
          asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          amount: "10000",
          payTo: "0x2222222222222222222222222222222222222222",
          maxTimeoutSeconds: 60,
          extra: {},
        },
        payload: { signature: "do-not-log" },
      };
      const requirements = inbound.accepted;
      await wrapped.settle(inbound as Parameters<FacilitatorClient["settle"]>[0], requirements as Parameters<FacilitatorClient["settle"]>[1]);
      const sent = seen[0] as {
        resource?: { url?: string };
        extensions?: { bazaar?: unknown };
        payload?: { signature?: string };
      };
      assert.equal(sent.resource?.url, advertised);
      assert.ok(sent.extensions?.bazaar);
      assert.equal(sent.payload?.signature, "do-not-log");
    } finally {
      if (previous === undefined) delete process.env.LIVECHECK_PUBLIC_URL;
      else process.env.LIVECHECK_PUBLIC_URL = previous;
    }
  });
});
