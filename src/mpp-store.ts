import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Shared atomic store for mppx (replay protection, challenge state).
 *
 * mppx 0.13 refuses to build a Stripe Tempo method without a store that has
 * an atomic `update`. Memory would forget spent transaction hashes on every
 * restart, so this is SQLite on the Fly volume, next to paid-calls.sqlite.
 *
 * node:sqlite is synchronous and Livecheck runs one Node process per
 * machine, so a read-modify-write inside one synchronous call is atomic.
 * A second machine would need a shared store (Redis/Upstash) instead.
 */

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mpp_kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export type MppStoreChange<V, R> =
  | { op: "noop"; result: R }
  | { op: "set"; value: V; result: R }
  | { op: "delete"; result: R };

export type MppKvStore = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<void>;
  update: <R>(key: string, fn: (current: unknown) => MppStoreChange<unknown, R>) => Promise<R>;
  close: () => void;
};

export function defaultMppStoreDbPath(): string {
  const fromEnv = process.env.MPP_STORE_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  if (process.env.FLY_APP_NAME?.trim() && existsSync("/data")) return "/data/mpp-store.sqlite";
  return resolve(process.cwd(), "data/mpp-store.sqlite");
}

/** JSON that survives bigint (mppx stores token amounts as bigint). */
export function encodeMppValue(value: unknown): string {
  return JSON.stringify(value, (_key, v) => (typeof v === "bigint" ? { __mppx_bigint: v.toString() } : v));
}

export function decodeMppValue(raw: string): unknown {
  return JSON.parse(raw, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const keys = Object.keys(v);
      if (keys.length === 1 && keys[0] === "__mppx_bigint" && typeof v.__mppx_bigint === "string") {
        return BigInt(v.__mppx_bigint);
      }
    }
    return v;
  });
}

export function openMppStore(path = defaultMppStoreDbPath()): MppKvStore {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }
  db.exec(TABLE_SQL);
  const getStmt = db.prepare("SELECT value FROM mpp_kv WHERE key = ?");
  const putStmt = db.prepare(
    `INSERT INTO mpp_kv (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  );
  const delStmt = db.prepare("DELETE FROM mpp_kv WHERE key = ?");
  const now = () => new Date().toISOString();
  const readSync = (key: string): unknown => {
    const row = getStmt.get(key) as { value?: string } | undefined;
    return row?.value === undefined ? null : decodeMppValue(row.value);
  };
  return {
    async get(key) {
      return readSync(key);
    },
    async put(key, value) {
      putStmt.run(key, encodeMppValue(value), now());
    },
    async delete(key) {
      delStmt.run(key);
    },
    async update(key, fn) {
      // Synchronous from read to write: no other request can interleave.
      db.exec("BEGIN IMMEDIATE");
      try {
        const change = fn(readSync(key));
        if (change.op === "set") putStmt.run(key, encodeMppValue(change.value), now());
        else if (change.op === "delete") delStmt.run(key);
        db.exec("COMMIT");
        return change.result;
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      }
    },
    close() {
      try {
        db.close();
      } catch {
        // ignore
      }
    },
  };
}
