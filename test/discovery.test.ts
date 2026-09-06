import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import { createApp } from "../src/app.js";
import {
  CONFIRM_DESCRIPTION,
  CONFIRM_SUMMARY,
  CONFIRM_TAGS,
  VERIFY_DESCRIPTION,
} from "../src/config.js";
import { openApiDocument } from "../src/discovery.js";

describe("OpenAPI Confirm discovery copy", () => {
  it("uses CONFIRM_DESCRIPTION as description and x-guidance", () => {
    const spec = openApiDocument("https://livecheck.fly.dev/openapi.json", "livecheck.fly.dev") as {
      info: { description: string };
      paths: {
        "/v1/confirm": {
          post: {
            summary: string;
            description: string;
            tags: string[];
            "x-guidance": string;
          };
        };
      };
    };
    const confirm = spec.paths["/v1/confirm"].post;
    assert.equal(confirm.summary, CONFIRM_SUMMARY);
    assert.equal(
      confirm.summary,
      "Confirm lead_submit side effects independently before your next step",
    );
    assert.equal(confirm.description, CONFIRM_DESCRIPTION);
    assert.equal(confirm["x-guidance"], CONFIRM_DESCRIPTION);
    assert.deepEqual(confirm.tags, [...CONFIRM_TAGS]);
    assert.deepEqual(confirm.tags, ["Confirm", "lead_submit", "side-effect"]);
    assert.match(CONFIRM_DESCRIPTION, /Livecheck/);
    assert.match(spec.info.description, /Also POST \/v1\/confirm/);
    assert.match(spec.info.description, new RegExp(VERIFY_DESCRIPTION.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });
});

describe("GET /openapi.json and /.well-known/x402", () => {
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

  it("serves Confirm summary, tags, and x-guidance from CONFIRM_DESCRIPTION", async () => {
    const res = await fetch(`${origin}/openapi.json`);
    assert.equal(res.status, 200);
    const spec = (await res.json()) as {
      paths: {
        "/v1/confirm": {
          post: { summary: string; description: string; tags: string[]; "x-guidance": string };
        };
        "/v1/verify": { post: { description: string } };
      };
    };
    const confirm = spec.paths["/v1/confirm"].post;
    assert.equal(confirm.summary, CONFIRM_SUMMARY);
    assert.equal(confirm.description, CONFIRM_DESCRIPTION);
    assert.equal(confirm["x-guidance"], CONFIRM_DESCRIPTION);
    assert.deepEqual(confirm.tags, ["Confirm", "lead_submit", "side-effect"]);
    assert.equal(spec.paths["/v1/verify"].post.description, VERIFY_DESCRIPTION);
  });

  it("lists Confirm in well-known x402 with CONFIRM_DESCRIPTION", async () => {
    const res = await fetch(`${origin}/.well-known/x402`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      version: number;
      resources: Array<{ url: string; description: string }>;
    };
    assert.equal(body.version, 2);
    const confirm = body.resources.find((r) => r.url.endsWith("/v1/confirm"));
    const verify = body.resources.find((r) => r.url.endsWith("/v1/verify"));
    assert.equal(confirm?.description, CONFIRM_DESCRIPTION);
    assert.equal(verify?.description, VERIFY_DESCRIPTION);
  });
});
