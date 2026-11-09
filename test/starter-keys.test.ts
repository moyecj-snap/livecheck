import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import {
  apiKeyDb,
  deleteExpiredStarterKeys,
  deleteStarterKeyRecord,
  markStarterKeyInternal,
  issueStarterKey,
  migrateApiKeyStore,
  listFollowups,
  listStarterKeys,
  markFollowupDrafted,
  queryStarterKeySourceBuckets,
  queryStarterKeyStats,
  reserveStarterCall,
  revokeStarterKey,
  setStarterKeySetting,
  starterKeyLimits,
  starterKeySourceReport,
  finishStarterCall,
  githubTooYoungMessage,
} from "../src/api-key-store.js";
import {
  resetCheckSlotsForTests,
  setCheckConcurrencyForTests,
  setCheckQueueMaxForTests,
} from "../src/check-capacity.js";
import { CHECK_TIMEOUT_SIGNAL, TEST_MODE_HEADER, TEST_MODE_SECRET_ENV } from "../src/config.js";
import { FIXTURES } from "../src/fixtures.js";
import { PAID_CALL_EVENT } from "../src/paid-call.js";
import { upsertLaunchUtmTagIn } from "../src/free-job-sources.js";
import { closeFreePageStore, freePageDbForTests, initFreePageStore } from "../src/free-job-store.js";
import { FREE_PAGE_STATS_TOKEN_ENV, setFreeJobClockForTests } from "../src/free-job-page.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";
import { setGithubFetchForTests, signStarterOauthCookieForTests, STARTER_OAUTH_COOKIE } from "../src/starter-key-page.js";
import {
  GITHUB_OAUTH_CLIENT_ID_ENV,
  GITHUB_OAUTH_CLIENT_SECRET_ENV,
  EMERGENCY_STOP_MESSAGE,
  OUT_OF_CHECKS_MESSAGE,
  STARTER_KEY_CONTACT_EMAIL,
  STARTER_KEY_CONTACT_LABEL,
  STARTER_KEY_PRIVACY_LINE,
  STARTER_SOURCE_ON_KEY_ROW,
  STARTER_SOURCE_STATS_PUBLIC,
  WIND_DOWN_MESSAGE,
  BOARD_URL_SHAPE_MESSAGE,
  cardFundedPayer,
  classifyStarterSpend,
  isBoardUrlShape,
  githubAccountTooYoung,
  hashStarterKey,
  isoStamp,
  setStarterKeyClockForTests,
} from "../src/starter-key.js";
import { buildStatsDocument, statsHtml } from "../src/stats.js";

const execFileAsync = promisify(execFile);
const CLIENT_ID = "iv1.client";
const CLIENT_SECRET = "oauth-secret-for-tests";
const LIVE_HTML = "<!doctype html><title>Apply now</title><body><a href=\"/apply\">Apply now</a></body>";
const LOGIN_HTML =
  "<!doctype html><title>Sign in</title><body><p>Please sign in to continue. This private page is not a job posting and has no apply button.</p></body>";
const GONE_HTML = "<!doctype html><title>Not found</title><body>missing</body>";

function db() {
  const database = apiKeyDb();
  assert.ok(database);
  return database;
}

function issue(partial: { githubId?: string; login?: string; ip?: string; optIn?: boolean; createdAt?: string; source?: string } = {}) {
  const now = new Date("2026-10-30T12:00:00Z");
  const result = issueStarterKey(
    db(),
    {
      githubId: partial.githubId ?? "1001",
      githubLogin: partial.login ?? "octocat",
      accountCreatedAt: partial.createdAt ?? "2020-01-01T00:00:00Z",
      contactOptIn: partial.optIn ?? false,
      ipSubject: partial.ip ?? "ip:unit",
      ...(partial.source !== undefined ? { source: partial.source } : {}),
    },
    now,
  );
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("issue failed");
  return result;
}

