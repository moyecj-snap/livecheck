import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import { NOHUMANS_CLAIM_PATH, NOHUMANS_CLAIM_TOKEN_ENV, nohumansClaimToken } from "../src/nohumans-claim.js";

const SAMPLE = "nh_claim_0123456789abcdef";

describe("GET /.well-known/nohumans-claim", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[NOHUMANS_CLAIM_TOKEN_ENV];
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[NOHUMANS_CLAIM_TOKEN_ENV];
    else process.env[NOHUMANS_CLAIM_TOKEN_ENV] = previous;
  });

  it("serves exactly the token as text/plain when the secret is set", async () => {
    process.env[NOHUMANS_CLAIM_TOKEN_ENV] = SAMPLE;
    const res = await createApp().request(NOHUMANS_CLAIM_PATH);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /^text\/plain/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(await res.text(), SAMPLE);
  });

  it("drops surrounding whitespace so the body is exactly the token", async () => {
    process.env[NOHUMANS_CLAIM_TOKEN_ENV] = `  ${SAMPLE}\n`;
    const res = await createApp().request(NOHUMANS_CLAIM_PATH);
    assert.equal(await res.text(), SAMPLE);
  });

  it("is 404 when the secret is unset", async () => {
    delete process.env[NOHUMANS_CLAIM_TOKEN_ENV];
    const res = await createApp().request(NOHUMANS_CLAIM_PATH);
    assert.equal(res.status, 404);
    assert.doesNotMatch(await res.text(), /nh_claim/);
  });

  it("is 404 when the secret is empty or blank", async () => {
    for (const value of ["", "   ", "\n"]) {
      process.env[NOHUMANS_CLAIM_TOKEN_ENV] = value;
      const res = await createApp().request(NOHUMANS_CLAIM_PATH);
      assert.equal(res.status, 404, JSON.stringify(value));
    }
    assert.equal(nohumansClaimToken({}), null);
  });

  it("is free (never 402) and never writes the token to the console", async () => {
    process.env[NOHUMANS_CLAIM_TOKEN_ENV] = SAMPLE;
    const seen: string[] = [];
    const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
    for (const k of Object.keys(originals) as Array<keyof typeof originals>) {
      console[k] = (...args: unknown[]) => void seen.push(args.map(String).join(" "));
    }
    try {
      const res = await createApp().request(NOHUMANS_CLAIM_PATH);
      assert.equal(res.status, 200);
      await res.text();
    } finally {
      Object.assign(console, originals);
    }
    assert.equal(seen.some((line) => line.includes(SAMPLE)), false);
  });

  it("does not answer POST and leaves paid routes untouched", async () => {
    process.env[NOHUMANS_CLAIM_TOKEN_ENV] = SAMPLE;
    const app = createApp();
    const post = await app.request(NOHUMANS_CLAIM_PATH, { method: "POST" });
    assert.notEqual(post.status, 200);
    const verify = await app.request("/v1/verify", { method: "POST" });
    assert.equal(verify.headers.get("x-nohumans-claim"), null);
  });
});
