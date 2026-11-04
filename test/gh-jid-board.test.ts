import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import {
  ATS_API_LISTED,
  ATS_API_MISSING,
  GH_JID_COMPANY_PAGE_NOT_FOUND,
  GH_JID_COMPANY_PAGE_NOT_FOUND_MESSAGE,
} from "../src/ats-api.js";
import { roleRefFor } from "../src/free-job-role.js";
import { greenhouseBoardTokensFromHtml, KNOWN_GREENHOUSE_BOARDS } from "../src/gh-jid-board.js";
import { verifyUrl } from "../src/verify.js";

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

const html = (body: string, status: number) =>
  new Response(body, { status, headers: { "content-type": "text/html" } });
const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const JOB_NOT_FOUND = () => json({ status: 404, error: "Job not found" }, 404);
const BOARD_NOT_FOUND = () => json({ status: 404, error: "Job board not found" }, 404);

// Nov 4, 2026 Dreamwork audit: careers.datadoghq.com gh_jid=8210323. The page
// 404s, the host guess "datadoghq" is not a Greenhouse board, and board
// "datadog" lists the job.
const DATADOG = "https://careers.datadoghq.com/detail/8210323/?gh_jid=8210323";
const GUESS_JOB = "https://boards-api.greenhouse.io/v1/boards/datadoghq/jobs/8210323";
const GUESS_BOARD = "https://boards-api.greenhouse.io/v1/boards/datadoghq";
const REAL_JOB = "https://boards-api.greenhouse.io/v1/boards/datadog/jobs/8210323";
const NOT_FOUND_HTML = "<!doctype html><html><head><title>Page Not Found | Datadog Careers</title></head><body><h1>404</h1><p>Sorry, we couldn't find that page.</p></body></html>";

function listedDatadog(): Response {
  return json(
    {
      id: 8210323,
      title: "Senior Software Engineer - Data Platform",
      company_name: "Datadog",
      absolute_url: DATADOG,
      first_published: "2026-10-20T14:00:00Z",
    },
    200,
  );
}

function routes(map: Record<string, () => Response>, seen: string[] = []): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    seen.push(url);
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    const handler = map[url];
    if (handler) return handler();
    throw new Error(`unexpected ${url}`);
  };
}

const NOW = new Date("2026-11-04T18:40:00Z");