describe("starter key rules", () => {
  it("charges a real answer, including a board found after fetch, and not errors or timeouts", () => {
    assert.deepEqual(classifyStarterSpend(200, { status: "live", signals: ["apply form present"], http_status: 200 }), {
      charge: true,
      blocked: false,
    });
    assert.deepEqual(classifyStarterSpend(200, { status: "closed", signals: ["http_404"], http_status: 404 }), {
      charge: true,
      blocked: false,
    });
    assert.deepEqual(classifyStarterSpend(200, { status: "unknown", signals: ["ambiguous_html"], http_status: 200 }), {
      charge: true,
      blocked: false,
    });
    assert.deepEqual(
      classifyStarterSpend(200, { status: "unknown", signals: ["not_a_specific_posting"], http_status: 200 }),
      { charge: true, blocked: false },
    );
    assert.deepEqual(
      classifyStarterSpend(200, { status: "unknown", signals: ["collection_or_category", "challenge_page"], http_status: 200 }),
      { charge: true, blocked: true },
    );
    assert.deepEqual(
      classifyStarterSpend(200, { status: "unknown", signals: [CHECK_TIMEOUT_SIGNAL], http_status: 0 }),
      { charge: false, blocked: false },
    );
    assert.deepEqual(classifyStarterSpend(502, { error: "Could not fetch URL" }), { charge: false, blocked: false });
    assert.deepEqual(classifyStarterSpend(400, { error: "bad" }), { charge: false, blocked: false });
    assert.deepEqual(classifyStarterSpend(429, { error: "rate_limited" }), { charge: false, blocked: false });
    assert.equal(
      classifyStarterSpend(200, { status: "unknown", signals: ["loginwalled"], http_status: 200 }).blocked,
      true,
    );
    assert.equal(classifyStarterSpend(200, { status: "unknown", signals: ["loginwalled"], http_status: 200 }).charge, true);
  });

  it("does not charge a robots.txt can't-tell: the page was never requested", () => {
    assert.deepEqual(classifyStarterSpend(200, { status: "unknown", signals: ["robots_disallowed"], http_status: 0 }), {
      charge: false,
      blocked: false,
    });
    // Strict mode (PR #62) is for audits, not the key path, but must never charge either.
    assert.deepEqual(classifyStarterSpend(200, { status: "unknown", signals: ["robots_unavailable"], http_status: 0 }), {
      charge: false,
      blocked: false,
    });
  });

  it("uses the paid-route board rule, including a bare Workday site", () => {
    assert.equal(isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/External"), true);
    assert.equal(isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/en-US/External"), true);
    assert.equal(isBoardUrlShape("https://acme.wd5.myworkdayjobs.com/External/job/Remote/Engineer_R123"), false);
    assert.equal(isBoardUrlShape("https://example.com/jobs"), true);
    assert.equal(isBoardUrlShape("https://example.com/jobs/12345"), false);
  });

  it("sees a Greenhouse, Lever, or Ashby board from the URL, and not a posting id", () => {
    assert.equal(isBoardUrlShape("https://boards.greenhouse.io/acme"), true);
    assert.equal(isBoardUrlShape("https://job-boards.greenhouse.io/figma"), true);
    assert.equal(isBoardUrlShape("https://boards.greenhouse.io/acme/jobs/1842"), false);
    assert.equal(isBoardUrlShape("https://jobs.lever.co/figma"), true);
    assert.equal(isBoardUrlShape("https://jobs.lever.co/figma/01234567-89ab-cdef-0123-456789abcdef"), false);
    assert.equal(isBoardUrlShape("https://jobs.ashbyhq.com/notion"), true);
    assert.equal(isBoardUrlShape("https://jobs.ashbyhq.com/notion/01234567-89ab-cdef-0123-456789abcdef"), false);
    assert.equal(isBoardUrlShape("https://example.com/careers"), true);
    assert.equal(isBoardUrlShape("https://example.com/careers?gh_jid=1842"), false);
    assert.equal(isBoardUrlShape("https://example.com/company/about"), false);
  });

  it("treats a GitHub account under 7 days as too young, and exactly 7 days as old enough", () => {
    const now = new Date("2026-10-30T12:00:00Z");
    assert.equal(githubAccountTooYoung("2026-10-29T12:00:00Z", now), true);
    assert.equal(githubAccountTooYoung("not-a-date", now), true);
    assert.equal(githubAccountTooYoung(isoStamp(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)), now), false);
    assert.equal(githubAccountTooYoung("2020-01-01T00:00:00Z", now), false);
  });

  it("builds a pseudonymous card payer and refuses anything else", () => {
    assert.equal(cardFundedPayer("k_0123456789abcdef"), "key:k_0123456789abcdef");
    assert.throws(() => cardFundedPayer("octocat@example.com"));
    assert.throws(() => cardFundedPayer("k_short"));
  });
});

describe("starter key store", () => {
  const now = new Date("2026-10-30T12:00:00Z");

  before(() => {
    initPaidCallStore(":memory:");
  });
  after(() => {
    closePaidCallStore();
  });
  beforeEach(() => {
    setStarterKeySetting(db(), "emergency_stop", 0, now);
    setStarterKeySetting(db(), "wind_down", 0, now);
  });

  it("stores the hash, username, and id, and not the secret, email, or account birth date", () => {
    const issued = issue({ createdAt: "2019-11-14T00:00:00Z" });
    const rows = db().prepare("SELECT * FROM api_keys").all() as Array<Record<string, unknown>>;
    const dump = JSON.stringify(rows);
    assert.equal(dump.includes(issued.plaintext), false);
    assert.equal(dump.includes("2019-11-14"), false);
    assert.equal(dump.includes("email"), false);
    assert.equal(rows[0]?.key_sha256, hashStarterKey(issued.plaintext));
    assert.equal(rows[0]?.github_login, "octocat");
    assert.equal(rows[0]?.github_id, "1001");
    assert.equal(rows[0]?.contact_opt_in, 0);
    assert.equal(rows[0]?.paid_left, 0);
    assert.equal(rows[0]?.free_allowance, 200);
    const columns = (db().prepare("PRAGMA table_info(api_keys)").all() as Array<{ name: string }>).map((col) => col.name);
    for (const forbidden of ["email", "url", "ip", "token", "plaintext", "source"]) {
      assert.equal(columns.includes(forbidden), false, forbidden);
    }
  });

  it("issues one key per GitHub account and keeps an opt-in that was checked", () => {
    const first = issue({ githubId: "2002", login: "ada", optIn: true, ip: "ip:ada" });
    const again = issueStarterKey(
      db(),
      {
        githubId: "2002",
        githubLogin: "ada",
        accountCreatedAt: "2020-01-01T00:00:00Z",
        contactOptIn: false,
        ipSubject: "ip:ada",
      },
      now,
    );
    assert.equal(again.ok, false);
    if (!again.ok) assert.equal(again.error, "already_issued");
    assert.equal(listStarterKeys(db()).filter((row) => row.github_id === "2002").length, 1);
    assert.equal(listStarterKeys(db()).find((row) => row.id === first.id)?.contact_opt_in, 1);
  });

  it("refuses an account under 7 days and does not count it as issued", () => {
    const young = issueStarterKey(
      db(),
      {
        githubId: "3003",
        githubLogin: "newbie",
        accountCreatedAt: "2026-10-28T12:00:00Z",
        contactOptIn: false,
        ipSubject: "ip:young",
      },
      now,
    );
    assert.equal(young.ok, false);
    if (!young.ok) assert.equal(young.error, "account_too_young");
    assert.equal(listStarterKeys(db()).some((row) => row.github_id === "3003"), false);
  });

  it("caps new keys at 3 per IP subject and 50 per day", () => {
    setStarterKeySetting(db(), "issuance_per_ip", 3, now);
    for (let n = 0; n < 3; n++) {
      const result = issueStarterKey(
        db(),
        {
          githubId: String(4000 + n),
          githubLogin: `ipuser${n}`,
          accountCreatedAt: "2020-01-01T00:00:00Z",
          contactOptIn: false,
          ipSubject: "ip:same",
        },
        now,
      );
      assert.equal(result.ok, true, String(n));
    }
    const blocked = issueStarterKey(
      db(),
      {
        githubId: "4009",
        githubLogin: "ipuser9",
        accountCreatedAt: "2020-01-01T00:00:00Z",
        contactOptIn: false,
        ipSubject: "ip:same",
      },
      now,
    );
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error, "ip_limited");
    setStarterKeySetting(db(), "issuance_per_day", 0, now);
    const global = issueStarterKey(
      db(),
      {
        githubId: "4010",
        githubLogin: "otherip",
        accountCreatedAt: "2020-01-01T00:00:00Z",
        contactOptIn: false,
        ipSubject: "ip:other",
      },
      now,
    );
    assert.equal(global.ok, false);
    if (!global.ok) assert.equal(global.error, "global_limited");
    setStarterKeySetting(db(), "issuance_per_day", 50, now);
    setStarterKeySetting(db(), "issuance_per_ip", 3, now);
  });

  it("copies the free allowance onto the key and does not rewrite it later", () => {
    setStarterKeySetting(db(), "free_allowance", 5, now);
    const issued = issue({ githubId: "5005", login: "five", ip: "ip:five" });
    setStarterKeySetting(db(), "free_allowance", 200, now);
    const row = listStarterKeys(db()).find((item) => item.id === issued.id);
    assert.equal(row?.free_allowance, 5);
  });

  it("suspends after more than half of an hour's outcomes are blocked, once the sample floor is met", () => {
    setStarterKeySetting(db(), "abuse_min_samples", 2, now);
    const issued = issue({ githubId: "6006", login: "scanner", ip: "ip:scan" });
    const first = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    finishStarterCall(db(), first.key.id, { charge: true, blocked: false }, now);
    const second = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    finishStarterCall(db(), second.key.id, { charge: true, blocked: true }, now);
    assert.equal(listStarterKeys(db()).find((row) => row.id === issued.id)?.status, "active");
    const third = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(third.ok, true);
    if (!third.ok) return;
    finishStarterCall(db(), third.key.id, { charge: true, blocked: true }, now);
    assert.equal(listStarterKeys(db()).find((row) => row.id === issued.id)?.status, "suspended");
    const blocked = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.error, "starter_key_suspended");
  });

  it("revokes on the next call and deletes a key 90 days after it expires", () => {
    const issued = issue({ githubId: "7007", login: "gone", ip: "ip:gone" });
    const revoked = revokeStarterKey(db(), issued.id, now);
    assert.equal(revoked?.status, "revoked");
    const denied = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(denied.ok, false);
    if (!denied.ok) assert.equal(denied.status, 401);
    db()
      .prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`)
      .run(isoStamp(new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000 - 1000)), issued.id);
    const kept = issue({ githubId: "7008", login: "kept", ip: "ip:kept" });
    db()
      .prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`)
      .run(isoStamp(new Date(now.getTime() - 89 * 24 * 60 * 60 * 1000)), kept.id);
    assert.equal(deleteExpiredStarterKeys(db(), now), 1);
    assert.equal(listStarterKeys(db()).some((row) => row.id === issued.id), false);
    assert.equal(listStarterKeys(db()).some((row) => row.id === kept.id), true);
  });

  it("lists an opted-in key for a 7-day draft and marks it once", () => {
    const issued = issue({ githubId: "8008", login: "builder", ip: "ip:builder", optIn: true });
    assert.equal(listFollowups(db(), now).some((row) => row.id === issued.id), false);
    const later = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    const due = listFollowups(db(), later);
    assert.equal(due.some((row) => row.id === issued.id && row.github_login === "builder"), true);
    assert.equal(markFollowupDrafted(db(), issued.id, later), true);
    assert.equal(listFollowups(db(), later).some((row) => row.id === issued.id), false);
  });

  it("emergency stop and wind-down are independent, and emergency stop wins", () => {
    const live = issue({ githubId: "9101", login: "livekey", ip: "ip:swlive" });
    const expired = issue({ githubId: "9102", login: "oldkey", ip: "ip:swold" });
    db()
      .prepare(`UPDATE api_keys SET expires_at = ? WHERE id = ?`)
      .run(isoStamp(new Date(now.getTime() - 1000)), expired.id);
    const issueNew = (id: string) =>
      issueStarterKey(
        db(),
        {
          githubId: id,
          githubLogin: `n${id}`,
          accountCreatedAt: "2020-01-01T00:00:00Z",
          contactOptIn: false,
          ipSubject: `ip:${id}`,
        },
        now,
      );
    const use = (token: string) => {
      const result = reserveStarterCall(db(), token, now);
      if (result.ok) finishStarterCall(db(), result.key.id, { charge: false, blocked: false }, now);
      return result;
    };
    try {
      setStarterKeySetting(db(), "emergency_stop", 0, now);
      setStarterKeySetting(db(), "wind_down", 0, now);
      assert.equal(issueNew("9110").ok, true);
      assert.equal(use(live.plaintext).ok, true);
      const openExpired = use(expired.plaintext);
      assert.equal(openExpired.ok, false);
      if (!openExpired.ok) assert.equal(openExpired.error, "starter_key_expired");

      setStarterKeySetting(db(), "emergency_stop", 1, now);
      const emergencyIssue = issueNew("9111");
      assert.equal(emergencyIssue.ok, false);
      if (!emergencyIssue.ok) assert.equal(emergencyIssue.error, "emergency_stop");
      const emergencyUse = use(live.plaintext);
      assert.equal(emergencyUse.ok, false);
      if (!emergencyUse.ok) assert.equal(emergencyUse.error, "starter_keys_emergency_stop");
      const emergencyExpired = use(expired.plaintext);
      assert.equal(emergencyExpired.ok, false);
      if (!emergencyExpired.ok) assert.equal(emergencyExpired.error, "starter_keys_emergency_stop");

      setStarterKeySetting(db(), "emergency_stop", 0, now);
      setStarterKeySetting(db(), "wind_down", 1, now);
      const windIssue = issueNew("9112");
      assert.equal(windIssue.ok, false);
      if (!windIssue.ok) {
        assert.equal(windIssue.error, "wind_down");
        assert.equal(windIssue.message, WIND_DOWN_MESSAGE);
      }
      assert.equal(use(live.plaintext).ok, true);
      const windExpired = use(expired.plaintext);
      assert.equal(windExpired.ok, false);
      if (!windExpired.ok) assert.equal(windExpired.error, "starter_key_expired");

      setStarterKeySetting(db(), "emergency_stop", 1, now);
      const bothIssue = issueNew("9113");
      assert.equal(bothIssue.ok, false);
      if (!bothIssue.ok) {
        assert.equal(bothIssue.error, "emergency_stop");
        assert.equal(bothIssue.message, EMERGENCY_STOP_MESSAGE);
      }
      const bothUse = use(live.plaintext);
      assert.equal(bothUse.ok, false);
      if (!bothUse.ok) assert.equal(bothUse.error, "starter_keys_emergency_stop");
      const bothExpired = use(expired.plaintext);
      assert.equal(bothExpired.ok, false);
      if (!bothExpired.ok) assert.equal(bothExpired.error, "starter_keys_emergency_stop");
    } finally {
      setStarterKeySetting(db(), "emergency_stop", 0, now);
      setStarterKeySetting(db(), "wind_down", 0, now);
    }
  });

  it("hits the global cap without raising it", () => {
    const capNow = new Date("2026-11-02T12:00:00Z");
    setStarterKeySetting(db(), "daily_check_cap", 1, capNow);
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      const first = issue({ githubId: "9001", login: "cap1", ip: "ip:cap1" });
      const second = issue({ githubId: "9002", login: "cap2", ip: "ip:cap2" });
      const admitted = reserveStarterCall(db(), first.plaintext, capNow);
      assert.equal(admitted.ok, true);
      if (!admitted.ok) return;
      finishStarterCall(db(), admitted.key.id, { charge: true, blocked: false }, capNow);
      const denied = reserveStarterCall(db(), second.plaintext, capNow);
      assert.equal(denied.ok, false);
      if (!denied.ok) {
        assert.equal(denied.error, "starter_keys_daily_cap");
        assert.match(denied.message, /1 checks a day/);
      }
      assert.equal(starterKeyLimits(db()).dailyCheckCap, 1);
      assert.equal(queryStarterKeyStats(db(), capNow).daily_cap_hit, true);
      assert.equal(queryStarterKeyStats(db(), capNow).daily_cap, 1);
      assert.ok(warnings.some((line) => line.includes("DAILY CAP HIT") && line.includes("not raised")));
    } finally {
      console.warn = original;
      setStarterKeySetting(db(), "daily_check_cap", 2000, capNow);
    }
  });

  it("turns an old enabled 0 row into emergency_stop without a restart", () => {
    const database = db();
    database.exec("DROP TABLE api_key_settings");
    database.exec(`CREATE TABLE api_key_settings (
      key TEXT PRIMARY KEY CHECK (key IN ('enabled', 'daily_check_cap')),
      value INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    database
      .prepare(`INSERT INTO api_key_settings (key, value, updated_at) VALUES ('enabled', 0, '2026-10-30T00:00:00Z')`)
      .run();
    database
      .prepare(`INSERT INTO api_key_settings (key, value, updated_at) VALUES ('daily_check_cap', 1500, '2026-10-30T00:00:00Z')`)
      .run();
    migrateApiKeyStore(database);
    const limits = starterKeyLimits(database);
    assert.equal(limits.emergencyStop, true);
    assert.equal(limits.windDown, false);
    assert.equal(limits.dailyCheckCap, 1500);
    setStarterKeySetting(database, "emergency_stop", 0, now);
    setStarterKeySetting(database, "daily_check_cap", 2000, now);
  });
  it("an internal test key leaves every starter-key stat and the follow-up list, and works until revoked", () => {
    const before = queryStarterKeyStats(db(), now);
    const issued = issue({ githubId: "4242", login: "PyGuy2", ip: "ip:pyguy2", optIn: true });
    for (let i = 0; i < 20; i += 1) {
      const call = reserveStarterCall(db(), issued.plaintext, now);
      assert.equal(call.ok, true);
      if (!call.ok) return;
      finishStarterCall(db(), call.key.id, { charge: true, blocked: false }, now);
    }
    const counted = queryStarterKeyStats(db(), now);
    for (const window of ["l7d", "l30d"] as const) {
      assert.equal(counted[window].issued, before[window].issued + 1);
      assert.equal(counted[window].activated, before[window].activated + 1);
      assert.equal(counted[window].reached_20, before[window].reached_20 + 1);
      assert.equal(counted[window].free_checks, before[window].free_checks + 20);
    }
    const weekLater = new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000);
    assert.equal(listFollowups(db(), weekLater).some((row) => row.id === issued.id), true);

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      const marked = markStarterKeyInternal(db(), "@pyguy2", now);
      assert.equal(marked?.id, issued.id);
      assert.equal(marked?.internal, 1);
    } finally {
      console.log = original;
    }
    assert.equal(logs.some((line) => line.includes(`marked internal id=${issued.id}`)), true);
    assert.equal(logs.join("\n").includes(issued.plaintext), false);
    assert.equal(logs.join("\n").includes(hashStarterKey(issued.plaintext)), false);

    const excluded = queryStarterKeyStats(db(), now);
    assert.equal(excluded.internal_keys_excluded, before.internal_keys_excluded + 1);
    for (const window of ["l7d", "l30d"] as const) {
      assert.deepEqual(excluded[window], before[window], window);
    }
    assert.equal(listFollowups(db(), weekLater).some((row) => row.id === issued.id), false);
    const doc = buildStatsDocument(now);
    assert.deepEqual(doc.starter_keys.l7d, excluded.l7d);
    assert.match(statsHtml(doc), /Excludes \d+ internal test key/);

    const stillWorks = reserveStarterCall(db(), issued.plaintext, now);
    assert.equal(stillWorks.ok, true);
    if (stillWorks.ok) finishStarterCall(db(), stillWorks.key.id, { charge: true, blocked: false }, now);
    assert.deepEqual(queryStarterKeyStats(db(), now).l7d, before.l7d);

    assert.equal(revokeStarterKey(db(), "PyGuy2", now)?.status, "revoked");
    assert.equal(reserveStarterCall(db(), issued.plaintext, now).ok, false);
    assert.deepEqual(queryStarterKeyStats(db(), now).l7d, before.l7d);
  });

  it("admin delete removes the record and its per-key counts so the same GitHub account can get a fresh key", () => {
    const first = issue({ githubId: "4343", login: "craig-main", ip: "ip:craig-main" });
    const call = reserveStarterCall(db(), first.plaintext, now);
    assert.equal(call.ok, true);
    if (call.ok) finishStarterCall(db(), call.key.id, { charge: true, blocked: false }, now);
    const again = issueStarterKey(
      db(),
      { githubId: "4343", githubLogin: "craig-main", accountCreatedAt: "2020-01-01T00:00:00Z", contactOptIn: false, ipSubject: "ip:craig-main" },
      now,
    );
    assert.equal(again.ok, false, "one key per GitHub account while the record exists");

    const logs: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    let gone: ReturnType<typeof deleteStarterKeyRecord>;
    try {
      gone = deleteStarterKeyRecord(db(), "@Craig-Main", now);
    } finally {
      console.log = original;
    }
    assert.deepEqual(gone, { id: first.id, github_login: "craig-main", github_id: "4343" });
    const line = logs.find((entry) => entry.includes("admin deleted"));
    assert.ok(line);
    assert.match(line, new RegExp(`id=${first.id} login=@craig-main github:4343`));
    assert.match(line, /overrides 90-day retention/);
    assert.equal(logs.join("\n").includes(first.plaintext), false);
    assert.equal(logs.join("\n").includes(hashStarterKey(first.plaintext)), false);
    for (const table of ["api_keys", "api_key_daily", "api_key_minute", "api_key_hour", "api_key_issue_source"]) {
      const column = table === "api_keys" ? "id" : "key_id";
      const row = db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`).get(first.id) as { n: number };
      assert.equal(Number(row.n), 0, table);
    }
    assert.equal(reserveStarterCall(db(), first.plaintext, now).ok, false, "the old key no longer works");
    assert.equal(deleteStarterKeyRecord(db(), "craig-main", now), undefined);

    const fresh = issueStarterKey(
      db(),
      { githubId: "4343", githubLogin: "craig-main", accountCreatedAt: "2020-01-01T00:00:00Z", contactOptIn: false, ipSubject: "ip:craig-main-2" },
      now,
    );
    assert.equal(fresh.ok, true);
    if (fresh.ok) {
      assert.notEqual(fresh.id, first.id);
      assert.notEqual(fresh.plaintext, first.plaintext);
      assert.equal(listStarterKeys(db()).find((row) => row.id === fresh.id)?.free_used, 0);
    }
  });

  it("adds the internal column to a key table made before keys:mark-internal", () => {
    const old = new DatabaseSync(":memory:");
    old.exec(`CREATE TABLE api_keys (
      id TEXT PRIMARY KEY, key_sha256 TEXT NOT NULL UNIQUE, github_id TEXT NOT NULL UNIQUE, github_login TEXT NOT NULL,
      contact_opt_in INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
      free_allowance INTEGER NOT NULL, free_used INTEGER NOT NULL DEFAULT 0, paid_left INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', suspended_reason TEXT, followup_drafted_at TEXT)`);
    old.exec(`INSERT INTO api_keys (id, key_sha256, github_id, github_login, created_at, expires_at, free_allowance)
      VALUES ('k_old', 'h', '1', 'old', '2026-10-30T12:00:00Z', '2027-01-28T12:00:00Z', 200)`);
    migrateApiKeyStore(old);
    migrateApiKeyStore(old);
    assert.equal(listStarterKeys(old)[0]?.internal, 0);
    assert.equal(markStarterKeyInternal(old, "old", now)?.internal, 1);
    old.close();
  });
});

