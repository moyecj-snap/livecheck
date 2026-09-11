import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { verifySentinelSignature } from "../examples/sentinel-webhook.js";

describe("sentinel webhook sample", () => {
  it("accepts a fresh HMAC and rejects a bad or stale signature", () => {
    const secret = "whsec_example";
    const rawBody = JSON.stringify({ id: "evt_01TEST", type: "change" });
    const t = 1_778_000_000;
    const v1 = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
    assert.equal(verifySentinelSignature(secret, rawBody, `t=${t},v1=${v1}`, t), true);
    assert.equal(verifySentinelSignature(secret, rawBody, `t=${t},v1=${"ab".repeat(32)}`, t), false);
    assert.equal(verifySentinelSignature(secret, rawBody, `t=${t},v1=${v1}`, t + 601), false);
  });
});
