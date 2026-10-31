import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setLinkedIn429DelayForTests, verifyUrl } from "../src/verify.js";

const VIEW = "https://www.linkedin.com/jobs/view/4385154626/";
const APPLY = `<!doctype html><html><head><title>Driver</title></head><body><h1>Driver</h1><p>${"Route planning. ".repeat(30)}</p><a href="/apply">Apply now</a></body></html>`;

afterEach(() => setLinkedIn429DelayForTests(null));

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("LinkedIn 429", () => {
  it("retries once and uses the second response", async () => {
    setLinkedIn429DelayForTests(0);
    let calls = 0;
    const fetcher: typeof fetch = async (input) => {
      calls += 1;
      assert.equal(requestUrl(input), VIEW);
      if (calls === 1) return new Response("slow down", { status: 429 });
      return new Response(APPLY, { status: 200, headers: { "content-type": "text/html" } });
    };
    const verdict = await verifyUrl(VIEW, fetcher);
    assert.equal(calls, 2);
    assert.equal(verdict.status, "live");
    assert.equal(verdict.signals.includes("http_429"), false);
  });

  it("returns can't tell when the retry is still 429", async () => {
    setLinkedIn429DelayForTests(0);
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("<html><title>LinkedIn</title><body><a>Apply now</a></body></html>", { status: 429 });
    };
    const verdict = await verifyUrl(VIEW, fetcher);
    assert.equal(calls, 2);
    assert.equal(verdict.status, "unknown");
    assert.equal(verdict.http_status, 429);
    assert.ok(verdict.signals.includes("http_429"));
    assert.equal(verdict.signals.includes("apply form present"), false);
  });

  it("does not retry a 429 from a host that is not LinkedIn", async () => {
    setLinkedIn429DelayForTests(0);
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("slow down", { status: 429 });
    };
    const verdict = await verifyUrl("https://example.com/jobs/1842", fetcher);
    assert.equal(calls, 1);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("http_429"));
  });
});
