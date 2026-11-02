import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import {
  ATS_API_LISTED,
  ATS_API_MISSING,
  GH_JID_COMPANY_EMBED,
  combinePageAndAts,
  isGreenhouseEmbedHandoff,
} from "../src/ats-api.js";
import { classify } from "../src/classify.js";
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

// Nov 2, 2026 audits (Remote Rocketship): legacy boards.greenhouse.io/<org>/jobs/<id>
// links 301 to the company careers page with ?gh_jid=<id>. The API still listed
// all four (Charlie Health, Seneca Holdings, Bishop Fox, Niche) but v106 said closed.
describe("Greenhouse hand-off to the company careers page (gh_jid kept)", () => {
  const LEGACY = "https://boards.greenhouse.io/charliehealth/jobs/5991827004";
  const LEGACY_API = "https://boards-api.greenhouse.io/v1/boards/charliehealth/jobs/5991827004";
  const LANDED = "https://www.charliehealth.com/careers?gh_jid=5991827004";
  const CAREERS_HTML = `<!doctype html><html><head><title>Careers | Charlie Health</title></head><body><h1>Careers</h1><p>Join our team and help people find care.</p><div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=charliehealth"></script></body></html>`;
  const BOARD_SIGNALS = ["redirected_to_board", "ats_empty_state", "careers_homepage", "not_a_specific_posting"];

  function landedAt(body: string, finalUrl: string, status = 200): Response {
    const response = new Response(body, { status, headers: { "content-type": "text/html" } });
    Object.defineProperty(response, "url", { value: finalUrl });
    return response;
  }

  function listedApi(): Response {
    return new Response(
      JSON.stringify({
        id: 5991827004,
        title: "Mental Health Group Facilitator - PA",
        company_name: "Charlie Health",
        absolute_url: LANDED,
        first_published: "2026-05-08T16:21:05Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function routes(page: () => Response, api: () => Response): typeof fetch {
    return async (input) => {
      const url = requestUrl(input);
      if (url === LEGACY_API) return api();
      if (url === LEGACY) return page();
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
  }

  it("is live when the API still lists the id the redirect kept", async () => {
    clearAtsResponseCache();
    const verdict = await verifyUrl(
      LEGACY,
      routes(() => landedAt(CAREERS_HTML, LANDED), listedApi),
      new Date("2026-11-02T17:30:00Z"),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.title, "Mental Health Group Facilitator - PA");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.ok(verdict.signals.includes(GH_JID_COMPANY_EMBED));
    for (const signal of BOARD_SIGNALS) assert.equal(verdict.signals.includes(signal), false, signal);
  });

  it("is live on a /jobs/ or /about/jobs hand-off and through a bot check", () => {
    for (const landed of [
      "https://senecaholdings.com/jobs/?gh_jid=5991827004",
      "https://www.niche.com/about/jobs?gh_jid=5991827004",
      "http://www.bishopfox.com/jobs?gh_jid=5991827004",
    ]) {
      const page = classify(
        {
          requestedUrl: LEGACY,
          canonicalUrl: landed,
          httpStatus: 200,
          title: "Careers",
          html: CAREERS_HTML,
          text: "Careers Join our team and help people find care.",
          redirected: true,
          redirectChain: [landed],
        },
        new Date(),
      );
      assert.equal(page.status, "closed", landed);
      assert.equal(isGreenhouseEmbedHandoff(page, "greenhouse"), true, landed);
      const combined = combinePageAndAts(page, { outcome: "listed", httpStatus: 200 }, "greenhouse");
      assert.equal(combined.status, "live", landed);
    }
  });

  it("stays closed when the API no longer lists the id", async () => {
    clearAtsResponseCache();
    const verdict = await verifyUrl(
      LEGACY,
      routes(
        () => landedAt(CAREERS_HTML, LANDED),
        () => new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 }),
      ),
      new Date(),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING));
  });

  it("stays closed when the redirect lost or changed the id, or hit Greenhouse's ?error=true board", async () => {
    for (const landed of [
      "https://www.charliehealth.com/careers",
      "https://www.charliehealth.com/careers?gh_jid=1111111111",
      "https://job-boards.greenhouse.io/charliehealth?error=true",
      "https://www.charliehealth.com/careers?gh_jid=5991827004&error=true",
    ]) {
      clearAtsResponseCache();
      const verdict = await verifyUrl(
        LEGACY,
        routes(() => landedAt(CAREERS_HTML, landed), listedApi),
        new Date(),
        { atsApi: true, robotsMode: "strict" },
      );
      assert.equal(verdict.status, "closed", landed);
      assert.equal(verdict.signals.includes(GH_JID_COMPANY_EMBED), false, landed);
    }
  });

  it("closure copy on the hand-off page still disagrees with the listing (unknown)", async () => {
    clearAtsResponseCache();
    const closedCopy = CAREERS_HTML.replace(
      "<p>Join our team",
      "<p>This job is no longer accepting applications.</p><p>Join our team",
    );
    const verdict = await verifyUrl(
      LEGACY,
      routes(() => landedAt(closedCopy, LANDED), listedApi),
      new Date(),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.notEqual(verdict.status, "live");
  });
});