describe("starter key HTTP", () => {
  const originalFetch = globalThis.fetch;
  let logs: string[] = [];
  const originalLog = console.log;

  before(() => {
    initPaidCallStore(":memory:");
  });
  after(() => {
    closePaidCallStore();
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  });
  beforeEach(() => {
    process.env[GITHUB_OAUTH_CLIENT_ID_ENV] = CLIENT_ID;
    process.env[GITHUB_OAUTH_CLIENT_SECRET_ENV] = CLIENT_SECRET;
    delete process.env[TEST_MODE_SECRET_ENV];
    setStarterKeySetting(db(), "emergency_stop", 0);
    setStarterKeySetting(db(), "wind_down", 0);
    delete process.env.LIVECHECK_PUBLIC_URL;
    setGithubFetchForTests(null);
    setStarterKeyClockForTests(null);
    setCheckConcurrencyForTests(null);
    setCheckQueueMaxForTests(null);
    resetCheckSlotsForTests();
    logs = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    setGithubFetchForTests(null);
    setStarterKeyClockForTests(null);
    setCheckConcurrencyForTests(null);
    setCheckQueueMaxForTests(null);
    resetCheckSlotsForTests();
    delete process.env[TEST_MODE_SECRET_ENV];
  });

  it("shows the privacy line and an unchecked contact box", async () => {
    const app = createApp();
    const res = await app.request("/keys");
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /We store your GitHub username to run your key\. Nothing is shared\./);
    assert.equal(html.includes(STARTER_KEY_PRIVACY_LINE), true);
    assert.match(html, /OK to contact me about my experience/);
    assert.equal(html.includes(STARTER_KEY_CONTACT_LABEL), true);
    assert.match(html, /<input type="checkbox" name="contact" value="yes">/);
    assert.doesNotMatch(html, /name="contact"[^>]*checked/);
  });

  it("shows the approved /keys copy, with the 7-day rule above the sign-in button", async () => {
    const app = createApp();
    const html = await (await app.request("/keys")).text();
    assert.equal(html.includes("200 free checks over 30 days, no wallet needed."), true);
    assert.equal(html.includes("Other Livecheck tools still need a wallet."), true);
    assert.doesNotMatch(html, /stay on a wallet/);
    assert.doesNotMatch(html, /200 checks over 30 days/);
    const rule = html.indexOf("<p>Accounts under 7 days old cannot get a key.</p>");
    assert.ok(rule > 0);
    assert.ok(rule < html.indexOf("Continue with GitHub"));
    assert.equal(html.split("Accounts under 7 days old").length - 1, 1);
  });

  it("formats the young-account rejection with created_at + 7 days (UTC)", () => {
    assert.equal(
      githubTooYoungMessage("2026-11-04T18:00:00Z"),
      "Your GitHub account must be at least 7 days old. Try again after November 11, 2026.",
    );
    assert.equal(githubTooYoungMessage("2026-12-28T23:59:00Z"), "Your GitHub account must be at least 7 days old. Try again after January 4, 2027.");
  });

  it("lets the /keys form hand off to GitHub (CSP form-action allows github.com)", async () => {
    // Chrome enforces form-action on the redirect after POST /keys/start, so
    // form-action 'self' alone silently blocks the GitHub sign-in (Nov 2 local dry run).
    const app = createApp();
    const res = await app.request("/keys");
    const csp = res.headers.get("content-security-policy") ?? "";
    const formAction = csp.split(";").map((d) => d.trim()).find((d) => d.startsWith("form-action")) ?? "";
    assert.match(formAction, /'self'/);
    assert.match(formAction, /https:\/\/github\.com(\s|$)/);
    assert.match(csp, /default-src 'none'/);
  });

  it("issues one key from GitHub's public profile and never stores the email", async () => {
    const app = createApp();
    const issued = await signIn(app, { id: 42, login: "octocat", created_at: "2019-11-14T00:00:00Z" }, { contact: false });
    assert.match(issued.html, /lc_live_/);
    assert.equal(issued.html.includes("Copy this now. It's shown only once."), true);
    assert.doesNotMatch(issued.html, /only time the key is shown/);
    assert.ok(issued.html.indexOf("Copy this now.") < issued.html.indexOf("lc_live_"));
    assert.match(issued.html, /We store your GitHub username to run your key\. Nothing is shared\./);
    assert.equal(issued.authorize.includes("user%3Aemail") || issued.authorize.includes("user:email"), false);
    assert.equal(new URL(issued.authorize).searchParams.get("scope"), null);
    assert.equal(issued.seen.secret, CLIENT_SECRET);
    assert.equal(issued.seen.redirect, "http://localhost/keys/callback");
    const row = listStarterKeys(db()).find((item) => item.github_id === "42");
    assert.ok(row);
    assert.equal(row?.contact_opt_in, 0);
    assert.equal(row?.github_login, "octocat");
    const dump = JSON.stringify(db().prepare("SELECT * FROM api_keys").all());
    assert.equal(dump.includes("hidden@example.com"), false);
    assert.equal(dump.includes("Secret Name"), false);
    assert.equal(dump.includes("2019-11-14"), false);
    assert.equal(dump.includes(issued.plaintext), false);
    assert.equal(row?.key_sha256, hashStarterKey(issued.plaintext));

    const again = await signIn(app, { id: 42, login: "octocat", created_at: "2019-11-14T00:00:00Z" }, { allowMissing: true });
    assert.match(again.html, /already has a starter key/);
    assert.doesNotMatch(again.html, /lc_live_/);
    assert.equal(listStarterKeys(db()).filter((item) => item.github_id === "42").length, 1);
  });

  it("stores the contact opt-in only when the box is checked, and blocks a young account", async () => {
    setStarterKeyClockForTests(() => new Date("2026-10-30T12:00:00Z"));
    const app = createApp();
    const opted = await signIn(app, { id: 77, login: "optin", created_at: "2020-01-01T00:00:00Z" }, { contact: true });
    assert.equal(listStarterKeys(db()).find((row) => row.id)?.contact_opt_in === 1 || opted.html.includes("lc_live_"), true);
    assert.equal(listStarterKeys(db()).find((row) => row.github_id === "77")?.contact_opt_in, 1);
    const young = await signIn(app, { id: 78, login: "baby", created_at: "2026-10-29T00:00:00Z" }, { allowMissing: true });
    assert.equal(young.status, 403);
    assert.match(young.html, /Your GitHub account must be at least 7 days old\. Try again after November 5, 2026\./);
    assert.equal(listStarterKeys(db()).some((row) => row.github_id === "78"), false);
  });

  it("spends a credit on a real answer only, and leaves paid /stats buckets unchanged", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 11, login: "payer", created_at: "2020-01-01T00:00:00Z" });
    const before = reconciliation();
    let fetches = 0;
    globalThis.fetch = async (input) => {
      fetches += 1;
      const url = requestUrl(input);
      if (url.includes("/openings?")) return html(FIXTURES.careers.body ?? "", 200);
      if (url.endsWith("/missing")) return html(GONE_HTML, 404);
      if (url.endsWith("/private")) return html(LOGIN_HTML, 200);
      if (url.endsWith("/down")) throw new Error("connection reset");
      return html(LIVE_HTML, 200);
    };

    const live = await verify(app, plaintext, "https://example.com/jobs/1");
    assert.equal(live.status, 200);
    assert.equal(live.headers.get("x-livecheck-starter-key"), "1");
    const liveBody = (await live.json()) as { status: string };
    assert.equal(liveBody.status, "live");
    assert.equal(used(plaintext), 1);

    const beforeShape = fetches;
    const shaped = await verify(app, plaintext, "https://boards.greenhouse.io/acme");
    assert.equal(shaped.status, 400);
    const shapedBody = (await shaped.json()) as { error: string; message: string; billed: boolean; price_usd: number };
    assert.equal(shapedBody.error, "board_url");
    assert.equal(shapedBody.message, BOARD_URL_SHAPE_MESSAGE);
    assert.equal(shapedBody.billed, false);
    assert.equal(shapedBody.price_usd, 0);
    assert.equal(fetches, beforeShape);
    assert.equal(used(plaintext), 1);
    const lever = await verify(app, plaintext, "https://jobs.lever.co/figma");
    assert.equal(lever.status, 400);
    const ashby = await verify(app, plaintext, "https://jobs.ashbyhq.com/notion");
    assert.equal(ashby.status, 400);
    assert.equal(used(plaintext), 1);

    const fetchedBoard = await verify(app, plaintext, "https://example.com/openings?q=engineer");
    assert.equal(fetchedBoard.status, 200);
    const fetchedBody = (await fetchedBoard.json()) as { signals: string[] };
    assert.ok(fetchedBody.signals.includes("not_a_specific_posting"));
    assert.equal(used(plaintext), 2);

    const closed = await verify(app, plaintext, "https://example.com/missing");
    assert.equal(closed.status, 200);
    assert.equal(((await closed.json()) as { status: string }).status, "closed");
    assert.equal(used(plaintext), 3);

    const cantTell = await verify(app, plaintext, "https://example.com/private");
    assert.equal(cantTell.status, 200);
    const cantBody = (await cantTell.json()) as { status: string; signals: string[] };
    assert.equal(cantBody.status, "unknown");
    assert.ok(cantBody.signals.includes("loginwalled"));
    assert.equal(used(plaintext), 4);

    const down = await verify(app, plaintext, "https://example.com/down");
    assert.equal(down.status, 502);
    assert.equal(used(plaintext), 4);

    const bad = await app.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
      body: "{",
    });
    assert.equal(bad.status, 400);
    assert.equal(used(plaintext), 4);

    assert.equal(logs.some((line) => line.includes(PAID_CALL_EVENT)), false);
    assert.deepEqual(reconciliation(), before);
    const stats = buildStatsDocument();
    assert.ok(stats.starter_keys.l7d.free_checks >= 3);
    assert.match(statsHtml(stats), /Starter keys/);
  });

  it("leaves confirm, check, and a non-key Authorization on the wallet path", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 12, login: "wallet", created_at: "2020-01-01T00:00:00Z" });
    for (const path of ["/v1/confirm", "/v1/check", "/v1/watch"]) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ url: "https://example.com/thanks", intent: "lead_submit" }),
      });
      assert.equal(res.status, 402, path);
      assert.equal(res.headers.get("x-livecheck-starter-key"), null, path);
    }
    const payment = await app.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Payment abc123" },
      body: JSON.stringify({ url: "https://example.com/jobs/1" }),
    });
    assert.equal(payment.status, 402);
    assert.equal(used(plaintext), 0);
  });

  it("does not spend a credit on a robots.txt can't-tell or on any board-shaped URL", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 21, login: "robots", created_at: "2020-01-01T00:00:00Z" });
    const before = reconciliation();
    const pages: string[] = [];
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url === "https://blocked.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/robots.txt")) return new Response("missing", { status: 404 });
      pages.push(url);
      return html(LIVE_HTML, 200);
    };

    const robots = await verify(app, plaintext, "https://blocked.example/jobs/1842");
    assert.equal(robots.status, 200);
    const robotsBody = (await robots.json()) as { status: string; signals: string[] };
    assert.equal(robotsBody.status, "unknown");
    assert.ok(robotsBody.signals.includes("robots_disallowed"));
    assert.equal(used(plaintext), 0);
    assert.equal(robots.headers.get("x-livecheck-free-left"), "200");
    assert.deepEqual(pages, []);

    for (const board of [
      "https://acme.wd5.myworkdayjobs.com/External",
      "https://example.com/careers",
      "https://example.com/jobs",
      "https://boards.greenhouse.io/acme",
      "https://jobs.lever.co/figma",
      "https://jobs.ashbyhq.com/notion",
    ]) {
      const res = await verify(app, plaintext, board);
      assert.equal(res.status, 400, board);
      const body = (await res.json()) as { error: string; billed: boolean; price_usd: number };
      assert.equal(body.error, "board_url", board);
      assert.equal(body.billed, false, board);
      assert.equal(body.price_usd, 0, board);
    }
    assert.deepEqual(pages, []);
    assert.equal(used(plaintext), 0);

    const live = await verify(app, plaintext, "https://example.com/jobs/1");
    assert.equal(live.status, 200);
    assert.equal(used(plaintext), 1);
    assert.deepEqual(reconciliation(), before);
  });

  it("links /keys in plain words from OpenAPI, llms.txt, and the free /job page", async () => {
    const app = createApp();
    const line = "Builders: sign in with GitHub for 200 free checks, no wallet needed.";
    const openapi = (await (await app.request("/openapi.json")).json()) as {
      info: { description: string; "x-starter-key": { url: string; description: string } };
    };
    assert.match(openapi.info.description, /Builders: sign in with GitHub for 200 free checks, no wallet needed\. \S+\/keys$/);
    assert.match(openapi.info["x-starter-key"].url, /\/keys$/);
    assert.ok(openapi.info["x-starter-key"].description.startsWith(line));
    const llms = await (await app.request("/llms.txt")).text();
    assert.ok(llms.includes("Builders: sign in with GitHub for 200 free checks, no wallet needed: https://livecheck.fly.dev/keys"));
    assert.match(llms, /reply to get a top-up link/);
    const page = await (await app.request("/job")).text();
    assert.ok(page.includes('Builders: <a href="/keys">sign in with GitHub for 200 free checks</a>, no wallet needed.'));
    // The free page keeps its own limits, separate from a key.
    assert.match(page, /These limits are separate from a starter key\./);
  });

  it("returns 402 with the wallet and top-up line when the free checks are gone", async () => {
    setStarterKeySetting(db(), "free_allowance", 1);
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 13, login: "empty", created_at: "2020-01-01T00:00:00Z" });
    globalThis.fetch = async () => html(LIVE_HTML, 200);
    const first = await verify(app, plaintext, "https://example.com/jobs/1");
    assert.equal(first.status, 200);
    const second = await verify(app, plaintext, "https://example.com/jobs/2");
    assert.equal(second.status, 402);
    const body = (await second.json()) as { error: string; message: string };
    assert.equal(body.error, "out_of_checks");
    assert.equal(body.message, OUT_OF_CHECKS_MESSAGE);
    assert.match(body.message, /wallet/i);
    assert.match(body.message, /reply to get a top-up link/);
    assert.match(body.message, new RegExp(STARTER_KEY_CONTACT_EMAIL));
    assert.equal(used(plaintext), 1);
    setStarterKeySetting(db(), "free_allowance", 200);
  });

  it("enforces the per-key minute and daily limits", async () => {
    setStarterKeySetting(db(), "per_key_per_minute", 2);
    setStarterKeySetting(db(), "per_key_daily_checks", 5);
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 14, login: "limited", created_at: "2020-01-01T00:00:00Z" });
    globalThis.fetch = async () => html(LIVE_HTML, 200);
    assert.equal((await verify(app, plaintext, "https://example.com/a")).status, 200);
    assert.equal((await verify(app, plaintext, "https://example.com/b")).status, 200);
    const limited = await verify(app, plaintext, "https://example.com/c");
    assert.equal(limited.status, 429);
    assert.equal(((await limited.json()) as { error: string }).error, "rate_limited");
    assert.equal(used(plaintext), 2);

    setStarterKeySetting(db(), "per_key_per_minute", 60);
    setStarterKeySetting(db(), "per_key_daily_checks", 2);
    const daily = await verify(app, plaintext, "https://example.com/d");
    assert.equal(daily.status, 429);
    assert.equal(((await daily.json()) as { error: string }).error, "daily_check_limit");
    assert.equal(used(plaintext), 2);

    setStarterKeySetting(db(), "per_key_daily_checks", 200);
    assert.equal(used(plaintext), 2);
  });

  it("closes sign-up on wind-down and stops every key on emergency stop", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 19, login: "keeper", created_at: "2020-01-01T00:00:00Z" });
    globalThis.fetch = async () => html(LIVE_HTML, 200);
    try {
      setStarterKeySetting(db(), "wind_down", 1);
      const windPage = await (await app.request("/keys")).text();
      assert.match(windPage, /Starter key sign-up is closed\. Existing keys keep working until they expire\./);
      assert.equal((await verify(app, plaintext, "https://example.com/still")).status, 200);
      const closed = await app.request("/keys/start", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "",
      });
      assert.equal(closed.status, 403);
      assert.match(await closed.text(), /sign-up is closed/);

      setStarterKeySetting(db(), "emergency_stop", 1);
      const stopPage = await (await app.request("/keys")).text();
      assert.match(stopPage, /emergency stop/i);
      assert.doesNotMatch(stopPage, /Existing keys keep working/);
      const stopped = await verify(app, plaintext, "https://example.com/stopped");
      assert.equal(stopped.status, 403);
      assert.equal(((await stopped.json()) as { error: string }).error, "starter_keys_emergency_stop");
      db().prepare(`UPDATE api_keys SET expires_at = ? WHERE key_sha256 = ?`).run("2020-01-01T00:00:00Z", hashStarterKey(plaintext));
      const expired = await verify(app, plaintext, "https://example.com/expired");
      assert.equal(expired.status, 403);
      assert.equal(((await expired.json()) as { error: string }).error, "starter_keys_emergency_stop");
    } finally {
      setStarterKeySetting(db(), "emergency_stop", 0);
      setStarterKeySetting(db(), "wind_down", 0);
    }
  });

  it("shares the verify concurrency slots and does not spend a credit on 503", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 15, login: "queued", created_at: "2020-01-01T00:00:00Z" });
    setCheckConcurrencyForTests(1);
    setCheckQueueMaxForTests(0);
    let fetches = 0;
    let release: () => void = () => {};
    globalThis.fetch = () => {
      fetches += 1;
      return new Promise((resolve) => {
        release = () => resolve(html(LIVE_HTML, 200));
      });
    };
    const first = verify(app, plaintext, "https://example.com/hold");
    for (let i = 0; i < 50 && fetches < 1; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fetches, 1);
    const second = await verify(app, plaintext, "https://example.com/next");
    assert.equal(second.status, 503);
    release();
    const done = await first;
    assert.equal(done.status, 200);
    assert.equal(used(plaintext), 1);
  });

  it("lets the test-mode header win without spending a starter credit", async () => {
    process.env[TEST_MODE_SECRET_ENV] = "test-mode-secret";
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 16, login: "tester", created_at: "2020-01-01T00:00:00Z" });
    globalThis.fetch = async () => html(LIVE_HTML, 200);
    const res = await app.request("/v1/verify", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${plaintext}`,
        [TEST_MODE_HEADER]: "test-mode-secret",
      },
      body: JSON.stringify({ url: "https://example.com/jobs/1" }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get(TEST_MODE_HEADER), "1");
    assert.equal(used(plaintext), 0);
    assert.equal(logs.some((line) => line.includes(PAID_CALL_EVENT)), false);
    // Not a starter-key answer: the wallet price stays and no free-credit fields appear.
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.price_usd, 0.01);
    assert.equal("paid_with" in body, false);
    assert.equal("credits_remaining" in body, false);
  });

  it("says a starter-key answer cost $0 on free credit and how many credits are left", async () => {
    const app = createApp();
    const { plaintext } = await signIn(app, { id: 31, login: "freebody", created_at: "2020-01-01T00:00:00Z" });
    globalThis.fetch = async (input) => {
      const url = requestUrl(input);
      if (url === "https://blocked.example/robots.txt") {
        return new Response("User-agent: *\nDisallow: /\n", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.endsWith("/robots.txt")) return new Response("missing", { status: 404 });
      if (url.endsWith("/missing")) return html(GONE_HTML, 404);
      return html(LIVE_HTML, 200);
    };
    for (const [path, target, status] of [
      ["/v1/verify", "https://example.com/jobs/1", "live"],
      ["/v1/verify/job", "https://example.com/jobs/missing", "closed"],
      ["/v1/verify/listing", "https://example.com/jobs/2", "live"],
    ] as const) {
      const res = await app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${plaintext}` },
        body: JSON.stringify({ url: target }),
      });
      assert.equal(res.status, 200, path);
      assert.match(res.headers.get("content-type") ?? "", /json/, path);
      const body = (await res.json()) as Record<string, unknown>;
      assert.equal(body.status, status, path);
      assert.equal(body.price_usd, 0, path);
      assert.equal(body.paid_with, "free_credit", path);
      assert.equal(body.credit_used, true, path);
      assert.equal(body.credits_remaining, Number(res.headers.get("x-livecheck-free-left")), path);
      assert.equal(body.credits_remaining, 200 - used(plaintext), path);
    }
    assert.equal(used(plaintext), 3);

    // A robots.txt can't-tell spends nothing and still says $0 on the key.
    const robots = await verify(app, plaintext, "https://blocked.example/jobs/9");
    const robotsBody = (await robots.json()) as Record<string, unknown>;
    assert.equal(robotsBody.status, "unknown");
    assert.equal(robotsBody.price_usd, 0);
    assert.equal(robotsBody.paid_with, "free_credit");
    assert.equal(robotsBody.credit_used, false);
    assert.equal(robotsBody.credits_remaining, 197);
    assert.equal(used(plaintext), 3);
  });
});

