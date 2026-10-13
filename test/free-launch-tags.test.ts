import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  LAUNCH_UTM_TABLE_SQL,
  LAUNCH_UTM_TAGS,
  SOURCES_TABLE_SQL,
  bumpSourcesIn,
  effectiveLaunchUtmTags,
  listLaunchUtmTagsFrom,
  readSourceTotalsFrom,
  removeLaunchUtmTagIn,
  upsertLaunchUtmTagIn,
} from "../src/free-job-sources.js";

function openDb(): DatabaseSync {
  const path = join(mkdtempSync(join(tmpdir(), "free-launch-")), "free-page.sqlite");
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SOURCES_TABLE_SQL);
  db.exec(LAUNCH_UTM_TABLE_SQL);
  return db;
}

describe("free /job launch utm tags", () => {
  it("built-ins include clawhub", () => {
    assert.ok((LAUNCH_UTM_TAGS as readonly string[]).includes("clawhub"));
    assert.ok(effectiveLaunchUtmTags(null).has("clawhub"));
  });

  it("DB extras merge in and never fold on a single hit; remove works", () => {
    const db = openDb();
    assert.equal(upsertLaunchUtmTagIn(db, "PartnerBlog"), "partnerblog");
    assert.ok(effectiveLaunchUtmTags(db).has("partnerblog"));
    const listed = listLaunchUtmTagsFrom(db);
    assert.ok(listed.some((row) => row.tag === "partnerblog" && row.source === "db"));
    bumpSourcesIn(db, "2026-10-13", "view", { referrer: "direct", utm: "partnerblog", ua: "browser" });
    const totals = readSourceTotalsFrom(db, "2026-10-13");
    assert.equal(totals.view.utm.partnerblog, 1, "extra launch tag is not folded to other");
    assert.equal(removeLaunchUtmTagIn(db, "partnerblog"), true);
    assert.equal(effectiveLaunchUtmTags(db).has("partnerblog"), false);
    assert.throws(() => removeLaunchUtmTagIn(db, "clawhub"), /built-in/);
    assert.throws(() => upsertLaunchUtmTagIn(db, "clawhub"), /built-in/);
    db.close();
  });
});
