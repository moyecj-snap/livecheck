import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { summarizeAges, ageAuditCsv, type AgeAuditRow } from "../src/age-audit.js";
import {
  ATS_API_LISTED,
  ATS_LISTED_WITH_POSTED_AT_CONFIDENCE,
  combinePageAndAts,
  interpretAtsResponse,
  parseAtsJobUrl,
} from "../src/ats-api.js";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import { VERIFY_INPUT_SCHEMA, VERIFY_OUTPUT_SCHEMA } from "../src/bazaar.js";
import { classify } from "../src/classify.js";
import {
  AGE_CONFLICT_SIGNAL,
  AGE_NOTE_OVER_60,
  ageBucket,
  buildPostingAge,
  clampStaleAfterDays,
  jsonLdJobPosting,
  noteForAge30to60,
  parseAgeDate,
  parseWorkdayPostedOn,
  resolvePostingAge,
  type PostingAge,
} from "../src/posting-age.js";
import { verifyUrl } from "../src/verify.js";

const NOW = new Date("2026-11-03T18:00:00Z");
const BITWARDEN = "https://bitwarden.com/careers/8002606003/?gh_jid=8002606003";
const BW_API = "https://boards-api.greenhouse.io/v1/boards/bitwarden/jobs/8002606003";
const LIVE_HTML = (extraHead = "") =>
  `<!doctype html><html><head><title>Senior Software Engineer | Bitwarden</title>${extraHead}</head><body><h1>Senior Software Engineer</h1><a href="#app">Apply now</a><form id="application"><button type="submit">Submit application</button></form></body></html>`;
const CLOSED_HTML = "<!doctype html><html><head><title>Bitwarden</title></head><body><p>This job is no longer available.</p></body></html>";

function requestUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function ghRow(dates: Record<string, string>): Record<string, unknown> {
  return { id: 8002606003, title: "Senior Software Engineer", company_name: "Bitwarden", absolute_url: BITWARDEN, ...dates };
}

function routes(page: () => Response, api: () => Response): typeof fetch {
  return async (input) => {
    const url = requestUrl(input);
    if (url === BW_API) return api();
    if (url === BITWARDEN) return page();
    if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    throw new Error(`unexpected ${url}`);
  };
}

async function checkBw(page: () => Response, api: () => Response, age?: { staleAfterDays?: number }) {
  clearAtsResponseCache();
  return verifyUrl(BITWARDEN, routes(page, api), NOW, {
    atsApi: true,
    robotsMode: "strict",
    ...(age ? { age: { mode: "job" as const, ...age } } : {}),
  });
}

const livePage = (head = "") => () => new Response(LIVE_HTML(head), { status: 200, headers: { "content-type": "text/html" } });

