import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ATS_API_LISTED,
  ATS_LISTED_CONFIDENCE,
  ATS_LISTED_WITH_POSTED_AT_CONFIDENCE,
  parseAtsJobUrl,
} from "../src/ats-api.js";
import { clearAtsResponseCache } from "../src/ats-cache.js";
import { roleRefFor } from "../src/free-job-role.js";
import { verifyUrl } from "../src/verify.js";

// Nov 3, 2026 (VentureLoop audit): Budderfly's gh_jid careers page served a
// bot check while Greenhouse listed the job → live 0.97. Workable served the
// same kind of bot check and has no posting API → can't tell. Craig: a bot
// check plus the job system still listing the job gets one answer on every
// job system: the listing decides (live at 0.97 with a posted date, 0.96
// without). The page is never bypassed and challenge_page stays in signals.

const NOW = new Date("2026-11-03T18:00:00Z");
const CF_WALL = `<!doctype html><html><head><title>Just a moment...</title></head><body><div class="cf-challenge">Checking your browser before accessing. Verify you are human.</div></body></html>`;
const HUMAN_WALL = `<!doctype html><html><head><title>Security check</title></head><body><p>Please verify you are human to continue.</p></body></html>`;

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

type Case = { system: string; url: string; listed: unknown; dated: boolean };

const CASES: Case[] = [
  {
    system: "Greenhouse board (job-boards.greenhouse.io)",
    url: "https://job-boards.greenhouse.io/acme/jobs/4726518006",
    listed: { id: 4726518006, title: "HVAC Quality Control Specialist", first_published: "2026-11-02T20:00:54Z" },
    dated: true,
  },
  {
    system: "Greenhouse gh_jid company embed (Budderfly)",
    url: "https://www.budderfly.com/open-positions/?gh_jid=4726518006",
    listed: { id: 4726518006, title: "HVAC Quality Control Specialist", first_published: "2026-11-02T20:00:54Z" },
    dated: true,
  },
  {
    system: "Lever",
    url: "https://jobs.lever.co/palantir/16a1b500-13fe-4c22-ad89-372093b462da",
    listed: { id: "16a1b500-13fe-4c22-ad89-372093b462da", text: "Engineer", createdAt: Date.parse("2026-10-20T00:00:00Z") },
    dated: true,
  },
  {
    system: "Ashby",
    url: "https://jobs.ashbyhq.com/linear/d3bc1ced-3ce4-4086-a050-555055dbb1ff",
    listed: { data: { jobPosting: { id: "d3bc1ced-3ce4-4086-a050-555055dbb1ff", title: "Engineer" } } },
    dated: false,
  },
  {
    system: "Workday",
    url: "https://adobe.wd5.myworkdayjobs.com/en-US/external_experienced/job/San-Jose/Sr-Technology-Compliance-Product-Owner_R172124",
    listed: { jobPostingInfo: { title: "Sr Technology Compliance Product Owner", postedOn: "Posted Yesterday" } },
    dated: false,
  },
];

async function check(url: string, wall: string, wallStatus: number, api?: { body: unknown; status?: number }) {
  clearAtsResponseCache();
  const ref = parseAtsJobUrl(url) ?? roleRefFor(url);
  const fetcher: typeof fetch = async (input) => {
    const requested = requestUrl(input);
    if (requested.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /\n", { status: 200 });
    if (ref && api && requested === ref.apiUrl.split("#")[0]) {
      return new Response(JSON.stringify(api.body), { status: api.status ?? 200, headers: { "content-type": "application/json" } });
    }
    if (requested === url) return new Response(wall, { status: wallStatus, headers: { "content-type": "text/html" } });
    throw new Error(`unexpected ${requested}`);
  };
  return verifyUrl(url, fetcher, NOW, { atsApi: true, robotsMode: "strict" });
}

describe("bot check + the job system still lists the job: one answer on every job system", () => {
  for (const c of CASES) {
    it(`${c.system}: live at API-listed confidence, challenge_page kept`, async () => {
      for (const [wall, status] of [
        [CF_WALL, 200],
        [CF_WALL, 403],
        [HUMAN_WALL, 503],
      ] as const) {
        const verdict = await check(c.url, wall, status, { body: c.listed });
        const label = `${c.system} / HTTP ${status}`;
        assert.equal(verdict.status, "live", label);
        assert.equal(verdict.confidence, c.dated ? ATS_LISTED_WITH_POSTED_AT_CONFIDENCE : ATS_LISTED_CONFIDENCE, label);
        assert.ok(verdict.signals.includes(ATS_API_LISTED), label);
        assert.ok(verdict.signals.includes("challenge_page"), label);
      }
    });
  }

  it("Workable (no posting API): the same bot check stays can't tell", async () => {
    const verdict = await check("https://apply.workable.com/j/16C68A50A7", CF_WALL, 200);
    assert.equal(verdict.status, "unknown");
    assert.ok(verdict.signals.includes("challenge_page"));
    assert.equal(verdict.signals.includes(ATS_API_LISTED), false);
  });

  it("bot check + the job system's API also unreachable stays can't tell on every system", async () => {
    for (const c of CASES) {
      const verdict = await check(c.url, CF_WALL, 200, { body: { error: "busy" }, status: 503 });
      assert.equal(verdict.status, "unknown", c.system);
      assert.ok(verdict.signals.includes("challenge_page"), c.system);
    }
  });
});
