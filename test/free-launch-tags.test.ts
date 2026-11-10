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
  it("built-ins include clawhub and agensi", () => {
    for (const tag of ["clawhub", "agensi"]) {
      assert.ok((LAUNCH_UTM_TAGS as readonly string[]).includes(tag), tag);
      assert.ok(effectiveLaunchUtmTags(null).has(tag), tag);
    }
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
  it("Show HN week tags are built-in, never fold on one hit, and utm buckets still add up", () => {
    const showHn = ["hn", "reddit", "cursorforum", "devto", "indiehackers"];
    const db = openDb();
    // A tag added at runtime before this deploy stays harmless: no duplicate in the list.
    db.prepare("INSERT INTO free_page_launch_utm (tag, added_at, removed_at) VALUES ('hn', '2026-11-03T22:00:00Z', NULL)").run();
    for (const tag of showHn) {
      assert.ok((LAUNCH_UTM_TAGS as readonly string[]).includes(tag), tag);
      assert.ok(effectiveLaunchUtmTags(null).has(tag), tag);
      assert.throws(() => upsertLaunchUtmTagIn(db, tag), /built-in/);
      bumpSourcesIn(db, "2026-11-04", "view", { referrer: "direct", utm: tag, ua: "browser" });
    }
    assert.equal(listLaunchUtmTagsFrom(db).filter((row) => row.tag === "hn").length, 1);
    bumpSourcesIn(db, "2026-11-04", "view", { referrer: "direct", utm: "oneoff-random", ua: "browser" });
    bumpSourcesIn(db, "2026-11-04", "view", { referrer: "direct", utm: "none", ua: "browser" });
    const totals = readSourceTotalsFrom(db, "2026-11-04");
    for (const tag of showHn) assert.equal(totals.view.utm[tag], 1, tag);
    assert.equal(totals.view.utm.other, 1, "a non-launch one-off still folds");
    const sum = (bucket: Record<string, number>) => Object.values(bucket).reduce((a, b) => a + b, 0);
    assert.equal(sum(totals.view.utm), 7, "utm buckets add up to total views");
    assert.equal(sum(totals.view.utm), sum(totals.view.ua));
    assert.equal(sum(totals.view.utm), sum(totals.view.referrer));
    db.close();
  });
});
