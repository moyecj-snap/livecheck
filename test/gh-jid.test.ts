import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import {
  ATS_API_LISTED,
  ATS_API_MISSING,
  GH_JID_COMPANY_EMBED,
  GH_JID_COMPANY_PAGE_ERROR,
  GH_JID_COMPANY_PAGE_NOT_FOUND,
  GH_JID_COMPANY_PAGE_NOT_FOUND_MESSAGE,
  ATS_LISTED_WITH_POSTED_AT_CONFIDENCE,
  combinePageAndAts,
  isGreenhouseEmbedHandoff,
} from "../src/ats-api.js";
import { classify } from "../src/classify.js";
import { evidenceInPlainWords } from "../src/free-job-page.js";
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

  // Bishop Fox: the company careers page answered HTTP 500 while Greenhouse
  // still listed the job. Greenhouse is the system of record; a server error
  // is not a closing. Craig, Nov 2, 2026: live, with the evidence stated.
  it("is live with the error stated when the company careers page errors (Bishop Fox)", async () => {
    const BISHOP = "http://www.bishopfox.com/jobs?gh_jid=5991827004";
    const ERROR_LINE = "Greenhouse lists this job as open; the company's careers page returned an error.";
    for (const status of [500, 502, 503]) {
      clearAtsResponseCache();
      const verdict = await verifyUrl(
        LEGACY,
        routes(
          () => landedAt("<html><head><title>Error</title></head><body>Internal Server Error</body></html>", BISHOP, status),
          listedApi,
        ),
        new Date("2026-11-02T18:00:00Z"),
        { atsApi: true, robotsMode: "strict" },
      );
      assert.equal(verdict.status, "live", String(status));
      assert.equal(verdict.http_status, status);
      assert.ok(verdict.signals.includes(ATS_API_LISTED));
      assert.ok(verdict.signals.includes(GH_JID_COMPANY_PAGE_ERROR));
      assert.equal(verdict.message, ERROR_LINE);
      const lines = evidenceInPlainWords(verdict.signals, "Greenhouse");
      assert.ok(lines.includes(ERROR_LINE), lines.join(" | "));
      assert.equal(lines.some((line) => line.startsWith("Link opens this posting")), false);
    }
  });

  it("a healthy hand-off page carries no error line or message", async () => {
    clearAtsResponseCache();
    const verdict = await verifyUrl(
      LEGACY,
      routes(() => landedAt(CAREERS_HTML, LANDED), listedApi),
      new Date(),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.signals.includes(GH_JID_COMPANY_PAGE_ERROR), false);
    assert.equal(verdict.message, undefined);
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

// Nov 3, 2026 (VentureLoop audit): Bitwarden's own careers link answered a
// brief 404 while Greenhouse still listed the job. v108 said closed. Craig:
// a company-page 404 must not override Greenhouse still listing the job.
describe("Greenhouse lists the gh_jid but the company careers page 404s (Bitwarden)", () => {
  const BITWARDEN = "https://bitwarden.com/careers/8002606003/?gh_jid=8002606003";
  const BW_API = "https://boards-api.greenhouse.io/v1/boards/bitwarden/jobs/8002606003";
  const NOT_FOUND_HTML = "<!doctype html><html><head><title>Page not found | Bitwarden</title></head><body><h1>404</h1><p>We couldn't find that page.</p></body></html>";
  const CLOSED_HTML = "<!doctype html><html><head><title>Bitwarden</title></head><body><p>This job is no longer available.</p></body></html>";

  function listedBw(): Response {
    return new Response(
      JSON.stringify({
        id: 8002606003,
        title: "Senior Software Engineer",
        company_name: "Bitwarden",
        absolute_url: BITWARDEN,
        first_published: "2026-09-25T07:30:49Z",
        updated_at: "2026-11-03T10:00:00Z",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  function bwRoutes(page: () => Response, api: () => Response): typeof fetch {
    return async (input) => {
      const url = requestUrl(input);
      if (url === BW_API) return api();
      if (url === BITWARDEN) return page();
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
      throw new Error(`unexpected ${url}`);
    };
  }

  it("is live at API-listed confidence, with the 404 stated", async () => {
    clearAtsResponseCache();
    assert.equal(roleRefFor(BITWARDEN)?.apiUrl, BW_API);
    const verdict = await verifyUrl(
      BITWARDEN,
      bwRoutes(() => new Response(NOT_FOUND_HTML, { status: 404, headers: { "content-type": "text/html" } }), listedBw),
      new Date("2026-11-03T18:00:00Z"),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.confidence, ATS_LISTED_WITH_POSTED_AT_CONFIDENCE);
    assert.equal(verdict.http_status, 404);
    assert.equal(verdict.title, "Senior Software Engineer");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.ok(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND));
    assert.equal(verdict.message, GH_JID_COMPANY_PAGE_NOT_FOUND_MESSAGE);
    const lines = evidenceInPlainWords(verdict.signals, "Greenhouse");
    assert.ok(lines.includes(GH_JID_COMPANY_PAGE_NOT_FOUND_MESSAGE), lines.join(" | "));
    assert.equal(lines.includes("Posting returns 404 (page not found)"), false, lines.join(" | "));
  });

  it("stays closed when Greenhouse no longer lists the id", async () => {
    clearAtsResponseCache();
    const verdict = await verifyUrl(
      BITWARDEN,
      bwRoutes(
        () => new Response(NOT_FOUND_HTML, { status: 404, headers: { "content-type": "text/html" } }),
        () => new Response(JSON.stringify({ status: 404, error: "Job not found" }), { status: 404 }),
      ),
      new Date("2026-11-03T18:00:00Z"),
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING));
    assert.equal(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND), false);
  });

  it("a 410, closure copy, or a redirect that dropped the id is not overridden", async () => {
    const cases: Array<{ name: string; page: () => Response }> = [
      { name: "410", page: () => new Response(NOT_FOUND_HTML, { status: 410, headers: { "content-type": "text/html" } }) },
      { name: "404 + closure copy", page: () => new Response(CLOSED_HTML, { status: 404, headers: { "content-type": "text/html" } }) },
      {
        name: "404 after a redirect that lost gh_jid",
        page: () => {
          const response = new Response(NOT_FOUND_HTML, { status: 404, headers: { "content-type": "text/html" } });
          Object.defineProperty(response, "url", { value: "https://bitwarden.com/careers/" });
          return response;
        },
      },
    ];
    for (const { name, page } of cases) {
      clearAtsResponseCache();
      const verdict = await verifyUrl(BITWARDEN, bwRoutes(page, listedBw), new Date("2026-11-03T18:00:00Z"), {
        atsApi: true,
        robotsMode: "strict",
      });
      assert.notEqual(verdict.status, "live", name);
      assert.equal(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND), false, name);
    }
  });

  it("covers a greenhouse.io link handed off to a company page that 404s with the same gh_jid", () => {
    const page = classify({
      requestedUrl: "https://boards.greenhouse.io/bitwarden/jobs/8002606003",
      canonicalUrl: BITWARDEN,
      httpStatus: 404,
      title: "Page not found | Bitwarden",
      html: NOT_FOUND_HTML,
      text: "404 We couldn't find that page.",
      redirected: true,
      redirectChain: [BITWARDEN],
    });
    assert.equal(page.status, "closed");
    const combined = combinePageAndAts(page, { outcome: "listed", httpStatus: 200, postedAt: "2026-09-25T07:30:49Z" }, "greenhouse");
    assert.equal(combined.status, "live");
    assert.ok(combined.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND));
  });

  it("leaves Lever, Ashby, and Workday 404s closed (only Greenhouse gh_jid pages)", () => {
    const page = classify({
      requestedUrl: BITWARDEN,
      canonicalUrl: BITWARDEN,
      httpStatus: 404,
      title: "Page not found",
      html: NOT_FOUND_HTML,
      text: "404",
      redirected: false,
      redirectChain: [],
    });
    for (const vendor of ["lever", "ashby", "workday"] as const) {
      const combined = combinePageAndAts(page, { outcome: "listed", httpStatus: 200 }, vendor);
      assert.equal(combined.status, "closed", vendor);
    }
  });
});
