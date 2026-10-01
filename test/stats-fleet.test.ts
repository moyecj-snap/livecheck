import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { buildStatsDocument, type StatsDocument } from "../src/stats.js";
import { statsHtml } from "../src/stats.js";
import {
  buildPublicStatsDocument,
  clearStatsFleetCache,
  mergeFleetStats,
  parseFlyMachineList,
  startedMachineIds,
  statsFleetEnabled,
  statsScopeIsLocal,
} from "../src/stats-fleet.js";

function volume(machineId: string, patch: (doc: StatsDocument) => void): StatsDocument {
  const doc = buildStatsDocument(new Date("2026-09-29T17:13:52Z"));
  doc.store.fly_machine_id = machineId;
  doc.store.fly_app_name = "livecheck";
  doc.store.scope = "this_machine_volume";
  patch(doc);
  return doc;
}

describe("stats fleet merge", () => {
  afterEach(() => {
    clearStatsFleetCache();
  });

  it("treats scope=local as a single-volume read", () => {
    assert.equal(statsScopeIsLocal("local", undefined), true);
    assert.equal(statsScopeIsLocal(undefined, "local"), true);
    assert.equal(statsScopeIsLocal(undefined, "json"), false);
    assert.equal(statsScopeIsLocal(undefined, undefined), false);
  });

  it("keeps fleet summing off unless LIVECHECK_STATS_FLEET is explicitly on", () => {
    assert.equal(statsFleetEnabled({}), false);
    assert.equal(statsFleetEnabled({ LIVECHECK_STATS_FLEET: "" }), false);
    assert.equal(statsFleetEnabled({ LIVECHECK_STATS_FLEET: "0" }), false);
    assert.equal(statsFleetEnabled({ LIVECHECK_STATS_FLEET: "1" }), true);
    assert.equal(statsFleetEnabled({ LIVECHECK_STATS_FLEET: "true" }), true);
    assert.equal(statsFleetEnabled({ LIVECHECK_STATS_FLEET: "on" }), true);
  });

  it("lists started machines and skips this process", () => {
    const machines = parseFlyMachineList([
      { id: "860792be4622e8", state: "started", name: "sparkling-violet" },
      { id: "8e4766c7d59608", state: "started", name: "snowy-wood" },
      { id: "839744b76061e8", state: "stopped", name: "summer-voice" },
    ]);
    assert.deepEqual(startedMachineIds(machines, "8e4766c7d59608"), ["860792be4622e8"]);
  });

  it("sums the live 2026-09-29 split without inventing payers or doubling benches", () => {
    const violet = volume("860792be4622e8", (doc) => {
      doc.generated_at = "2026-09-29T17:13:52Z";
      doc.sentinel.active_watchers = 2;
      doc.sentinel.checks_run = 3127;
      doc.sentinel.change_events = 8;
      doc.sentinel.by_detector.status_change = { watchers: 1, change_events: 0 };
      doc.sentinel.by_detector.keyword = { watchers: 1, change_events: 8 };
      doc.intents.lead_submit.l30d = {
        paid_calls: 0,
        receipts: 0,
        by_verdict: { confirmed: 0, failed: 0, unknown: 0 },
      };
      doc.intents.order_placed.l30d = {
        paid_calls: 0,
        receipts: 0,
        by_verdict: { confirmed: 0, failed: 0, unknown: 0 },
      };
      doc.store.confirm_unscoped_paid_calls = { l7d: 0, l30d: 0 };
    });
    const snowy = volume("8e4766c7d59608", (doc) => {
      doc.generated_at = "2026-09-29T17:13:53Z";
      doc.sentinel.active_watchers = 0;
      doc.sentinel.checks_run = 0;
      doc.sentinel.change_events = 0;
      doc.intents.lead_submit.l30d = {
        paid_calls: 0,
        receipts: 1,
        by_verdict: { confirmed: 1, failed: 0, unknown: 0 },
      };
      doc.intents.order_placed.l30d = {
        paid_calls: 0,
        receipts: 1,
        by_verdict: { confirmed: 0, failed: 0, unknown: 1 },
      };
      doc.store.confirm_unscoped_paid_calls = { l7d: 0, l30d: 3 };
    });

    const merged = mergeFleetStats(snowy, [{ doc: violet, machineId: violet.store.fly_machine_id, included: true }]);
    assert.equal(merged.store.scope, "fleet_volumes");
    assert.equal(merged.store.fly_machine_id, "8e4766c7d59608");
    assert.equal(merged.sentinel.active_watchers, 2);
    assert.equal(merged.sentinel.checks_run, 3127);
    assert.equal(merged.sentinel.change_events, 8);
    assert.equal(merged.sentinel.by_detector.keyword.watchers, 1);
    assert.equal(merged.sentinel.by_detector.keyword.change_events, 8);
    assert.equal(merged.sentinel.by_detector.status_change.watchers, 1);
    assert.equal(merged.intents.lead_submit.l30d.paid_calls, 0);
    assert.equal(merged.intents.lead_submit.l30d.receipts, 1);
    assert.equal(merged.intents.lead_submit.l30d.by_verdict.confirmed, 1);
    assert.equal(merged.intents.order_placed.l30d.receipts, 1);
    assert.equal(merged.intents.order_placed.l30d.paid_calls, 0);
    assert.equal(merged.intents.order_placed.l30d.by_verdict.unknown, 1);
    assert.deepEqual(merged.store.confirm_unscoped_paid_calls, { l7d: 0, l30d: 3 });
    assert.equal(merged.sentinel.benches.median_latency_ms, violet.sentinel.benches.median_latency_ms);
    assert.equal(merged.sentinel.benches.false_positive_rate.n_checks, 198);
    assert.equal(merged.benches.lead_submit.n, violet.benches.lead_submit.n);
    assert.equal(merged.generated_at, "2026-09-29T17:13:53Z");
    assert.match(merged.notes.join(" "), /extensions\.bazaar/);
    assert.doesNotMatch(merged.notes.join(" "), /Bazaar GA is held/);
    assert.match(merged.notes.join(" "), /3 L30d/);
    assert.match(merged.store.note, /fleet_volumes/);
  });

  it("omits a failed peer instead of treating it as zero, and does not double-count one machine", () => {
    const local = volume("8e4766c7d59608", (doc) => {
      doc.sentinel.active_watchers = 0;
      doc.sentinel.checks_run = 0;
    });
    const partial = mergeFleetStats(local, [
      { machineId: "860792be4622e8", included: false, error: "HTTP 503" },
    ]);
    assert.equal(partial.store.scope, "partial_fleet_volumes");
    assert.equal(partial.sentinel.active_watchers, 0);
    assert.equal(partial.traffic.all.payers.l7d.verify.unique_payers, null);
    assert.match(partial.store.note, /incomplete/);
    assert.match(partial.store.note, /unique_payers is null/);
    assert.match(partial.notes.join(" "), /not treated as zero/);

    const peer = volume("860792be4622e8", (doc) => {
      doc.sentinel.active_watchers = 2;
      doc.sentinel.checks_run = 10;
    });
    const doubled = mergeFleetStats(peer, [
      { doc: peer, machineId: peer.store.fly_machine_id, included: true },
      { doc: structuredClone(peer), machineId: peer.store.fly_machine_id, included: true },
    ]);
    assert.equal(doubled.sentinel.active_watchers, 2);
    assert.equal(doubled.sentinel.checks_run, 10);
  });

  it("stays on this volume on Fly unless fleet summing is enabled", async () => {
    let fetched = false;
    const doc = await buildPublicStatsDocument({
      env: { FLY_APP_NAME: "livecheck", FLY_MACHINE_ID: "8e4766c7d59608" },
      useCache: false,
      fetchImpl: async () => {
        fetched = true;
        throw new Error("fetch should not run when fleet summing is off");
      },
    });
    assert.equal(fetched, false);
    assert.equal(doc.store.scope, "this_machine_volume");
    assert.equal(typeof doc.traffic.all.payers.l7d.verify.unique_payers, "number");
    assert.match(doc.traffic.note, /COUNT\(DISTINCT payer\)/);
    assert.match(doc.traffic.label, /Includes internal test traffic/);
  });

  it("fleet mode with only this machine keeps local distinct counts", async () => {
    const calls: string[] = [];
    const doc = await buildPublicStatsDocument({
      env: {
        FLY_APP_NAME: "livecheck",
        FLY_MACHINE_ID: "8e4766c7d59608",
        LIVECHECK_STATS_FLEET: "1",
        PORT: "43127",
      },
      useCache: false,
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        assert.doesNotMatch(url, /\/stats/);
        return new Response(JSON.stringify([{ id: "8e4766c7d59608", state: "started", name: "snowy-wood" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    assert.deepEqual(calls.map((url) => new URL(url).pathname), ["/v1/apps/livecheck/machines"]);
    assert.equal(doc.store.scope, "this_machine_volume");
    assert.equal(typeof doc.traffic.all.payers.l7d.verify.unique_payers, "number");
    assert.match(doc.store.note, /COUNT\(DISTINCT payer\)/);
  });

  it("stays on this volume when FLY_APP_NAME is unset", async () => {
    const doc = await buildPublicStatsDocument({
      env: {},
      fetchImpl: async () => {
        throw new Error("fetch should not run off Fly");
      },
      useCache: false,
    });
    assert.equal(doc.store.scope, "this_machine_volume");
    assert.match(doc.notes.join(" "), /extensions\.bazaar/);
    assert.doesNotMatch(doc.notes.join(" "), /Bazaar GA is held/);
  });

  it("fetches started peers over the private network and sums them", async () => {
    const peer = volume("860792be4622e8", (doc) => {
      doc.sentinel.active_watchers = 2;
      doc.sentinel.checks_run = 3127;
      doc.sentinel.change_events = 8;
    });
    const calls: string[] = [];
    const before = buildStatsDocument();
    const doc = await buildPublicStatsDocument({
      env: {
        FLY_APP_NAME: "livecheck",
        FLY_MACHINE_ID: "8e4766c7d59608",
        LIVECHECK_STATS_FLEET: "1",
        PORT: "43127",
      },
      useCache: false,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(url);
        assert.equal(new Headers(init?.headers).get("x-livecheck-stats-scope"), url.includes("/stats") ? "local" : null);
        if (url.includes("/machines")) {
          return new Response(
            JSON.stringify([
              { id: "8e4766c7d59608", state: "started" },
              { id: "860792be4622e8", state: "started" },
              { id: "839744b76061e8", state: "stopped" },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        assert.match(url, /^http:\/\/860792be4622e8\.vm\.livecheck\.internal:43127\/stats\?format=json&scope=local$/);
        return new Response(JSON.stringify(peer), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    assert.deepEqual(calls.map((url) => new URL(url).pathname), [
      "/v1/apps/livecheck/machines",
      "/stats",
    ]);
    assert.equal(doc.store.scope, "fleet_volumes");
    assert.equal(doc.sentinel.active_watchers, before.sentinel.active_watchers + 2);
    assert.equal(doc.sentinel.checks_run, before.sentinel.checks_run + 3127);
    assert.equal(doc.sentinel.change_events, before.sentinel.change_events + 8);
    assert.equal(doc.store.machines?.filter((machine) => machine.included).length, 2);
    assert.equal(doc.traffic.all.payers.l7d.verify.unique_payers, null);
    assert.match(doc.traffic.note, /not a fleet-wide distinct/);
    assert.match(doc.traffic.label, /Includes internal test traffic/);
  });

  it("sums the wallet split and does not treat a pre-split peer as external", () => {
    const local = volume("8e4766c7d59608", (doc) => {
      doc.sentinel.active_watchers = 0;
      doc.sentinel.checks_run = 1;
      doc.sentinel.change_events = 0;
      doc.traffic.all.sentinel.active_watchers = 0;
      doc.traffic.all.sentinel.checks_run = 1;
      doc.traffic.all.sentinel.checks_run_unattributed = 1;
      doc.traffic.external.sentinel.active_watchers = 0;
      doc.traffic.external.sentinel.checks_run = 1;
      doc.traffic.external.sentinel.checks_run_unattributed = 1;
      doc.traffic.all.payers.available = true;
      doc.traffic.external.payers.available = true;
      doc.traffic.all.payers.l7d.verify = { calls: 2, unique_payers: 2 };
      doc.traffic.external.payers.l7d.verify = { calls: 1, unique_payers: 1 };
    });
    const peer = volume("860792be4622e8", (doc) => {
      doc.sentinel.active_watchers = 2;
      doc.sentinel.checks_run = 10;
      doc.traffic.all.sentinel.active_watchers = 2;
      doc.traffic.all.sentinel.checks_run = 10;
      doc.traffic.external.sentinel.active_watchers = 0;
      doc.traffic.external.sentinel.checks_run = 0;
      doc.traffic.all.payers.available = true;
      doc.traffic.external.payers.available = true;
      doc.traffic.all.payers.l7d.verify = { calls: 3, unique_payers: 1 };
      doc.traffic.external.payers.l7d.verify = { calls: 0, unique_payers: 0 };
    });
    const merged = mergeFleetStats(local, [{ doc: peer, machineId: peer.store.fly_machine_id, included: true }]);
    assert.equal(merged.sentinel.active_watchers, 2);
    assert.equal(merged.sentinel.checks_run, 11);
    assert.equal(merged.traffic.all.sentinel.active_watchers, 2);
    assert.equal(merged.traffic.all.sentinel.checks_run, 11);
    assert.equal(merged.traffic.external.sentinel.active_watchers, 0);
    assert.equal(merged.traffic.external.sentinel.checks_run, 1);
    assert.equal(merged.traffic.all.payers.l7d.verify.calls, 5);
    assert.equal(merged.traffic.all.payers.l7d.verify.unique_payers, null);
    assert.equal(merged.traffic.external.payers.l7d.verify.unique_payers, null);
    assert.equal(merged.traffic.all.payers.l30d.verify.unique_payers, null);
    assert.equal(merged.traffic.external.payers.l7d.verify.calls, 1);
    assert.match(statsHtml(merged), /withheld/);
    assert.doesNotMatch(statsHtml(merged), /unique payers add per volume/);
    assert.equal(merged.traffic.external_complete, true);
    assert.match(merged.traffic.note, /not a fleet-wide distinct/);
    assert.match(merged.notes[0] ?? "", /Includes internal test traffic/);

    const legacy = volume("860792be4622e8", (doc) => {
      doc.sentinel.active_watchers = 2;
      doc.sentinel.checks_run = 3127;
      delete (doc as { traffic?: unknown }).traffic;
    });
    const partial = mergeFleetStats(local, [{ doc: legacy, machineId: "860792be4622e8", included: true }]);
    assert.equal(partial.sentinel.active_watchers, 2);
    assert.equal(partial.sentinel.checks_run, 3128);
    assert.equal(partial.traffic.external_complete, false);
    assert.equal(partial.traffic.all.sentinel.active_watchers, 2);
    assert.equal(partial.traffic.all.sentinel.checks_run, 3128);
    assert.equal(partial.traffic.external.sentinel.active_watchers, 0);
    assert.equal(partial.traffic.external.sentinel.checks_run, 1);
    assert.equal(partial.traffic.all.payers.available, false);
    assert.match(partial.traffic.note, /incomplete/);
  });

  it("marks the fleet partial when discovery fails and no peer list is configured", async () => {
    const doc = await buildPublicStatsDocument({
      env: {
        FLY_APP_NAME: "livecheck",
        FLY_MACHINE_ID: "8e4766c7d59608",
        LIVECHECK_STATS_FLEET: "1",
      },
      useCache: false,
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    assert.equal(doc.store.scope, "partial_fleet_volumes");
    assert.equal(doc.traffic.all.payers.l7d.verify.unique_payers, null);
    assert.match(doc.store.machines?.find((machine) => !machine.included)?.error ?? "", /HTTP 500/);
  });
});