describe("gh_jid on a company domain whose Greenhouse board differs from the host (Datadog)", () => {
  it("the host guess is datadoghq; datadog is in the known mapping", () => {
    assert.equal(roleRefFor(DATADOG)?.board, "datadoghq");
    assert.equal(KNOWN_GREENHOUSE_BOARDS["datadoghq.com"], "datadog");
  });

  it("is live when the company page 404s and the resolved board lists the job", async () => {
    clearAtsResponseCache();
    const seen: string[] = [];
    const verdict = await verifyUrl(
      DATADOG,
      routes(
        {
          [DATADOG]: () => html(NOT_FOUND_HTML, 404),
          [GUESS_JOB]: JOB_NOT_FOUND,
          [GUESS_BOARD]: BOARD_NOT_FOUND,
          [REAL_JOB]: listedDatadog,
        },
        seen,
      ),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.http_status, 404);
    assert.equal(verdict.title, "Senior Software Engineer - Data Platform");
    assert.ok(verdict.signals.includes(ATS_API_LISTED), verdict.signals.join(","));
    assert.ok(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND), verdict.signals.join(","));
    assert.equal(verdict.signals.includes(ATS_API_MISSING), false);
    assert.equal(verdict.message, GH_JID_COMPANY_PAGE_NOT_FOUND_MESSAGE);
    assert.ok(seen.includes(REAL_JOB));
  });

  it("stays closed when the resolved board doesn't list the job", async () => {
    clearAtsResponseCache();
    const verdict = await verifyUrl(
      DATADOG,
      routes({
        [DATADOG]: () => html(NOT_FOUND_HTML, 404),
        [GUESS_JOB]: JOB_NOT_FOUND,
        [GUESS_BOARD]: BOARD_NOT_FOUND,
        [REAL_JOB]: JOB_NOT_FOUND,
      }),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING), verdict.signals.join(","));
    assert.equal(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND), false);
    assert.equal(verdict.signals.includes(ATS_API_LISTED), false);
  });

  it("reads the board token from a Greenhouse embed on the page", async () => {
    clearAtsResponseCache();
    const url = "https://jobs.acme-widgets.io/openings/?gh_jid=4400123";
    const shell = `<!doctype html><html><head><title>Careers</title></head><body><div id="grnhse_app"></div><script src="https://boards.greenhouse.io/embed/job_board/js?for=acmewidgetsco"></script></body></html>`;
    const verdict = await verifyUrl(
      url,
      routes({
        [url]: () => html(shell, 200),
        "https://boards-api.greenhouse.io/v1/boards/acme-widgets/jobs/4400123": JOB_NOT_FOUND,
        "https://boards-api.greenhouse.io/v1/boards/acme-widgets": BOARD_NOT_FOUND,
        "https://boards-api.greenhouse.io/v1/boards/acmewidgetsco/jobs/4400123": () =>
          json({ id: 4400123, title: "Field Engineer", absolute_url: url }, 200),
      }),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "live");
    assert.equal(verdict.title, "Field Engineer");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
  });

  it("a guessed board that doesn't exist and can't be resolved is not evidence: the page decides", async () => {
    clearAtsResponseCache();
    const url = "https://careers.zebrafinch.com/role?gh_jid=990011";
    const verdict = await verifyUrl(
      url,
      routes({
        [url]: () => html("<html><head><title>Not found</title></head><body>404</body></html>", 404),
        "https://boards-api.greenhouse.io/v1/boards/zebrafinch/jobs/990011": JOB_NOT_FOUND,
        "https://boards-api.greenhouse.io/v1/boards/zebrafinch": BOARD_NOT_FOUND,
      }),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.signals.includes(ATS_API_MISSING), false, verdict.signals.join(","));
    assert.ok(verdict.signals.includes("http_404"));
  });

  it("when the guessed board exists, its miss stands and no other board is tried", async () => {
    clearAtsResponseCache();
    const seen: string[] = [];
    const url = "https://www.figmahq.com/careers?gh_jid=6223155004";
    const verdict = await verifyUrl(
      url,
      routes(
        {
          [url]: () => html("<html><head><title>Careers</title></head><body><div id=root></div></body></html>", 200),
          "https://boards-api.greenhouse.io/v1/boards/figmahq/jobs/6223155004": JOB_NOT_FOUND,
          "https://boards-api.greenhouse.io/v1/boards/figmahq": () => json({ name: "FigmaHQ" }, 200),
        },
        seen,
      ),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING));
    assert.equal(seen.some((u) => u.includes("/boards/figma/")), false, seen.join(" "));
  });

  it("a 404 on Greenhouse's own posting page stays closed and skips board resolution (#58)", async () => {
    clearAtsResponseCache();
    const seen: string[] = [];
    const gh = "https://job-boards.greenhouse.io/datadog/jobs/8210323";
    const verdict = await verifyUrl(
      gh,
      routes(
        {
          [gh]: () => html("<html><head><title>Not found</title></head><body>404</body></html>", 404),
          [REAL_JOB]: listedDatadog,
        },
        seen,
      ),
      NOW,
      { atsApi: true, robotsMode: "strict" },
    );
    assert.equal(verdict.status, "closed");
    assert.equal(verdict.signals.includes(GH_JID_COMPANY_PAGE_NOT_FOUND), false);
    assert.equal(seen.some((u) => /\/v1\/boards\/[^/]+$/.test(u)), false, seen.join(" "));
  });
});

describe("greenhouseBoardTokensFromHtml", () => {
  it("finds embed, boards-api, and board-link tokens", () => {
    const page = [
      `<script src="https://boards.greenhouse.io/embed/job_board/js?for=alpha"></script>`,
      `<iframe src="https://job-boards.greenhouse.io/embed/job_app?for=beta&amp;token=1"></iframe>`,
      `fetch("https://boards-api.greenhouse.io/v1/boards/gamma/jobs")`,
      `<a href="https://job-boards.greenhouse.io/delta/jobs/123">x</a>`,
    ].join("\n");
    assert.deepEqual(greenhouseBoardTokensFromHtml(page), ["alpha", "beta", "gamma", "delta"]);
    assert.deepEqual(greenhouseBoardTokensFromHtml(undefined), []);
  });
});
