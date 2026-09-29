import { DEFAULT_PORT } from "./config.js";
import {
  FLEET_VOLUME_NOTE,
  PARTIAL_FLEET_VOLUME_NOTE,
  statsNotes,
  type IntentWindow,
  type StatsDocument,
  type StatsMachineContribution,
  buildStatsDocument,
} from "./stats.js";
import { SENTINEL_DETECTORS } from "./watch-store.js";

const PEER_TTL_MS = 15_000;
const PEER_TIMEOUT_MS = 2_500;

type PeerCacheEntry = { at: number; doc: StatsDocument };

const peerCache = new Map<string, PeerCacheEntry>();

export function clearStatsFleetCache(): void {
  peerCache.clear();
}

export function statsScopeIsLocal(header: string | undefined, query: string | undefined): boolean {
  return (header ?? "").trim().toLowerCase() === "local" || (query ?? "").trim().toLowerCase() === "local";
}

type FlyMachine = { id: string; state?: string };

export function parseFlyMachineList(body: unknown): FlyMachine[] {
  const list = Array.isArray(body)
    ? body
    : body && typeof body === "object" && Array.isArray((body as { machines?: unknown }).machines)
      ? (body as { machines: unknown[] }).machines
      : [];
  const machines: FlyMachine[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const id = (item as { id?: unknown }).id;
    if (typeof id !== "string" || !id.trim()) continue;
    const state = (item as { state?: unknown }).state;
    machines.push({ id: id.trim(), state: typeof state === "string" ? state : undefined });
  }
  return machines;
}

export function startedMachineIds(machines: readonly FlyMachine[], selfId: string | null): string[] {
  const ids: string[] = [];
  for (const machine of machines) {
    const id = flyMachineId(machine.id);
    if (!id) continue;
    if (machine.state && machine.state !== "started") continue;
    if (selfId && id === selfId) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

function isLocalStatsDocument(value: unknown): value is StatsDocument {
  if (!value || typeof value !== "object") return false;
  const doc = value as StatsDocument;
  return (
    doc.ok === true &&
    doc.service === "livecheck" &&
    doc.store?.scope === "this_machine_volume" &&
    typeof doc.sentinel?.active_watchers === "number" &&
    typeof doc.sentinel?.checks_run === "number" &&
    typeof doc.sentinel?.change_events === "number" &&
    typeof doc.intents?.lead_submit?.l30d?.paid_calls === "number" &&
    typeof doc.intents?.lead_submit?.l30d?.receipts === "number"
  );
}

function sumWindow(left: IntentWindow, right: IntentWindow): IntentWindow {
  return {
    paid_calls: left.paid_calls + right.paid_calls,
    receipts: left.receipts + right.receipts,
    by_verdict: {
      confirmed: left.by_verdict.confirmed + right.by_verdict.confirmed,
      failed: left.by_verdict.failed + right.by_verdict.failed,
      unknown: left.by_verdict.unknown + right.by_verdict.unknown,
    },
  };
}

export type FleetPeerResult = {
  doc?: StatsDocument;
  machineId: string | null;
  included: boolean;
  error?: string;
};

/**
 * Sum partitioned volume counters. CI benches and prices stay from `local`
 * (they are image artifacts and route constants, not per-volume rows).
 * A peer that is not included contributes nothing — it is not filled with zeros.
 */
export function mergeFleetStats(local: StatsDocument, peers: readonly FleetPeerResult[]): StatsDocument {
  const includedPeers = peers.filter((peer) => peer.included && peer.doc);
  const failed = peers.some((peer) => !peer.included);
  const complete = !failed;
  const machines: StatsMachineContribution[] = [
    { fly_machine_id: local.store.fly_machine_id, included: true },
    ...peers.map((peer) => ({
      fly_machine_id: peer.machineId,
      included: peer.included,
      ...(peer.error ? { error: peer.error } : {}),
    })),
  ];
  const unscoped = {
    l7d: local.store.confirm_unscoped_paid_calls.l7d,
    l30d: local.store.confirm_unscoped_paid_calls.l30d,
  };
  let sentinel = {
    active_watchers: local.sentinel.active_watchers,
    checks_run: local.sentinel.checks_run,
    change_events: local.sentinel.change_events,
    by_detector: {
      status_change: { ...local.sentinel.by_detector.status_change },
      keyword: { ...local.sentinel.by_detector.keyword },
      text_diff: { ...local.sentinel.by_detector.text_diff },
      numeric_threshold: { ...local.sentinel.by_detector.numeric_threshold },
    },
  };
  let intents = {
    lead_submit: {
      l7d: local.intents.lead_submit.l7d,
      l30d: local.intents.lead_submit.l30d,
    },
    listing_published: {
      l7d: local.intents.listing_published.l7d,
      l30d: local.intents.listing_published.l30d,
    },
    order_placed: {
      l7d: local.intents.order_placed.l7d,
      l30d: local.intents.order_placed.l30d,
    },
  };
  let generatedAt = local.generated_at;
  const seen = new Set<string>();
  if (local.store.fly_machine_id) seen.add(local.store.fly_machine_id);

  for (const peer of includedPeers) {
    const doc = peer.doc;
    if (!doc) continue;
    const id = doc.store.fly_machine_id ?? peer.machineId;
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    if (doc.generated_at > generatedAt) generatedAt = doc.generated_at;
    unscoped.l7d += doc.store.confirm_unscoped_paid_calls.l7d;
    unscoped.l30d += doc.store.confirm_unscoped_paid_calls.l30d;
    sentinel = {
      active_watchers: sentinel.active_watchers + doc.sentinel.active_watchers,
      checks_run: sentinel.checks_run + doc.sentinel.checks_run,
      change_events: sentinel.change_events + doc.sentinel.change_events,
      by_detector: sentinel.by_detector,
    };
    for (const detector of SENTINEL_DETECTORS) {
      const left = sentinel.by_detector[detector];
      const right = doc.sentinel.by_detector[detector];
      sentinel.by_detector[detector] = {
        watchers: left.watchers + (right?.watchers ?? 0),
        change_events: left.change_events + (right?.change_events ?? 0),
      };
    }
    intents = {
      lead_submit: {
        l7d: sumWindow(intents.lead_submit.l7d, doc.intents.lead_submit.l7d),
        l30d: sumWindow(intents.lead_submit.l30d, doc.intents.lead_submit.l30d),
      },
      listing_published: {
        l7d: sumWindow(intents.listing_published.l7d, doc.intents.listing_published.l7d),
        l30d: sumWindow(intents.listing_published.l30d, doc.intents.listing_published.l30d),
      },
      order_placed: {
        l7d: sumWindow(intents.order_placed.l7d, doc.intents.order_placed.l7d),
        l30d: sumWindow(intents.order_placed.l30d, doc.intents.order_placed.l30d),
      },
    };
  }

  const volumeNote = complete ? FLEET_VOLUME_NOTE : PARTIAL_FLEET_VOLUME_NOTE;
  return {
    ...local,
    generated_at: generatedAt,
    intents: {
      lead_submit: { ...local.intents.lead_submit, ...intents.lead_submit },
      listing_published: { ...local.intents.listing_published, ...intents.listing_published },
      order_placed: { ...local.intents.order_placed, ...intents.order_placed },
    },
    sentinel: {
      ...local.sentinel,
      ...sentinel,
    },
    store: {
      ...local.store,
      scope: complete ? "fleet_volumes" : "partial_fleet_volumes",
      machines,
      confirm_unscoped_paid_calls: unscoped,
      note: volumeNote,
    },
    notes: statsNotes(unscoped, volumeNote, "fleet"),
  };
}

function listenPort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT?.trim();
  if (!raw) return DEFAULT_PORT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PORT;
}

function flyMachineId(value: string): string | null {
  const id = value.trim().toLowerCase();
  return /^[a-f0-9]{8,32}$/.test(id) ? id : null;
}

function peerIdsFromEnv(env: NodeJS.ProcessEnv, selfId: string | null): string[] {
  const raw = env.LIVECHECK_STATS_PEERS ?? "";
  const ids: string[] = [];
  for (const part of raw.split(",")) {
    const id = flyMachineId(part);
    if (!id || (selfId && id === selfId) || ids.includes(id)) continue;
    ids.push(id);
  }
  return ids;
}

async function listStartedPeers(
  app: string,
  selfId: string | null,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const res = await fetchImpl(`http://_api.internal:4280/v1/apps/${encodeURIComponent(app)}/machines`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`machines api HTTP ${res.status}`);
  const body: unknown = await res.json();
  return startedMachineIds(parseFlyMachineList(body), selfId);
}

async function fetchPeerStats(
  app: string,
  machineId: string,
  port: number,
  selfId: string | null,
  fetchImpl: typeof fetch,
  useCache: boolean,
): Promise<FleetPeerResult> {
  if (useCache) {
    const cached = peerCache.get(machineId);
    if (cached && Date.now() - cached.at < PEER_TTL_MS) {
      return { doc: cached.doc, machineId, included: true };
    }
  }
  const url = `http://${machineId}.vm.${app}.internal:${port}/stats?format=json&scope=local`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: "application/json",
        "x-livecheck-stats-scope": "local",
      },
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    if (!isLocalStatsDocument(body)) throw new Error("peer did not return this_machine_volume stats");
    if (selfId && body.store.fly_machine_id === selfId) {
      throw new Error("peer answered as this machine");
    }
    if (useCache) peerCache.set(machineId, { at: Date.now(), doc: body });
    return { doc: body, machineId: body.store.fly_machine_id ?? machineId, included: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { machineId, included: false, error: message };
  }
}

