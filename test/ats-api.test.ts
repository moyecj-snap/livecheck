import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { serve } from "@hono/node-server";
import {
  ATS_API_LISTED,
  ATS_API_MISSING,
  ATS_DISAGREE_CONFIDENCE,
  ATS_LISTED_CONFIDENCE,
  ATS_LISTED_WITH_POSTED_AT_CONFIDENCE,
  ATS_MISSING_CONFIDENCE,
  combinePageAndAts,
  interpretAtsResponse,
  lookupAtsJob,
  parseAtsJobUrl,
  type AtsJobRef,
  type AtsLookup,
} from "../src/ats-api.js";
import { createApp } from "../src/app.js";
import { classify } from "../src/classify.js";
import type { FetchedPage, VerifyVerdict } from "../src/types.js";
import { VerifyError, verifyUrl } from "../src/verify.js";

const ASHBY_LIVE = "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff";
const ASHBY_CLOSED = "https://jobs.ashbyhq.com/linear/deadbeef-dead-beef-dead-beefdeadbeef";
const ASHBY_UNLISTED = "https://jobs.ashbyhq.com/linear/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const LEVER_LIVE = "https://jobs.lever.co/palantir/16a1b500-13fe-4c22-ad89-372093b462da";
const WORKDAY_LIVE =
  "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Sr-Technology-Compliance-Product-Owner_R172124";
const WORKDAY_CLOSED =
  "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/Nowhere/Does-Not-Exist_R000000";
const GREENHOUSE_LIVE = "https://job-boards.greenhouse.io/discord/jobs/8806482002";

