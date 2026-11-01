import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import { ATS_API_LISTED, ATS_API_MISSING } from "../src/ats-api.js";
import { roleRefFor } from "../src/free-job-role.js";
import { verifyUrl } from "../src/verify.js";

const FIGMA = "https://www.figma.com/careers?gh_jid=6223155004";
const API = "https://boards-api.greenhouse.io/v1/boards/figma/jobs/6223155004";
const SHELL = `<!doctype html><html><head><title>Careers at Figma</title></head><body><div id="root"></div><p>You need to enable JavaScript to run this app.</p></body></html>`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe("Figma-style Greenhouse gh_jid embeds", () => {
  it("resolves the board token and job id from the company host", () => {
    const ref = roleRefFor(FIGMA);
    assert.equal(ref?.vendor, "greenhouse");
    assert.equal(ref?.board, "figma");
    assert.equal(ref?.jobId, "6223155004");
    assert.equal(ref?.apiUrl, API);
    assert.equal(roleRefFor("https://www.figma.com/careers"), null);
    assert.equal(roleRefFor("https://www.figma.com/careers?gh_jid=abc"), null);
  });

  it("a listed gh_jid is live even when the careers page is only a shell", async () => {
    clearAtsResponseCache();
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url === API) {
        return new Response(
          JSON.stringify({
            id: 6223155004,
            title: "Product Designer",
            company_name: "Figma",
            absolute_url: FIGMA,
            first_published: "2026-08-01T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url === FIGMA) return new Response(SHELL, { status: 200, headers: { "content-type": "text/html" } });
      throw new Error(`unexpected ${url}`);
    };
    const verdict = await verifyUrl(FIGMA, fetcher, new Date("2026-10-30T00:00:00Z"), { atsApi: true });
    assert.equal(verdict.status, "live");
    assert.equal(verdict.title, "Product Designer");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.ok(seen.includes(API));
  });

  it("a missing gh_jid is closed from Greenhouse's posting API", async () => {
    clearAtsResponseCache();
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      if (url === API) return new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 });
      if (url === FIGMA) return new Response(SHELL, { status: 200, headers: { "content-type": "text/html" } });
      throw new Error(`unexpected ${url}`);
    };
    const verdict = await verifyUrl(FIGMA, fetcher, new Date(), { atsApi: true });
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING));
  });
});