export type PublicStatsOptions = {
  now?: Date;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  useCache?: boolean;
};

/**
 * Public honesty document. Off Fly (no FLY_APP_NAME) this is the local volume.
 * On Fly it sums started peers over the private network. Peer failure is a
 * partial scope, not a silent zero.
 */
export async function buildPublicStatsDocument(options: PublicStatsOptions = {}): Promise<StatsDocument> {
  const env = options.env ?? process.env;
  const local = buildStatsDocument(options.now);
  const app = env.FLY_APP_NAME?.trim().toLowerCase() ?? "";
  if (!/^[a-z0-9-]+$/.test(app)) return local;

  const selfId = env.FLY_MACHINE_ID?.trim() || local.store.fly_machine_id;
  const fetchImpl = options.fetchImpl ?? fetch;
  const useCache = options.useCache !== false;
  let peerIds: string[] = [];
  let discoveryError: string | undefined;
  try {
    peerIds = await listStartedPeers(app, selfId, fetchImpl);
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    peerIds = peerIdsFromEnv(env, selfId);
  }

  if (discoveryError && peerIds.length === 0) {
    console.warn(`[stats] fleet discovery failed: ${discoveryError}`);
    return mergeFleetStats(local, [
      { machineId: null, included: false, error: discoveryError },
    ]);
  }

  const port = listenPort(env);
  const peers = await Promise.all(
    peerIds.map((id) => fetchPeerStats(app, id, port, selfId, fetchImpl, useCache)),
  );
  for (const peer of peers) {
    if (!peer.included) {
      console.warn(`[stats] fleet peer ${peer.machineId ?? "unknown"} omitted: ${peer.error ?? "unknown"}`);
    }
  }
  return mergeFleetStats(local, peers);
}