describe("posting age (Nov 3, 2026 scope)", () => {
  it("1. Greenhouse first_published wins over updated_at (Bitwarden: Sep 25 → 39 days)", async () => {
    const verdict = await checkBw(livePage(), () => json(ghRow({ first_published: "2026-09-25T07:30:49Z", updated_at: "2026-11-03T10:00:00Z" })), {});
    const age = verdict.age as PostingAge;
    assert.equal(verdict.status, "live");
    assert.equal(age.age_source, "greenhouse.first_published");
    assert.equal(age.posted_at, "2026-09-25T07:30:49Z");
    assert.equal(age.age_days, 39);
    assert.equal(age.age_precision, "exact");
    assert.equal(age.age_bucket, "31-60");
    assert.equal(age.stale_age, false);
    assert.equal(age.last_updated_at, "2026-11-03T10:00:00Z");
    assert.equal(age.note, noteForAge30to60(39));
    // published_at is the next fallback.
    const pub = interpretAtsResponse(parseAtsJobUrl("https://job-boards.greenhouse.io/bitwarden/jobs/8002606003")!, 200, JSON.stringify(ghRow({ published_at: "2026-10-01T00:00:00Z" })));
    assert.equal(pub.outcome === "listed" && pub.age?.source, "greenhouse.published_at");
  });

  it("2. Greenhouse with only updated_at: age unknown, confidence unchanged (0.97), no ats_posted_at signal", async () => {
    const verdict = await checkBw(livePage(), () => json(ghRow({ updated_at: "2026-11-02T10:00:00Z" })), {});
    const age = verdict.age as PostingAge;
    assert.equal(age.age_source, "none");
    assert.equal(age.posted_at, null);
    assert.equal(age.age_days, null);
    assert.equal(age.age_bucket, "unknown");
    assert.equal(age.stale_age, null);
    assert.equal(age.last_updated_at, "2026-11-02T10:00:00Z");
    assert.equal(age.note, undefined);
    assert.equal(verdict.confidence, ATS_LISTED_WITH_POSTED_AT_CONFIDENCE);
    assert.ok(verdict.signals.includes(ATS_API_LISTED));
    assert.equal(verdict.signals.some((s) => s.startsWith("ats_posted_at")), false);
  });

  it("3. Lever createdAt (epoch ms) is exact", () => {
    const ref = parseAtsJobUrl("https://jobs.lever.co/palantir/16a1b500-13fe-4c22-ad89-372093b462da")!;
    const created = Date.parse("2026-08-01T12:00:00Z");
    const api = interpretAtsResponse(ref, 200, JSON.stringify({ id: "16a1b500-13fe-4c22-ad89-372093b462da", text: "Engineer", createdAt: created }));
    assert.equal(api.outcome, "listed");
    const age = buildPostingAge(api.outcome === "listed" ? api.age : undefined, NOW, 60, "live");
    assert.equal(age.age_source, "lever.createdAt");
    assert.equal(age.posted_at, "2026-08-01T12:00:00Z");
    assert.equal(age.age_days, 94);
    assert.equal(age.age_bucket, "90+");
    assert.equal(age.stale_age, true);
    assert.equal(age.note, AGE_NOTE_OVER_60);
  });

  it("4. Ashby board publishedAt is used; Ashby GraphQL (no date) is unknown", () => {
    const id = "d3bc1ced-3ce4-4086-a050-555055dbb1ff";
    const ref = parseAtsJobUrl(`https://jobs.ashbyhq.com/linear/${id}`)!;
    const board = interpretAtsResponse(ref, 200, JSON.stringify({ jobs: [{ id, title: "Engineer", jobUrl: `https://jobs.ashbyhq.com/linear/${id}`, publishedAt: "2026-10-30T09:00:00.000+00:00" }] }));
    assert.equal(board.outcome, "listed");
    const age = buildPostingAge(board.outcome === "listed" ? board.age : undefined, NOW);
    assert.equal(age.age_source, "ashby.publishedAt");
    assert.equal(age.age_days, 4);
    assert.equal(age.age_bucket, "0-7");
    const gql = interpretAtsResponse(ref, 200, JSON.stringify({ data: { jobPosting: { id, title: "Engineer" } } }));
    assert.equal(gql.outcome, "listed");
    const unknown = buildPostingAge(gql.outcome === "listed" ? gql.age : undefined, NOW);
    assert.equal(unknown.age_source, "none");
    assert.equal(unknown.age_days, null);
  });

  it("5. Workday startDate, and the postedOn text forms (Today, Yesterday, N Days Ago, 30+ Days Ago)", () => {
    const ref = parseAtsJobUrl("https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Sr-Technology-Compliance-Product-Owner_R172124")!;
    const withStart = interpretAtsResponse(ref, 200, JSON.stringify({ jobPostingInfo: { title: "Owner", startDate: "2026-10-20", postedOn: "Posted 14 Days Ago" } }));
    assert.equal(withStart.outcome, "listed");
    const a = buildPostingAge(withStart.outcome === "listed" ? withStart.age : undefined, NOW);
    assert.equal(a.age_source, "workday.startDate");
    assert.equal(a.age_precision, "day");
    assert.equal(a.age_days, 14);
    assert.deepEqual(parseWorkdayPostedOn("Posted Today"), { daysAgo: 0 });
    assert.deepEqual(parseWorkdayPostedOn("Posted Yesterday"), { daysAgo: 1 });
    assert.deepEqual(parseWorkdayPostedOn("Posted 12 Days Ago"), { daysAgo: 12 });
    assert.deepEqual(parseWorkdayPostedOn("Posted 30+ Days Ago"), { atLeastDays: 30 });
    const text = interpretAtsResponse(ref, 200, JSON.stringify({ jobPostingInfo: { title: "Owner", postedOn: "Posted 30+ Days Ago" } }));
    const b = buildPostingAge(text.outcome === "listed" ? text.age : undefined, NOW, 60, "live");
    assert.equal(b.age_source, "workday.postedOn_text");
    assert.equal(b.age_precision, "at_least");
    assert.equal(b.age_days, null);
    assert.equal(b.age_days_min, 30);
    assert.equal(b.age_bucket, "30+");
    assert.equal(b.stale_age, null);
    assert.equal(b.note, noteForAge30to60("30+"));
    const twelve = buildPostingAge(interpretAtsResponse(ref, 200, JSON.stringify({ jobPostingInfo: { title: "Owner", postedOn: "Posted 12 Days Ago" } })).outcome === "listed" ? { source: "workday.postedOn_text", precision: "day", daysAgo: 12 } : undefined, NOW);
    assert.equal(twelve.posted_at, "2026-10-22");
    assert.equal(twelve.age_days, 12);
  });

  it("6. JSON-LD datePosted (date-only and ISO) fills a gap; the ATS wins on conflict with age_conflict", async () => {
    assert.deepEqual(parseAgeDate("2026-10-01"), { iso: "2026-10-01", precision: "day" });
    assert.equal(parseAgeDate("2026-10-01T08:00:00-07:00")?.precision, "exact");
    const ld = (date: string) => `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "Organization" }, { "@type": "JobPosting", title: "Engineer", datePosted: date }] })}</script>`;
    assert.equal(jsonLdJobPosting(LIVE_HTML(ld("2026-10-01")))?.datePosted, "2026-10-01");
    // Gap: Greenhouse has only updated_at → JSON-LD date is used.
    const gap = await checkBw(livePage(ld("2026-10-01")), () => json(ghRow({ updated_at: "2026-11-02T10:00:00Z" })), {});
    assert.equal(gap.age?.age_source, "jsonld.datePosted");
    assert.equal(gap.age?.age_precision, "day");
    assert.equal(gap.age?.age_days, 33);
    assert.equal(gap.signals.includes(AGE_CONFLICT_SIGNAL), false);
    // Conflict: first_published Sep 25 vs JSON-LD Nov 1 → Greenhouse wins.
    const conflict = await checkBw(livePage(ld("2026-11-01T00:00:00Z")), () => json(ghRow({ first_published: "2026-09-25T07:30:49Z" })), {});
    assert.equal(conflict.age?.age_source, "greenhouse.first_published");
    assert.equal(conflict.age?.age_days, 39);
    assert.ok(conflict.signals.includes(AGE_CONFLICT_SIGNAL));
    // Within 2 days is not a conflict.
    const close = resolvePostingAge({ ats: { source: "greenhouse.first_published", postedAt: "2026-09-25T07:30:49Z", precision: "exact" }, jsonLdDatePosted: "2026-09-26", now: NOW, status: "live" });
    assert.equal(close.conflict, false);
  });

  it("7. future, pre-2000, and malformed dates are unknown, never a crash", () => {
    assert.equal(parseAgeDate("2026-11-10T00:00:00Z", NOW), undefined);
    assert.ok(parseAgeDate("2026-11-04T10:00:00Z", NOW), "within a day ahead is tolerated (time zones)");
    assert.equal(parseAgeDate("1999-12-31"), undefined);
    for (const bad of ["not a date", "", "2026-13-45", null, {}, Number.NaN, "Posted a while ago"]) assert.equal(parseAgeDate(bad, NOW), undefined, String(bad));
    const future = buildPostingAge({ source: "lever.createdAt", postedAt: "2027-01-01T00:00:00Z", precision: "exact" }, NOW);
    assert.equal(future.age_source, "none");
    assert.equal(future.age_days, null);
    const ref = parseAtsJobUrl("https://job-boards.greenhouse.io/bitwarden/jobs/8002606003")!;
    const api = interpretAtsResponse(ref, 200, JSON.stringify(ghRow({ first_published: "garbage" })));
    assert.equal(buildPostingAge(api.outcome === "listed" ? api.age : undefined, NOW).age_source, "none");
    assert.equal(parseWorkdayPostedOn("Posted recently"), undefined);
  });

  it("8. bucket edges: 7/8, 30/31, 60/61, 90/91", () => {
    assert.deepEqual([0, 7, 8, 30, 31, 60, 61, 90, 91, 400].map(ageBucket), ["0-7", "0-7", "8-30", "8-30", "31-60", "31-60", "61-90", "61-90", "90+", "90+"]);
    const at = (days: number) => buildPostingAge({ source: "workday.postedOn_text", precision: "day", daysAgo: days }, NOW, 60, "live");
    assert.equal(at(29).note, undefined);
    assert.equal(at(30).note, noteForAge30to60(30));
    assert.equal(at(60).note, noteForAge30to60(60));
    assert.equal(at(61).note, AGE_NOTE_OVER_60);
    assert.equal(at(60).stale_age, false);
    assert.equal(at(61).stale_age, true);
    // Notes only on live answers.
    assert.equal(buildPostingAge({ source: "workday.postedOn_text", precision: "day", daysAgo: 80 }, NOW, 60, "closed").note, undefined);
  });

  it("9. stale_after_days: default 60, override, clamped to 7–365", async () => {
    assert.equal(clampStaleAfterDays(undefined), 60);
    assert.equal(clampStaleAfterDays("abc"), 60);
    assert.equal(clampStaleAfterDays(30), 30);
    assert.equal(clampStaleAfterDays("45"), 45);
    assert.equal(clampStaleAfterDays(1), 7);
    assert.equal(clampStaleAfterDays(9999), 365);
    const v = await checkBw(livePage(), () => json(ghRow({ first_published: "2026-09-25T07:30:49Z" })), { staleAfterDays: 30 });
    assert.equal(v.age?.stale_after_days, 30);
    assert.equal(v.age?.stale_age, true);
    const d = await checkBw(livePage(), () => json(ghRow({ first_published: "2026-09-25T07:30:49Z" })), {});
    assert.equal(d.age?.stale_after_days, 60);
    assert.equal(d.age?.stale_age, false);
  });

  it("10. HARD RULE: dates never change status, confidence, or the verdict", async () => {
    const cases: Array<{ name: string; page: () => Response; api: () => Response }> = [
      { name: "400-day-old listed job", page: livePage(), api: () => json(ghRow({ first_published: "2025-09-29T00:00:00Z" })) },
      { name: "fresh listed job", page: livePage(), api: () => json(ghRow({ first_published: "2026-11-02T00:00:00Z" })) },
      { name: "updated_at only", page: livePage(), api: () => json(ghRow({ updated_at: "2026-11-02T00:00:00Z" })) },
      { name: "JSON-LD only", page: livePage('<script type="application/ld+json">{"@type":"JobPosting","datePosted":"2024-01-01"}</script>'), api: () => json(ghRow({})) },
      { name: "closed job", page: () => new Response(CLOSED_HTML, { status: 200, headers: { "content-type": "text/html" } }), api: () => json({ status: 404 }, 404) },
      { name: "page 404, Greenhouse lists it (old)", page: () => new Response("<h1>404</h1>", { status: 404, headers: { "content-type": "text/html" } }), api: () => json(ghRow({ first_published: "2025-01-01T00:00:00Z" })) },
    ];
    for (const c of cases) {
      const without = await checkBw(c.page, c.api);
      const withAge = await checkBw(c.page, c.api, { staleAfterDays: 7 });
      assert.equal(without.age, undefined, c.name);
      assert.ok(withAge.age, c.name);
      const { age: _age, ...rest } = withAge;
      assert.deepEqual({ ...rest, signals: rest.signals.filter((s) => s !== AGE_CONFLICT_SIGNAL) }, without, c.name);
    }
    const old = await checkBw(cases[0]!.page, cases[0]!.api, {});
    assert.equal(old.status, "live");
    assert.equal(old.age?.age_bucket, "90+");
    assert.equal(old.age?.stale_age, true);
    const closed = await checkBw(cases[4]!.page, cases[4]!.api, {});
    assert.equal(closed.status, "closed");
    assert.equal(closed.age?.note, undefined);
    // Workday startDate does not lift confidence the way the legacy postedAt does.
    const page = classify(
      {
        requestedUrl: "https://adobe.wd5.myworkdayjobs.com/x/job/y_R1",
        canonicalUrl: "https://adobe.wd5.myworkdayjobs.com/x/job/y_R1",
        httpStatus: 200,
        title: "Owner",
        html: LIVE_HTML(),
        text: "Senior Software Engineer Apply now Submit application",
        redirected: false,
        redirectChain: [],
      },
      NOW,
    );
    assert.equal(page.status, "live");
    const noDate = combinePageAndAts(page, { outcome: "listed", httpStatus: 200 }, "workday");
    const withStart = combinePageAndAts(page, { outcome: "listed", httpStatus: 200, age: { source: "workday.startDate", postedAt: "2020-01-01", precision: "day" } }, "workday");
    assert.equal(withStart.confidence, noDate.confidence);
    assert.equal(withStart.status, noDate.status);
  });

  it("11. no ATS answer or a non-job page: unknown age or none, no crash", async () => {
    const unavailable = await checkBw(livePage(), () => new Response("oops", { status: 503 }), {});
    assert.equal(unavailable.age?.age_source, "none");
    assert.equal(unavailable.age?.age_days, null);
    // Auto mode (POST /v1/verify) on a non-job page adds no age at all.
    const shop = "https://shop.example.com/products/mug";
    const plain = await verifyUrl(shop, async (input) => {
      const url = requestUrl(input);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n");
      return new Response("<html><title>Mug</title><body><button>Add to cart</button></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }, NOW, { atsApi: true, age: { mode: "auto" } });
    assert.equal(plain.age, undefined);
  });

  it("12. output schema, input schema, MCP, and llms.txt describe age", () => {
    const props = VERIFY_OUTPUT_SCHEMA.properties as Record<string, unknown>;
    assert.ok(props.age && props.paid_with && props.credits_remaining);
    assert.equal((VERIFY_OUTPUT_SCHEMA.required as readonly string[]).includes("age"), false, "age stays optional");
    const ageProps = (props.age as { properties: Record<string, unknown> }).properties;
    for (const key of ["posted_at", "age_days", "age_source", "age_precision", "age_bucket", "stale_age", "stale_after_days"]) assert.ok(ageProps[key], key);
    assert.ok((VERIFY_INPUT_SCHEMA.properties as Record<string, unknown>).stale_after_days);
    assert.deepEqual([...VERIFY_INPUT_SCHEMA.required], ["url"]);
    const llms = readFileSync(new URL("../public/llms.txt", import.meta.url), "utf8");
    assert.ok(llms.includes("stale_after_days"));
    assert.ok(llms.includes("never changes status or confidence"));
    assert.ok(readFileSync(new URL("../src/mcp-server.ts", import.meta.url), "utf8").includes("age object"));
    for (const text of [llms, readFileSync(new URL("../README.md", import.meta.url), "utf8")]) {
      assert.equal(/rarely hired|8× better|8x better/i.test(text), false, "no unsupported hiring claims");
    }
  });

  it("13. audit math: buckets over dated rows sum to 100%, undated and 30+ counted apart", () => {
    const at = (days: number | null, status = "live", precision: PostingAge["age_precision"] = days === null ? "unknown" : "day"): AgeAuditRow => ({
      status,
      age: precision === "at_least" ? buildPostingAge({ source: "workday.postedOn_text", precision: "at_least", atLeastDays: 30 }, NOW) : days === null ? buildPostingAge(undefined, NOW) : buildPostingAge({ source: "workday.postedOn_text", precision: "day", daysAgo: days }, NOW),
    });
    const rows = [at(3), at(20), at(31), at(45, "closed"), at(61), at(95, "closed"), at(120), at(null), at(null, "closed"), at(null, "live", "at_least")];
    const s = summarizeAges(rows, { checkedOn: "2026-11-03", board: "Example board" });
    assert.equal(s.sample_size, 10);
    assert.equal(s.dated, 7);
    assert.equal(s.undated, 2);
    assert.equal(s.lower_bound_only, 1);
    assert.equal(s.dated_pct, 70);
    const sum = Object.values(s.buckets).reduce((n, b) => n + b.count, 0);
    assert.equal(sum, 7);
    assert.ok(Math.abs(Object.values(s.buckets).reduce((n, b) => n + b.pct, 0) - 100) < 0.5);
    assert.equal(s.over_30.count, 5);
    assert.equal(s.over_60.count, 3);
    assert.equal(s.over_90.count, 2);
    assert.equal(s.over_90.pct, 28.6);
    assert.equal(s.buckets["31-60"].closed, 1);
    assert.equal(s.buckets["31-60"].closed_pct, 50);
    assert.ok(s.label.includes("2026-11-03") && s.label.includes("10 listings"));
    const empty = summarizeAges([], { checkedOn: "2026-11-03" });
    assert.equal(empty.over_60.pct, 0);
    const csv = ageAuditCsv([{ url: "https://x.example/a,b", ...rows[0]! }]);
    assert.ok(csv.startsWith("url,status,posted_at,age_days"));
    assert.ok(csv.includes('"https://x.example/a,b",live'));
  });
});

describe("posting age over HTTP (test mode)", () => {
  it("POST /v1/verify/job returns age and honors stale_after_days in the body", async () => {
    const { createApp } = await import("../src/app.js");
    const { NETWORK, TEST_MODE_HEADER, TEST_MODE_SECRET_ENV } = await import("../src/config.js");
    const { livePaymentMiddlewareFromServer, resourceServerFromFacilitator } = await import("../src/payments.js");
    const { initPaidCallStore, closePaidCallStore } = await import("../src/paid-call-store.js");
    const facilitator = {
      async getSupported() {
        return { kinds: [{ x402Version: 2, scheme: "exact", network: NETWORK }], extensions: [], signers: {} };
      },
      async verify() {
        return { isValid: true };
      },
      async settle() {
        return { success: true, transaction: "0xsettle", network: NETWORK, payer: "0xb782000000000000000000000000000000000001" };
      },
    };
    const originalFetch = globalThis.fetch;
    const originalLog = console.log;
    initPaidCallStore(":memory:");
    process.env[TEST_MODE_SECRET_ENV] = "age-test-secret";
    clearAtsResponseCache();
    globalThis.fetch = routes(livePage(), () => json(ghRow({ first_published: "2026-09-25T07:30:49Z" })));
    console.log = () => undefined;
    try {
      const app = createApp(
        livePaymentMiddlewareFromServer(resourceServerFromFacilitator(facilitator as never), "0x2222222222222222222222222222222222222222"),
      );
      const res = await app.request("/v1/verify/job", {
        method: "POST",
        headers: { "content-type": "application/json", [TEST_MODE_HEADER]: "age-test-secret" },
        body: JSON.stringify({ url: BITWARDEN, stale_after_days: 30 }),
      });
      const body = (await res.json()) as { status: string; age?: PostingAge };
      assert.equal(res.status, 200);
      assert.equal(body.status, "live");
      assert.equal(body.age?.age_source, "greenhouse.first_published");
      assert.equal(body.age?.stale_after_days, 30);
      assert.equal(body.age?.stale_age, true);
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
      delete process.env[TEST_MODE_SECRET_ENV];
      closePaidCallStore();
    }
  });
});
