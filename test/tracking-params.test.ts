import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { stripTrackingParams } from "../src/tracking-params.js";
import { verifyUrl } from "../src/verify.js";

describe("stripTrackingParams", () => {
  it("drops only utm_* and ref and keeps id params", () => {
    assert.equal(
      stripTrackingParams("https://boards.greenhouse.io/acme/jobs/1?gh_jid=123&utm_source=x&ref=y"),
      "https://boards.greenhouse.io/acme/jobs/1?gh_jid=123",
    );
    const kept = new URL(
      stripTrackingParams(
        "https://jobs.example/jobs/9?jobId=42&lever-source=board&utm_medium=email&UTM_campaign=fall&ref=audit&referral=keep&fbclid=abc",
      ),
    );
    assert.equal(kept.searchParams.get("jobId"), "42");
    assert.equal(kept.searchParams.get("lever-source"), "board");
    assert.equal(kept.searchParams.get("referral"), "keep");
    assert.equal(kept.searchParams.get("fbclid"), "abc");
    assert.equal(kept.searchParams.get("utm_medium"), null);
    assert.equal(kept.searchParams.get("UTM_campaign"), null);
    assert.equal(kept.searchParams.get("ref"), null);
    assert.equal(stripTrackingParams("not a url"), "not a url");
    assert.equal(
      stripTrackingParams("https://example.com/thank-you?ref=ABC123"),
      "https://example.com/thank-you",
    );
  });

  it("fetches the stripped URL and leaves gh_jid in place", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push(url);
      return new Response("<html><title>Engineer</title><body><a href=\"/apply\">Apply now</a><p>The team is hiring this week.</p></body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    };
    const verdict = await verifyUrl(
      "https://example.com/jobs/1842?gh_jid=123&utm_source=x&ref=y&jobId=9",
      fetcher,
    );
    assert.equal(verdict.url, "https://example.com/jobs/1842?gh_jid=123&jobId=9");
    assert.ok(seen.some((url) => url.startsWith("https://example.com/jobs/1842?")));
    assert.equal(seen.some((url) => url.includes("utm_source=") || /[?&]ref=/.test(url)), false);
    assert.ok(seen.some((url) => url.includes("gh_jid=123") && url.includes("jobId=9")));
  });
});