describe("keys script", () => {
  it("sets the emergency stop in an existing paid-calls file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "starter-keys-"));
    const path = join(dir, "paid-calls.sqlite");
    initPaidCallStore(path);
    closePaidCallStore();
    const { stdout } = await execFileAsync(
      "npx",
      ["tsx", "scripts/starter-keys.ts", "set", "emergency_stop", "1", "--db", path, "--json"],
      { cwd: process.cwd() },
    );
    const body = JSON.parse(stdout) as { limits: { emergencyStop: boolean; windDown: boolean } };
    assert.equal(body.limits.emergencyStop, true);
    assert.equal(body.limits.windDown, false);
  });
  it("mark-internal, revoke, and delete a test key by login without printing the key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "starter-keys-"));
    const path = join(dir, "paid-calls.sqlite");
    initPaidCallStore(path);
    const made = issueStarterKey(
      db(),
      { githubId: "777", githubLogin: "PyGuy2", accountCreatedAt: "2020-01-01T00:00:00Z", contactOptIn: false, ipSubject: "ip:script" },
      new Date(),
    );
    closePaidCallStore();
    assert.equal(made.ok, true);
    if (!made.ok) return;
    const run = async (...args: string[]) => {
      const { stdout } = await execFileAsync("npx", ["tsx", "scripts/starter-keys.ts", ...args, "--db", path, "--json"], {
        cwd: process.cwd(),
      });
      assert.equal(stdout.includes(made.plaintext), false);
      assert.equal(stdout.includes(hashStarterKey(made.plaintext)), false);
      return JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}") as {
        stats: { internal_keys_excluded: number; l7d: { issued: number }; l30d: { issued: number } };
        keys: Array<{ id: string; status: string; internal: boolean }>;
        deleted_key?: { id: string; github_login: string };
      };
    };
    const listed = await run("list");
    assert.equal(listed.stats.l7d.issued, 1);
    const marked = await run("mark-internal", "PyGuy2");
    assert.equal(marked.keys[0]?.internal, true);
    assert.equal(marked.stats.internal_keys_excluded, 1);
    assert.equal(marked.stats.l7d.issued, 0);
    assert.equal(marked.stats.l30d.issued, 0);
    const revoked = await run("revoke", "@PyGuy2");
    assert.equal(revoked.keys[0]?.status, "revoked");
    const deleted = await run("delete", "pyguy2");
    assert.equal(deleted.deleted_key?.id, made.id);
    assert.equal(deleted.keys.length, 0);
    assert.equal(deleted.stats.internal_keys_excluded, 0);
    await assert.rejects(run("delete", "pyguy2"), /no starter key matches/);
  });
});

