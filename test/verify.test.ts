import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import { verifyUrl } from "../src/verify.js";

describe("verifyUrl against local fixtures", () => {
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

  it("follows the closed Greenhouse redirect and reports closed", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/jobs/9901`);
    assert.equal(verdict.status, "closed");
    assert.match(verdict.canonical_url, /\/fixtures\/careers$/);
    assert.ok(
      verdict.signals.includes("redirected_to_board") ||
        verdict.signals.some((s) => s.includes("no longer available")),
    );
  });

  it("classifies TWO closed-to-new-applications fixtures as closed", async () => {
    const a = await verifyUrl(`${origin}/fixtures/closed-to-new-applications`);
    const b = await verifyUrl(`${origin}/fixtures/closed-to-new-applications-lever`);
    assert.equal(a.status, "closed");
    assert.equal(b.status, "closed");
  });

  it("classifies 200 + Apply Now as live", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/live-apply-now`);
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes("apply form present"));
  });

  it("classifies a 404 fixture as closed", async () => {
    const verdict = await verifyUrl(`${origin}/fixtures/gone-404`);
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.http_status, 404);
  });
});
