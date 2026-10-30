import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { createApp } from "../src/app.js";
import {
  apiKeyDb,
  deleteExpiredStarterKeys,
  issueStarterKey,
  migrateApiKeyStore,
  listFollowups,
  listStarterKeys,
  markFollowupDrafted,
  queryStarterKeyStats,
  reserveStarterCall,
  revokeStarterKey,
  setStarterKeySetting,
  starterKeyLimits,
  finishStarterCall,
} from "../src/api-key-store.js";
import {
  resetCheckSlotsForTests,
  setCheckConcurrencyForTests,
  setCheckQueueMaxForTests,
} from "../src/check-capacity.js";
import { CHECK_TIMEOUT_SIGNAL, TEST_MODE_HEADER, TEST_MODE_SECRET_ENV } from "../src/config.js";
import { FIXTURES } from "../src/fixtures.js";
import { PAID_CALL_EVENT } from "../src/paid-call.js";
import { closePaidCallStore, initPaidCallStore } from "../src/paid-call-store.js";
import { setGithubFetchForTests } from "../src/starter-key-page.js";
import {
  GITHUB_OAUTH_CLIENT_ID_ENV,
  GITHUB_OAUTH_CLIENT_SECRET_ENV,
  EMERGENCY_STOP_MESSAGE,
  OUT_OF_CHECKS_MESSAGE,
  STARTER_KEY_CONTACT_EMAIL,
  STARTER_KEY_CONTACT_LABEL,
  STARTER_KEY_PRIVACY_LINE,
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

function issue(partial: { githubId?: string; login?: string; ip?: string; optIn?: boolean; createdAt?: string } = {}) {
  const now = new Date("2026-10-30T12:00:00Z");
  const result = issueStarterKey(
    db(),
    {
      githubId: partial.githubId ?? "1001",
      githubLogin: partial.login ?? "octocat",
      accountCreatedAt: partial.createdAt ?? "2020-01-01T00:00:00Z",
      contactOptIn: partial.optIn ?? false,
      ipSubject: partial.ip ?? "ip:unit",
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
    for (const forbidden of ["email", "url", "ip", "token", "plaintext"]) {
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

  it("issues one key from GitHub's public profile and never stores the email", async () => {
    const app = createApp();
    const issued = await signIn(app, { id: 42, login: "octocat", created_at: "2019-11-14T00:00:00Z" }, { contact: false });
    assert.match(issued.html, /lc_live_/);
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
    assert.match(young.html, /under 7 days old/);
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
  options: { contact?: boolean; ip?: string; allowMissing?: boolean } = {},
): Promise<{ html: string; status: number; plaintext: string; authorize: string; seen: { secret?: string; redirect?: string } }> {
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
  const start = await app.request("/keys/start", {
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
  return { html, status: callback.status, plaintext, authorize, seen };
}