describe("starter keys by source", () => {
  // Fixed clock: the rolling window and the boundary second must not depend on the day the suite runs.
  const now = new Date("2026-06-15T12:00:00Z");

  before(() => {
    initPaidCallStore(":memory:");
    initFreePageStore(":memory:");
  });
  after(() => {
    closePaidCallStore();
    closeFreePageStore();
    setStarterKeyClockForTests(null);
    setFreeJobClockForTests(() => new Date());
    setGithubFetchForTests(null);
    delete process.env[FREE_PAGE_STATS_TOKEN_ENV];
  });
  beforeEach(() => {
    process.env[GITHUB_OAUTH_CLIENT_ID_ENV] = CLIENT_ID;
    process.env[GITHUB_OAUTH_CLIENT_SECRET_ENV] = CLIENT_SECRET;
    process.env[FREE_PAGE_STATS_TOKEN_ENV] = "starter-source-token";
    setStarterKeySetting(db(), "emergency_stop", 0, now);
    setStarterKeySetting(db(), "wind_down", 0, now);
    setStarterKeyClockForTests(() => now);
    setFreeJobClockForTests(() => now);
    setGithubFetchForTests(null);
  });
  afterEach(() => {
    setGithubFetchForTests(null);
    setStarterKeyClockForTests(null);
  });

  function issuedAt(when: Date, partial: { githubId: string; login: string; source?: string }) {
    const result = issueStarterKey(
      db(),
      {
        githubId: partial.githubId,
        githubLogin: partial.login,
        accountCreatedAt: "2020-01-01T00:00:00Z",
        contactOptIn: false,
        ipSubject: `ip:${partial.login}`,
        ...(partial.source !== undefined ? { source: partial.source } : {}),
      },
      when,
    );
    assert.equal(result.ok, true);
    if (!result.ok) throw new Error("issue failed");
    return result;
  }

  function sumIssued(buckets: Record<string, { issued: number }>): number {
    return Object.values(buckets).reduce((total, bucket) => total + bucket.issued, 0);
  }

  it("keeps source off the key row and counts an allowlisted tag, none, and other", () => {
    assert.equal(STARTER_SOURCE_ON_KEY_ROW, false);
    assert.equal(STARTER_SOURCE_STATS_PUBLIC, false);
    const columns = (db().prepare(`PRAGMA table_info(api_keys)`).all() as Array<{ name: string }>).map((col) => col.name);
    assert.equal(columns.includes("source"), false);
    const aggregateColumns = (db().prepare(`PRAGMA table_info(api_key_source_daily)`).all() as Array<{ name: string }>).map((col) => col.name);
    for (const name of ["key_id", "github_login", "ip"]) assert.equal(aggregateColumns.includes(name), false, name);

    issuedAt(now, { githubId: "501", login: "lane", source: "reddit" });
    issuedAt(now, { githubId: "502", login: "ada", source: "agensi" });
    issuedAt(now, { githubId: "503", login: "quiet" });
    issuedAt(now, { githubId: "504", login: "oddtag", source: "not-a-launch-tag" });
    const report = starterKeySourceReport(now);
    assert.equal(report.by_source.l7d.reddit?.issued, 1);
    assert.equal(report.by_source.l7d.agensi?.issued, 1);
    assert.equal(report.by_source.l7d.none?.issued, 1);
    assert.equal(report.by_source.l7d.other?.issued, 1);
    assert.equal(report.by_source.l7d["not-a-launch-tag"], undefined);
    assert.equal(sumIssued(report.by_source.l7d), report.issued.l7d);
    assert.equal(sumIssued(report.by_source.l30d), report.issued.l30d);
    assert.equal(sumIssued(report.by_source.l7d), queryStarterKeyStats(db(), now).l7d.issued);

    const keyDump = JSON.stringify(db().prepare(`SELECT * FROM api_keys WHERE github_login IN ('lane', 'ada', 'quiet', 'oddtag')`).all());
    assert.equal(keyDump.includes("reddit"), false);
    assert.equal(keyDump.includes("agensi"), false);
    assert.equal(keyDump.includes("not-a-launch-tag"), false);
    const aggregate = JSON.stringify(db().prepare(`SELECT * FROM api_key_source_daily`).all());
    assert.equal(aggregate.includes("lane"), false);
    assert.equal(aggregate.includes("ip:"), false);
    assert.equal(aggregate.includes("not-a-launch-tag"), false);
  });

  it("a second sign-in does not count again or change the source", () => {
    const first = issuedAt(now, { githubId: "511", login: "returner", source: "hn" });
    const before = queryStarterKeySourceBuckets(db(), now).l7d.hn?.issued ?? 0;
    const again = issueStarterKey(
      db(),
      {
        githubId: "511",
        githubLogin: "returner",
        accountCreatedAt: "2020-01-01T00:00:00Z",
        contactOptIn: false,
        ipSubject: "ip:returner",
        source: "reddit",
      },
      now,
    );
    assert.equal(again.ok, false);
    const row = db().prepare(`SELECT source, counted FROM api_key_issue_source WHERE key_id = ?`).get(first.id) as {
      source: string;
      counted: number;
    };
    assert.equal(row.source, "hn");
    assert.equal(Number(row.counted), 1);
    assert.equal(queryStarterKeySourceBuckets(db(), now).l7d.hn?.issued, before);
    const stats = queryStarterKeyStats(db(), now);
    assert.equal(sumIssued(queryStarterKeySourceBuckets(db(), now).l7d), stats.l7d.issued);
    assert.equal(sumIssued(queryStarterKeySourceBuckets(db(), now).l30d), stats.l30d.issued);
  });

  it("mark-internal decrements that source, and the buckets still add up", () => {
    const before = queryStarterKeyStats(db(), now);
    const redditBefore = queryStarterKeySourceBuckets(db(), now).l7d.reddit?.issued ?? 0;
    const issued = issuedAt(now, { githubId: "521", login: "internal-src", source: "reddit" });
    assert.equal(queryStarterKeySourceBuckets(db(), now).l7d.reddit?.issued, redditBefore + 1);
    assert.equal(markStarterKeyInternal(db(), "@internal-src", now)?.internal, 1);
    assert.equal(queryStarterKeySourceBuckets(db(), now).l7d.reddit?.issued ?? 0, redditBefore);
    assert.equal(markStarterKeyInternal(db(), "internal-src", now)?.internal, 1);
    assert.equal(queryStarterKeySourceBuckets(db(), now).l7d.reddit?.issued ?? 0, redditBefore);
    const after = queryStarterKeyStats(db(), now);
    assert.equal(after.l7d.issued, before.l7d.issued);
    assert.equal(after.internal_keys_excluded, before.internal_keys_excluded + 1);
    assert.equal(sumIssued(queryStarterKeySourceBuckets(db(), now).l7d), after.l7d.issued);
    assert.equal(sumIssued(queryStarterKeySourceBuckets(db(), now).l30d), after.l30d.issued);
    const link = db().prepare(`SELECT counted FROM api_key_issue_source WHERE key_id = ?`).get(issued.id) as { counted: number };
    assert.equal(Number(link.counted), 0);
  });

  it("a key just outside the rolling window stays out, even on the same UTC day", () => {
    const inside = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const outside = new Date(inside.getTime() - 1000);
    assert.equal(isoStamp(inside).slice(0, 10), isoStamp(outside).slice(0, 10));
    const before = queryStarterKeyStats(db(), now);
    issuedAt(inside, { githubId: "531", login: "on-cutoff", source: "reddit" });
    issuedAt(outside, { githubId: "532", login: "before-cutoff", source: "reddit" });
    const stats = queryStarterKeyStats(db(), now);
    const buckets = queryStarterKeySourceBuckets(db(), now);
    assert.equal(stats.l7d.issued, before.l7d.issued + 1);
    assert.equal(stats.l30d.issued, before.l30d.issued + 2);
    assert.equal(sumIssued(buckets.l7d), stats.l7d.issued);
    assert.equal(sumIssued(buckets.l30d), stats.l30d.issued);
  });

  it("expiry deletes the key and keeps the issued-by-source count", () => {
    const created = new Date("2026-01-01T00:00:00Z");
    const issued = issuedAt(created, { githubId: "541", login: "expires-src", source: "hn" });
    const day = "2026-01-01";
    const beforeDelete = db().prepare(`SELECT issued FROM api_key_source_daily WHERE created_at = ? AND source = ?`).get(
      isoStamp(created),
      "hn",
    ) as { issued: number };
    assert.equal(Number(beforeDelete.issued) >= 1, true);
    const removed = deleteExpiredStarterKeys(db(), new Date("2026-05-02T00:00:00Z"));
    assert.equal(removed >= 1, true);
    assert.equal(listStarterKeys(db()).some((row) => row.id === issued.id), false);
    const link = db().prepare(`SELECT key_id FROM api_key_issue_source WHERE key_id = ?`).get(issued.id);
    assert.equal(link, undefined);
    const after = db().prepare(`SELECT issued FROM api_key_source_daily WHERE day = ? AND created_at = ? AND source = ?`).get(
      day,
      isoStamp(created),
      "hn",
    ) as { issued: number };
    assert.equal(Number(after.issued), Number(beforeDelete.issued));
    // The key is 120 days old at deletion, outside l7d and l30d, so the
    // rolling windows still add up. The count itself stayed on the aggregate row.
    const report = starterKeySourceReport(new Date("2026-05-02T00:00:00Z"));
    assert.equal(JSON.stringify(report.by_source).includes("activated"), false);
    assert.equal(JSON.stringify(report.by_source).includes("reached_20"), false);
    assert.equal(sumIssued(report.by_source.l7d), report.issued.l7d);
    assert.equal(sumIssued(report.by_source.l30d), report.issued.l30d);
    const later = starterKeySourceReport(now);
    assert.equal(sumIssued(later.by_source.l7d), later.issued.l7d);
    assert.equal(sumIssued(later.by_source.l30d), later.issued.l30d);
  });

  it("admin delete of a live key decrements the bucket; a second migrate does not double-count old keys", () => {
    const issued = issuedAt(now, { githubId: "551", login: "admin-del", source: "devto" });
    const before = queryStarterKeySourceBuckets(db(), now).l7d.devto?.issued ?? 0;
    assert.equal(deleteStarterKeyRecord(db(), "admin-del", now)?.id, issued.id);
    assert.equal(queryStarterKeySourceBuckets(db(), now).l7d.devto?.issued ?? 0, before - 1);
    assert.equal(sumIssued(queryStarterKeySourceBuckets(db(), now).l7d), queryStarterKeyStats(db(), now).l7d.issued);

    const old = new DatabaseSync(":memory:");
    migrateApiKeyStore(old);
    old.prepare(
      `INSERT INTO api_keys (
         id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at, free_allowance, status
       ) VALUES ('k_oldkey000000001', 'hash', '900', 'legacy', 0, '2026-06-15T12:00:00Z', '2026-07-15T12:00:00Z', 200, 'active')`,
    ).run();
    old.prepare(
      `INSERT INTO api_keys (
         id, key_sha256, github_id, github_login, contact_opt_in, created_at, expires_at, free_allowance, status, internal
       ) VALUES ('k_oldkey000000002', 'hash2', '901', 'legacy-internal', 0, '2026-06-15T12:00:00Z', '2026-07-15T12:00:00Z', 200, 'active', 1)`,
    ).run();
    migrateApiKeyStore(old);
    migrateApiKeyStore(old);
    const buckets = queryStarterKeySourceBuckets(old, now);
    assert.equal(buckets.l7d.none?.issued, 1);
    assert.equal(sumIssued(buckets.l7d), queryStarterKeyStats(old, now).l7d.issued);
    assert.equal(queryStarterKeyStats(old, now).l7d.issued, 1);
    old.close();
  });

  it("puts the tag on the form, folds unknown and junk tags, and does not echo the junk", async () => {
    const app = createApp();
    const reddit = await (await app.request("/keys?ref=reddit")).text();
    assert.match(reddit, /action="\/keys\/start\?ref=reddit"/);
    const agensi = await (await app.request("/keys?utm_source=Agensi")).text();
    assert.match(agensi, /action="\/keys\/start\?ref=agensi"/);
    const unknown = await (await app.request("/keys?ref=newsletter")).text();
    assert.match(unknown, /action="\/keys\/start\?ref=other"/);
    assert.equal(unknown.includes("newsletter"), false);
    const junk = `"><script>alert(1)</script>`;
    const hostile = await (await app.request(`/keys?ref=${encodeURIComponent(junk)}`)).text();
    assert.match(hostile, /action="\/keys\/start\?ref=other"/);
    assert.equal(hostile.includes("<script"), false);
    assert.equal(hostile.includes("alert(1)"), false);
    const plain = await (await app.request("/keys")).text();
    assert.match(plain, /action="\/keys\/start"/);
    assert.equal(plain.includes("ref=none"), false);
    assert.match(plain, /We store your GitHub username to run your key\. Nothing is shared\./);
  });

  it("issues from a mocked GitHub round trip under the tag, and a repeat visit does not count again", async () => {
    const app = createApp();
    const before = starterKeySourceReport(now);
    const first = await signIn(app, { id: 88001, login: "oauth-reddit", created_at: "2020-01-01T00:00:00Z" }, { start: "/keys/start?ref=reddit" });
    assert.match(first.html, /lc_live_/);
    const authorize = new URL(first.authorize);
    assert.equal(authorize.searchParams.get("scope"), null);
    assert.equal(authorize.searchParams.get("state")?.includes("reddit"), false);
    const cookieBody = JSON.parse(Buffer.from((first.cookie.split("=")[1] ?? "").split(".")[0] ?? "", "base64url").toString("utf8")) as {
      r?: string;
    };
    assert.equal(cookieBody.r, "reddit");
    const row = listStarterKeys(db()).find((item) => item.github_login === "oauth-reddit");
    assert.ok(row);
    assert.equal((db().prepare(`SELECT source FROM api_key_issue_source WHERE key_id = ?`).get(row!.id) as { source: string }).source, "reddit");
    const after = starterKeySourceReport(now);
    assert.equal(after.by_source.l7d.reddit?.issued, (before.by_source.l7d.reddit?.issued ?? 0) + 1);
    assert.equal(sumIssued(after.by_source.l7d), after.issued.l7d);

    const again = await signIn(
      app,
      { id: 88001, login: "oauth-reddit", created_at: "2020-01-01T00:00:00Z" },
      { start: "/keys/start?ref=hn", allowMissing: true },
    );
    assert.match(again.html, /already has a starter key/);
    assert.equal(
      (db().prepare(`SELECT source FROM api_key_issue_source WHERE key_id = ?`).get(row!.id) as { source: string }).source,
      "reddit",
    );
    assert.equal(starterKeySourceReport(now).by_source.l7d.reddit?.issued, after.by_source.l7d.reddit?.issued);
  });

  it("a cookie from before the deploy (no r) still issues as none", async () => {
    const app = createApp();
    const state = "pre-deploy-state";
    const cookieValue = signStarterOauthCookieForTests({ s: state, c: 0, e: now.getTime() + 60_000 }, CLIENT_SECRET);
    assert.equal(JSON.parse(Buffer.from(cookieValue.split(".")[0] ?? "", "base64url").toString("utf8")).r, undefined);
    setGithubFetchForTests(async (input) => {
      const url = requestUrl(input);
      if (url.startsWith("https://github.com/login/oauth/access_token")) return Response.json({ access_token: "gho_test" });
      if (url === "https://api.github.com/user") {
        return Response.json({ id: 88002, login: "inflight", created_at: "2020-01-01T00:00:00Z" });
      }
      throw new Error(`unexpected ${url}`);
    });
    const beforeNone = starterKeySourceReport(now).by_source.l7d.none?.issued ?? 0;
    const callback = await app.request(`/keys/callback?code=code-old&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `${STARTER_OAUTH_COOKIE}=${cookieValue}`, "fly-client-ip": "203.0.113.50" },
    });
    const html = await callback.text();
    assert.equal(callback.status, 200);
    assert.match(html, /lc_live_/);
    assert.equal(starterKeySourceReport(now).by_source.l7d.none?.issued, beforeNone + 1);
    const row = listStarterKeys(db()).find((item) => item.github_login === "inflight");
    assert.equal((db().prepare(`SELECT source FROM api_key_issue_source WHERE key_id = ?`).get(row!.id) as { source: string }).source, "none");
  });

  it("an edited cookie r fails the HMAC and uses the sign-in expired path", async () => {
    const app = createApp();
    const start = await app.request("/keys/start?ref=reddit", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "fly-client-ip": "203.0.113.60" },
      body: "",
    });
    assert.equal(start.status, 302);
    const raw = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const value = raw.slice(raw.indexOf("=") + 1);
    const dot = value.lastIndexOf(".");
    const parsed = JSON.parse(Buffer.from(value.slice(0, dot), "base64url").toString("utf8")) as { s: string; r: string };
    parsed.r = "hn";
    const tampered = `${Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url")}.${value.slice(dot + 1)}`;
    const callback = await app.request(`/keys/callback?code=nope&state=${encodeURIComponent(parsed.s)}`, {
      headers: { cookie: `${STARTER_OAUTH_COOKIE}=${tampered}` },
    });
    assert.equal(callback.status, 400);
    assert.match(await callback.text(), /Sign-in expired/);
    assert.equal(listStarterKeys(db()).some((row) => row.github_login === "hn"), false);
  });

  it("honors a launch tag added at runtime", async () => {
    const tag = upsertLaunchUtmTagIn(freePageDbForTests(), "partnerblog", now);
    assert.equal(tag, "partnerblog");
    const app = createApp();
    const html = await (await app.request("/keys?ref=partnerblog")).text();
    assert.match(html, /action="\/keys\/start\?ref=partnerblog"/);
    const issued = await signIn(app, { id: 88003, login: "partner", created_at: "2020-01-01T00:00:00Z" }, { start: "/keys/start?ref=partnerblog" });
    assert.match(issued.html, /lc_live_/);
    assert.equal(starterKeySourceReport(now).by_source.l7d.partnerblog?.issued, 1);
  });

  it("carries /job?ref=hn onto the /keys links", async () => {
    const app = createApp();
    const page = await (await app.request("/job?ref=hn")).text();
    assert.ok(page.includes('href="/keys?ref=hn"'));
    assert.equal(page.split('href="/keys?ref=hn"').length - 1, 2);
    const junk = await (await app.request(`/job?ref=${encodeURIComponent('"><script>')}`)).text();
    assert.equal(junk.includes("<script>"), false);
    assert.ok(junk.includes('href="/keys?ref=other"'));
    const plain = await (await app.request("/job")).text();
    assert.ok(plain.includes('href="/keys"'));
    assert.equal(plain.includes("/keys?ref="), false);
  });

  it("shows by_source on token-gated /job/stats and leaves public /stats unchanged", async () => {
    const app = createApp();
    const token = process.env[FREE_PAGE_STATS_TOKEN_ENV] ?? "";
    const before = starterKeySourceReport(now);
    await signIn(app, { id: 88004, login: "agensi-user", created_at: "2020-01-01T00:00:00Z" }, { start: "/keys/start?ref=agensi" });
    const priv = await app.request("/job/stats", { headers: { "x-livecheck-stats-token": token } });
    assert.equal(priv.status, 200);
    const body = (await priv.json()) as {
      starter_keys: {
        decisions: { public_stats: boolean; source_on_key_row: boolean };
        issued: { l7d: number; l30d: number };
        by_source: { l7d: Record<string, { issued: number }>; l30d: Record<string, { issued: number }> };
      };
    };
    assert.equal(body.starter_keys.decisions.public_stats, false);
    assert.equal(body.starter_keys.decisions.source_on_key_row, false);
    assert.equal(body.starter_keys.by_source.l7d.agensi?.issued, (before.by_source.l7d.agensi?.issued ?? 0) + 1);
    assert.equal(sumIssued(body.starter_keys.by_source.l7d), body.starter_keys.issued.l7d);
    assert.equal(sumIssued(body.starter_keys.by_source.l30d), body.starter_keys.issued.l30d);
    assert.equal(body.starter_keys.issued.l7d, queryStarterKeyStats(db(), now).l7d.issued);
    assert.equal(JSON.stringify(body.starter_keys.by_source).includes("activated"), false);

    assert.equal((await app.request("/job/stats")).status, 404);
    const publicJson = (await (await app.request("/stats?format=json")).json()) as { starter_keys: Record<string, unknown> };
    assert.equal("by_source" in publicJson.starter_keys, false);
    assert.equal(JSON.stringify(publicJson.starter_keys).includes("agensi"), false);
    assert.equal(JSON.stringify(publicJson.starter_keys).includes("by_source"), false);
    const publicHtml = await (await app.request("/stats?format=html")).text();
    assert.equal(publicHtml.includes("by_source"), false);
    assert.equal(publicHtml.includes("agensi"), false);
    const doc = buildStatsDocument(now);
    assert.equal("by_source" in doc.starter_keys, false);
    assert.equal(JSON.stringify(doc.starter_keys).includes("agensi"), false);
  });
});

function html(body: string, status: number): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function verify(app: ReturnType<typeof createApp>, token: string, url: string): Promise<Response> {
  return Promise.resolve(
    app.request("/v1/verify", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ url }),
    }),
  );
}