const JS_SHELL = `<!doctype html><html><head><title>Jobs</title></head><body><div id="root"></div><p>You need to enable JavaScript to run this app.</p></body></html>`;
const APPLY_PAGE = `<!doctype html><html><head><title>Engineer</title></head><body><a href="/apply">Apply now</a><p>The team is hiring for this role and reviewing applications this week.</p></body></html>`;
const CLOSED_COPY = `<!doctype html><html><head><title>Engineer</title></head><body><p>This job is no longer available.</p></body></html>`;
const CHALLENGE = `<!doctype html><html><head><title>Just a moment...</title></head><body><p>Checking your browser before accessing jobs.lever.co.</p><div class="cf-challenge">verify you are human</div></body></html>`;

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/ats/${name}`, import.meta.url), "utf8");
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function pageOf(url: string, html: string, status = 200): FetchedPage {
  return {
    requestedUrl: url,
    canonicalUrl: url,
    httpStatus: status,
    title: "Jobs",
    html,
    text: html.replace(/<[^>]+>/g, " "),
    redirected: false,
    redirectChain: [],
  };
}

function classified(url: string, html: string, status = 200): VerifyVerdict {
  return classify(pageOf(url, html, status));
}

function refOf(url: string): AtsJobRef {
  const ref = parseAtsJobUrl(url);
  assert.ok(ref, url);
  return ref;
}

function listed(partial: Partial<Extract<AtsLookup, { outcome: "listed" }>> = {}): AtsLookup {
  return { outcome: "listed", httpStatus: 200, title: "From API", ...partial };
}

describe("ATS URL → public API", () => {
  it("maps Ashby, Workday, Lever, then Greenhouse posting URLs", () => {
    assert.deepEqual(parseAtsJobUrl(ASHBY_LIVE), {
      vendor: "ashby",
      board: "linear",
      jobId: "d3bc1ced-3ce4-4086-a050-555055dbb1ff",
      apiUrl: "https://api.ashbyhq.com/posting-api/job-board/linear",
    });
    assert.equal(parseAtsJobUrl(`${ASHBY_LIVE}/application`)?.apiUrl, "https://api.ashbyhq.com/posting-api/job-board/linear");

    assert.equal(
      parseAtsJobUrl(WORKDAY_LIVE)?.apiUrl,
      "https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/job/San-Jose/Sr-Technology-Compliance-Product-Owner_R172124",
    );
    assert.equal(
      parseAtsJobUrl(WORKDAY_CLOSED)?.apiUrl,
      "https://adobe.wd5.myworkdayjobs.com/wday/cxs/adobe/external_experienced/job/Nowhere/Does-Not-Exist_R000000",
    );
    assert.equal(
      parseAtsJobUrl("https://wd5.myworkdaysite.com/recruiting/acme/en-US/External/job/NYC/Engineer_R1")?.apiUrl,
      "https://wd5.myworkdaysite.com/wday/cxs/acme/External/job/NYC/Engineer_R1",
    );

    assert.equal(
      parseAtsJobUrl(LEVER_LIVE)?.apiUrl,
      "https://api.lever.co/v0/postings/palantir/16a1b500-13fe-4c22-ad89-372093b462da",
    );
    assert.equal(
      parseAtsJobUrl("https://jobs.eu.lever.co/acme/16a1b500-13fe-4c22-ad89-372093b462da/apply")?.apiUrl,
      "https://api.eu.lever.co/v0/postings/acme/16a1b500-13fe-4c22-ad89-372093b462da",
    );

    assert.equal(
      parseAtsJobUrl(GREENHOUSE_LIVE)?.apiUrl,
      "https://boards-api.greenhouse.io/v1/boards/discord/jobs/8806482002",
    );
    assert.equal(
      parseAtsJobUrl("https://boards.greenhouse.io/embed/job_app?for=discord&token=1842")?.apiUrl,
      "https://boards-api.greenhouse.io/v1/boards/discord/jobs/1842",
    );
    assert.equal(
      parseAtsJobUrl("https://job-boards.eu.greenhouse.io/acme/jobs/1842")?.apiUrl,
      "https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs/1842",
    );
  });

  it("ignores board homepages and non-ATS careers URLs", () => {
    for (const url of [
      "https://jobs.ashbyhq.com/linear",
      "https://jobs.ashbyhq.com/linear/jobs",
      "https://jobs.lever.co/palantir",
      "https://boards.greenhouse.io/discord",
      "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced",
      "https://www.teamworkonline.com/baseball-jobs/colorado-rockies/colorado-rockies-jobs/staff-accountant-2170000",
      "https://example.com/jobs/123",
    ]) {
      assert.equal(parseAtsJobUrl(url), null, url);
    }
  });
});

describe("ATS response interpretation", () => {
  it("reads listed vs missing fixtures for each vendor", () => {
    const ashby = refOf(ASHBY_LIVE);
    const ashbyListed = interpretAtsResponse(ashby, 200, fixture("ashby-board.json"));
    assert.equal(ashbyListed.outcome, "listed");
    if (ashbyListed.outcome === "listed") {
      assert.equal(ashbyListed.title, "Product Engineer");
      assert.equal(ashbyListed.postedAt, "2026-05-21T18:22:21Z");
    }
    const direct = interpretAtsResponse(refOf(ASHBY_UNLISTED), 200, fixture("ashby-board.json"));
    assert.equal(direct.outcome, "listed");
    assert.equal(interpretAtsResponse(refOf(ASHBY_CLOSED), 200, fixture("ashby-board-missing.json")).outcome, "missing");
    assert.equal(interpretAtsResponse(ashby, 404, fixture("ashby-board-missing.json")).outcome, "missing");

    const lever = interpretAtsResponse(refOf(LEVER_LIVE), 200, fixture("lever-posting.json"));
    assert.equal(lever.outcome, "listed");
    if (lever.outcome === "listed") assert.equal(lever.title, "Deal Team - Business Affairs");
    assert.equal(interpretAtsResponse(refOf(LEVER_LIVE), 404, fixture("lever-missing.json")).outcome, "missing");

    const gh = interpretAtsResponse(refOf(GREENHOUSE_LIVE), 200, fixture("greenhouse-job.json"));
    assert.equal(gh.outcome, "listed");
    if (gh.outcome === "listed") {
      assert.equal(gh.title, "Staff Software Engineer");
      assert.equal(gh.postedAt, new Date("2026-08-15T09:30:00-04:00").toISOString().replace(/\.\d{3}Z$/, "Z"));
    }
    assert.equal(interpretAtsResponse(refOf(GREENHOUSE_LIVE), 404, fixture("greenhouse-missing.json")).outcome, "missing");

    const workday = interpretAtsResponse(refOf(WORKDAY_LIVE), 200, fixture("workday-job.json"));
    assert.equal(workday.outcome, "listed");
    if (workday.outcome === "listed") {
      assert.equal(workday.title, "Sr Technology Compliance Product Owner");
      assert.equal(workday.postedAt, undefined);
    }
    assert.equal(interpretAtsResponse(refOf(WORKDAY_CLOSED), 404, "{}").outcome, "missing");
    assert.equal(interpretAtsResponse(refOf(WORKDAY_CLOSED), 403, fixture("workday-s22.json")).outcome, "missing");
  });

  it("does not treat errors, challenge HTML, or ambiguous JSON as missing", () => {
    const ashby = refOf(ASHBY_LIVE);
    assert.equal(interpretAtsResponse(ashby, 500, "unavailable").outcome, "unavailable");
    assert.equal(interpretAtsResponse(ashby, 502, "").outcome, "unavailable");
    assert.equal(interpretAtsResponse(ashby, 429, "").outcome, "unavailable");
    assert.equal(interpretAtsResponse(ashby, 200, "not-json").outcome, "unavailable");
    assert.equal(interpretAtsResponse(ashby, 200, fixture("ashby-board.json").slice(0, 40), true).outcome, "unavailable");
    assert.equal(interpretAtsResponse(ashby, 404, CHALLENGE).outcome, "unavailable");
    assert.equal(interpretAtsResponse(refOf(WORKDAY_LIVE), 403, "<html>forbidden</html>").outcome, "unavailable");
    assert.equal(interpretAtsResponse(refOf(WORKDAY_LIVE), 422, '{"error":"invalid site"}').outcome, "unavailable");
    assert.equal(interpretAtsResponse(refOf(WORKDAY_LIVE), 200, '{"similarJobs":[]}').outcome, "unavailable");
    assert.equal(interpretAtsResponse(refOf(LEVER_LIVE), 200, CHALLENGE).outcome, "unavailable");
    assert.equal(interpretAtsResponse(refOf(GREENHOUSE_LIVE), 200, '{"id":1}').outcome, "unavailable");
  });

  it("lookup treats abort and network failure as unavailable", async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const abort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
    const timedOut = await lookupAtsJob(refOf(ASHBY_LIVE), hanging, { timeoutMs: 20 });
    assert.equal(timedOut.outcome, "unavailable");

    const broken: typeof fetch = async () => {
      throw new Error("econnreset");
    };
    const failed = await lookupAtsJob(refOf(LEVER_LIVE), broken);
    assert.equal(failed.outcome, "unavailable");
  });
});

describe("page × API combine", () => {
  it("live + listed stays live at high confidence", () => {
    const page = classified(GREENHOUSE_LIVE, APPLY_PAGE);
    assert.equal(page.status, "live");
    const combined = combinePageAndAts(page, listed({ postedAt: "2026-08-15T13:30:00Z", title: "Staff Software Engineer" }));
    assert.equal(combined.status, "live");
    assert.equal(combined.confidence, ATS_LISTED_WITH_POSTED_AT_CONFIDENCE);
    assert.equal(combined.signals[0], ATS_API_LISTED);
    assert.ok(combined.signals.includes("ats_posted_at:2026-08-15T13:30:00Z"));
    assert.ok(combined.signals.includes("apply form present"));
    assert.equal(combined.title, "Staff Software Engineer");
  });

  it("JS shell + listed becomes live with ats_api_listed", () => {
    const page = classified(ASHBY_LIVE, JS_SHELL);
    assert.equal(page.status, "unknown");
    assert.equal(page.signals.includes("challenge_page"), false);
    const combined = combinePageAndAts(page, listed({ title: "Product Engineer" }));
    assert.equal(combined.status, "live");
    assert.equal(combined.confidence, ATS_LISTED_CONFIDENCE);
    assert.equal(combined.signals[0], ATS_API_LISTED);
    assert.equal(combined.title, "Product Engineer");
  });

  it("any non-challenge page + missing becomes closed", () => {
    for (const page of [
      classified(ASHBY_LIVE, JS_SHELL),
      classified(GREENHOUSE_LIVE, APPLY_PAGE),
      classified(GREENHOUSE_LIVE, CLOSED_COPY),
    ]) {
      const combined = combinePageAndAts(page, { outcome: "missing", httpStatus: 404 });
      assert.equal(combined.status, "closed", page.status);
      assert.equal(combined.confidence, ATS_MISSING_CONFIDENCE);
      assert.equal(combined.signals[0], ATS_API_MISSING);
    }
  });

  it("closed + listed is unknown and keeps both signals", () => {
    const page = classified(GREENHOUSE_LIVE, CLOSED_COPY);
    assert.equal(page.status, "closed");
    const combined = combinePageAndAts(page, listed({ postedAt: "2026-08-15T13:30:00Z" }));
    assert.equal(combined.status, "unknown");
    assert.equal(combined.confidence, ATS_DISAGREE_CONFIDENCE);
    assert.ok(combined.signals.includes(ATS_API_LISTED));
    assert.ok(combined.signals.some((signal) => signal.startsWith("close_language:")));
    assert.ok(combined.signals.includes("ats_posted_at:2026-08-15T13:30:00Z"));
  });

  it("a challenge page stays unknown even when the API lists or misses the job", () => {
    const page = classified(LEVER_LIVE, CHALLENGE);
    assert.equal(page.status, "unknown");
    assert.ok(page.signals.includes("challenge_page"));
    const listedVerdict = combinePageAndAts(page, listed());
    const missingVerdict = combinePageAndAts(page, { outcome: "missing", httpStatus: 404 });
    const blockedVerdict = combinePageAndAts(page, { outcome: "unavailable" });
    for (const verdict of [listedVerdict, missingVerdict, blockedVerdict]) {
      assert.equal(verdict.status, "unknown");
      assert.ok(verdict.signals.includes("challenge_page"));
      assert.equal(verdict.signals.includes(ATS_API_LISTED), false);
      assert.equal(verdict.signals.includes(ATS_API_MISSING), false);
    }
  });

  it("unavailable API leaves the HTML verdict unchanged", () => {
    const page = classified(ASHBY_CLOSED, JS_SHELL);
    const combined = combinePageAndAts(page, { outcome: "unavailable" });
    assert.deepEqual(combined, page);
  });
});

describe("verifyUrl ATS integration", () => {
  function routed(routes: Record<string, Response> | ((url: string) => Response | Promise<Response>)): typeof fetch {
    return async (input) => {
      const url = requestUrl(input);
      if (typeof routes === "function") return routes(url);
      const response = routes[url];
      if (!response) throw new Error(`unexpected fetch ${url}`);
      return response.clone();
    };
  }

  it("promotes an Ashby JS shell when the board lists the job", async () => {
    const verdict = await verifyUrl(ASHBY_LIVE, routed({
      [ASHBY_LIVE]: htmlResponse(JS_SHELL),
      "https://api.ashbyhq.com/posting-api/job-board/linear": jsonResponse(fixture("ashby-board.json")),
    }), new Date("2026-10-01T00:00:00Z"), { atsApi: true });
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.equal(verdict.title, "Product Engineer");
    assert.ok(verdict.confidence >= ATS_LISTED_CONFIDENCE);
  });

  it("closes an Ashby shell when the board does not list the id", async () => {
    const verdict = await verifyUrl(ASHBY_CLOSED, routed({
      [ASHBY_CLOSED]: htmlResponse(JS_SHELL),
      "https://api.ashbyhq.com/posting-api/job-board/linear": jsonResponse(fixture("ashby-board-missing.json")),
    }), new Date(), { atsApi: true });
    assert.equal(verdict.status, "closed");
    assert.ok(verdict.signals.includes(ATS_API_MISSING));
  });

  it("uses Workday CXS, Lever, and Greenhouse the same way", async () => {
    const workday = await verifyUrl(WORKDAY_LIVE, routed({
      [WORKDAY_LIVE]: htmlResponse(JS_SHELL),
      [refOf(WORKDAY_LIVE).apiUrl]: jsonResponse(fixture("workday-job.json")),
    }), new Date(), { atsApi: true });
    assert.equal(workday.status, "live");
    assert.equal(workday.confidence, ATS_LISTED_CONFIDENCE);

    const workdayGone = await verifyUrl(WORKDAY_CLOSED, routed({
      [WORKDAY_CLOSED]: htmlResponse(JS_SHELL),
      [refOf(WORKDAY_CLOSED).apiUrl]: jsonResponse(fixture("workday-s22.json"), 403),
    }), new Date(), { atsApi: true });
    assert.equal(workdayGone.status, "closed");
    assert.ok(workdayGone.signals.includes(ATS_API_MISSING));

    const lever = await verifyUrl(LEVER_LIVE, routed({
      [LEVER_LIVE]: htmlResponse(JS_SHELL),
      [refOf(LEVER_LIVE).apiUrl]: jsonResponse(fixture("lever-posting.json")),
    }), new Date(), { atsApi: true });
    assert.equal(lever.status, "live");
    assert.equal(lever.title, "Deal Team - Business Affairs");

    const leverMissing = await verifyUrl(LEVER_LIVE, routed({
      [LEVER_LIVE]: htmlResponse(APPLY_PAGE),
      [refOf(LEVER_LIVE).apiUrl]: jsonResponse(fixture("lever-missing.json"), 404),
    }), new Date(), { atsApi: true });
    assert.equal(leverMissing.status, "closed");

    const greenhouse = await verifyUrl(GREENHOUSE_LIVE, routed({
      [GREENHOUSE_LIVE]: htmlResponse(APPLY_PAGE),
      [refOf(GREENHOUSE_LIVE).apiUrl]: jsonResponse(fixture("greenhouse-job.json")),
    }), new Date(), { atsApi: true });
    assert.equal(greenhouse.status, "live");
    assert.equal(greenhouse.confidence, ATS_LISTED_WITH_POSTED_AT_CONFIDENCE);
    assert.ok(greenhouse.signals.some((signal) => signal.startsWith("ats_posted_at:")));

    const greenhouseMissing = await verifyUrl(GREENHOUSE_LIVE, routed({
      [GREENHOUSE_LIVE]: htmlResponse(APPLY_PAGE),
      [refOf(GREENHOUSE_LIVE).apiUrl]: jsonResponse(fixture("greenhouse-missing.json"), 404),
    }), new Date(), { atsApi: true });
    assert.equal(greenhouseMissing.status, "closed");
    assert.equal(greenhouseMissing.signals.includes(ATS_API_MISSING), true);
  });

  it("does not promote a challenge page when the Lever API lists the job", async () => {
    const verdict = await verifyUrl(LEVER_LIVE, routed({
      [LEVER_LIVE]: htmlResponse(CHALLENGE),
      [refOf(LEVER_LIVE).apiUrl]: jsonResponse(fixture("lever-posting.json")),
    }), new Date(), { atsApi: true });
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
    assert.equal(verdict.signals.includes(ATS_API_LISTED), false);
  });

  it("falls back to HTML when the API is a 500 and does not call it unless opted in", async () => {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      seen.push(url);
      if (url.includes("api.ashbyhq.com")) return jsonResponse("nope", 500);
      return htmlResponse(JS_SHELL);
    };
    const opted = await verifyUrl(ASHBY_LIVE, fetcher, new Date(), { atsApi: true });
    assert.equal(opted.status, "unknown");
    assert.equal(opted.signals.includes(ATS_API_MISSING), false);
    assert.equal(opted.signals.includes(ATS_API_LISTED), false);
    assert.ok(seen.some((url) => url.includes("api.ashbyhq.com")));

    seen.length = 0;
    const htmlOnly = await verifyUrl(ASHBY_LIVE, fetcher);
    assert.equal(htmlOnly.status, "unknown");
    assert.equal(seen.some((url) => url.includes("api.ashbyhq.com")), false);
    assert.ok(htmlOnly.signals.includes("js_shell") || htmlOnly.signals.includes("ambiguous_html"));
  });

  it("keeps the HTML classifier for a non-ATS apply page and a closure banner", async () => {
    const fetcher: typeof fetch = async (input) => {
      const url = requestUrl(input);
      assert.equal(url.startsWith("https://example.com/"), true);
      if (url.endsWith("/closed")) return htmlResponse(CLOSED_COPY);
      return htmlResponse(APPLY_PAGE);
    };
    const live = await verifyUrl("https://example.com/jobs/123", fetcher, new Date(), { atsApi: true });
    const closed = await verifyUrl("https://example.com/jobs/closed", fetcher, new Date(), { atsApi: true });
    assert.equal(live.status, "live");
    assert.ok(live.signals.includes("apply form present"));
    assert.equal(live.signals.includes(ATS_API_LISTED), false);
    assert.equal(closed.status, "closed");
    assert.ok(closed.signals.some((signal) => signal.startsWith("close_language:")));
  });

  it("uses a definitive API result when the HTML fetch fails", async () => {
    const verdict = await verifyUrl(WORKDAY_LIVE, routed(async (url) => {
      if (url === WORKDAY_LIVE) throw new Error("econnreset");
      if (url === refOf(WORKDAY_LIVE).apiUrl) return jsonResponse(fixture("workday-job.json"));
      throw new Error(`unexpected ${url}`);
    }), new Date(), { atsApi: true });
    assert.equal(verdict.status, "live");
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.equal(verdict.signals.includes("challenge_page"), false);

    await assert.rejects(
      () =>
        verifyUrl(WORKDAY_LIVE, routed(async (url) => {
          if (url === WORKDAY_LIVE) throw new Error("econnreset");
          return jsonResponse("down", 503);
        }), new Date(), { atsApi: true }),
      (error: unknown) => error instanceof VerifyError && error.status === 502,
    );
  });
});

describe("POST /v1/verify/job uses the public ATS API", () => {
  const app = createApp();
  let origin = "";
  let close: () => void = () => {};
  const originalFetch = globalThis.fetch;

  before(async () => {
    await new Promise<void>((resolve) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => {
        origin = `http://127.0.0.1:${info.port}`;
        close = () => server.close();
        resolve();
      });
    });
  });

  after(() => {
    globalThis.fetch = originalFetch;
    close();
  });

  it("returns live with route verify/job, and listing stays on HTML", async () => {
    const seen: string[] = [];
    let boardBody = fixture("ashby-board.json");
    globalThis.fetch = async (input, init) => {
      const url = requestUrl(input);
      if (url.startsWith(origin)) return originalFetch(input, init);
      seen.push(url);
      if (url === ASHBY_LIVE || url === ASHBY_CLOSED) return htmlResponse(JS_SHELL);
      if (url === "https://api.ashbyhq.com/posting-api/job-board/linear") return jsonResponse(boardBody);
      return jsonResponse("missing", 404);
    };

    const job = await originalFetch(`${origin}/v1/verify/job`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: ASHBY_LIVE }),
    });
    assert.equal(job.status, 200);
    const jobBody = (await job.json()) as { route?: string; status?: string; signals?: string[]; confidence?: number };
    assert.equal(jobBody.route, "verify/job");
    assert.equal(jobBody.status, "live");
    assert.ok(jobBody.signals?.includes(ATS_API_LISTED));
    assert.equal((jobBody as { http_status?: number }).http_status, 200);
    assert.ok((jobBody.confidence ?? 0) >= ATS_LISTED_CONFIDENCE);

    seen.length = 0;
    const listing = await originalFetch(`${origin}/v1/verify/listing`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: ASHBY_LIVE }),
    });
    assert.equal(listing.status, 200);
    const listingBody = (await listing.json()) as { route?: string; status?: string; signals?: string[] };
    assert.equal(listingBody.route, "verify/listing");
    assert.equal(listingBody.status, "unknown");
    assert.equal(listingBody.signals?.includes(ATS_API_LISTED), false);
    assert.equal(seen.some((url) => url.includes("api.ashbyhq.com")), false);

    boardBody = fixture("ashby-board-missing.json");
    const shared = await originalFetch(`${origin}/v1/verify`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-livecheck-mock": "1" },
      body: JSON.stringify({ url: ASHBY_CLOSED }),
    });
    assert.equal(shared.status, 200);
    const sharedBody = (await shared.json()) as { route?: string; status?: string; signals?: string[] };
    assert.equal(sharedBody.route, "verify");
    assert.equal(sharedBody.status, "closed");
    assert.equal((sharedBody as { http_status?: number }).http_status, 200);
    assert.ok(sharedBody.signals?.includes(ATS_API_MISSING));
  });
});