function used(token: string): number {
  const row = db()
    .prepare(`SELECT free_used FROM api_keys WHERE key_sha256 = ?`)
    .get(hashStarterKey(token)) as { free_used: number } | undefined;
  return Number(row?.free_used ?? -1);
}

function reconciliation(): unknown {
  return buildStatsDocument().traffic.reconciliation;
}

async function signIn(
  app: ReturnType<typeof createApp>,
  profile: { id: number; login: string; created_at: string },
  options: { contact?: boolean; ip?: string; allowMissing?: boolean; start?: string } = {},
): Promise<{ html: string; status: number; plaintext: string; authorize: string; seen: { secret?: string; redirect?: string }; cookie: string }> {
  const seen: { secret?: string; redirect?: string } = {};
  setGithubFetchForTests(async (input, init) => {
    const url = requestUrl(input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      const body = JSON.parse(String(init?.body)) as { client_secret?: string; redirect_uri?: string };
      seen.secret = body.client_secret;
      seen.redirect = body.redirect_uri;
      return Response.json({ access_token: "gho_test", token_type: "bearer" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: profile.id,
        login: profile.login,
        created_at: profile.created_at,
        email: "hidden@example.com",
        name: "Secret Name",
      });
    }
    throw new Error(`unexpected GitHub call ${url}`);
  });
  const ip = options.ip ?? `203.0.113.${profile.id % 200}`;
  const start = await app.request(options.start ?? "/keys/start", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "fly-client-ip": ip,
    },
    body: options.contact ? "contact=yes" : "",
  });
  const authorize = start.headers.get("location") ?? "";
  assert.equal(start.status, 302, await start.text());
  const state = new URL(authorize).searchParams.get("state") ?? "";
  const cookie = (start.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const callback = await app.request(`/keys/callback?code=code-${profile.id}&state=${encodeURIComponent(state)}`, {
    headers: { cookie, "fly-client-ip": ip },
  });
  const html = await callback.text();
  const plaintext = html.match(/lc_live_[A-Za-z0-9_-]+/)?.[0] ?? "";
  if (!plaintext && !options.allowMissing) {
    throw new Error(`sign-in for ${profile.login} returned ${callback.status}: ${html.slice(0, 500)}`);
  }
  return { html, status: callback.status, plaintext, authorize, seen, cookie };
}
