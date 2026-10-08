import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * MPP retry safety. One row per payment credential (and, for push-mode
 * credentials, per Tempo tx hash). A retry that carries the same credential
 * or the same tx never reaches settlement again:
 *
 * - `done`: the original 200 answer (body + receipt) is returned as-is.
 * - `pending`: another request is settling it right now -> 409, retry later.
 * - `unconfirmed`: settle threw. A retry re-runs mppx verification for the
 *   SAME payment (mppx's own atomic store blocks a second charge for one tx);
 *   if mppx refuses it, the caller gets the original 503 again, never a fresh
 *   402 that would invite a second payment.
 *
 * Rows hold the answer (which names the checked URL), so they are kept only
 * MPP_RESULT_TTL_HOURS (default 48) in the operational mpp-store file, never in
 * the privacy-safe paid_calls store. After that, mppx replay protection still
 * refuses the credential (no charge), it just cannot replay the answer.
 */

export type MppResultState = "pending" | "done" | "unconfirmed";

export type StoredResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type MppResultEntry = {
  credential_sha256: string;
  tx?: string;
  route: string;
  request_sha256: string;
  state: MppResultState;
  response?: StoredResponse;
  ts: string;
};

export type ClaimResult =
  | { kind: "claimed" }
  | { kind: "retry_unconfirmed"; original: MppResultEntry }
  | { kind: "existing"; existing: MppResultEntry };

export type MppResultCache = {
  /**
   * Atomically: if no row matches this credential (or tx), insert `pending`
   * and return `claimed`. An `unconfirmed` row for the same request flips to
   * `pending` and returns `retry_unconfirmed`. Anything else is `existing`.
   */
  claim(input: { credential_sha256: string; tx?: string; route: string; request_sha256: string; ts: string }): ClaimResult;
  /** Settle refused the credential (not paid): forget the claim. */
  release(credential_sha256: string): void;
  /** Back to `unconfirmed` with the stored 503 (retry was refused or threw again). */
  restoreUnconfirmed(credential_sha256: string): void;
  complete(
    credential_sha256: string,
    update: { state: "done" | "unconfirmed"; tx?: string; response: StoredResponse },
  ): void;
  get(credential_sha256: string): MppResultEntry | undefined;
  close(): void;
};

const TABLE_SQL = `
CREATE TABLE IF NOT EXISTS mpp_results (
  credential_sha256 TEXT PRIMARY KEY,
  tx TEXT,
  route TEXT NOT NULL,
  request_sha256 TEXT NOT NULL,
  state TEXT NOT NULL,
  response_status INTEGER,
  response_headers TEXT,
  response_body TEXT,
  ts TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mpp_results_tx ON mpp_results(tx) WHERE tx IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mpp_results_updated ON mpp_results(updated_at);
`;

type Row = {
  credential_sha256: string;
  tx: string | null;
  route: string;
  request_sha256: string;
  state: string;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  ts: string;
};

function toEntry(row: Row): MppResultEntry {
  const entry: MppResultEntry = {
    credential_sha256: row.credential_sha256,
    route: row.route,
    request_sha256: row.request_sha256,
    state: row.state as MppResultState,
    ts: row.ts,
  };
  if (row.tx) entry.tx = row.tx;
  if (row.response_status !== null) {
    entry.response = {
      status: Number(row.response_status),
      headers: row.response_headers ? (JSON.parse(row.response_headers) as Record<string, string>) : {},
      body: row.response_body ?? "",
    };
  }
  return entry;
}

/** Next to the mppx store (own file, so the two never contend for a write lock). */
export function defaultMppResultsDbPath(storePath: string): string {
  const fromEnv = process.env.MPP_RESULTS_DB_PATH?.trim();
  if (fromEnv) return fromEnv;
  return storePath === ":memory:" ? ":memory:" : join(dirname(storePath), "mpp-results.sqlite");
}

export function mppResultTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.MPP_RESULT_TTL_HOURS);
  return (Number.isFinite(hours) && hours > 0 ? Math.min(hours, 24 * 30) : 48) * 3_600_000;
}

export function openMppResultCache(path: string, ttlMs = mppResultTtlMs()): MppResultCache {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  if (path !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
  }
  db.exec(TABLE_SQL);
  const byCredential = db.prepare("SELECT * FROM mpp_results WHERE credential_sha256 = ?");
  const byTx = db.prepare("SELECT * FROM mpp_results WHERE tx = ? ORDER BY ts LIMIT 1");
  const insert = db.prepare(
    `INSERT INTO mpp_results (credential_sha256, tx, route, request_sha256, state, ts, updated_at)
     VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
  );
  const setState = db.prepare("UPDATE mpp_results SET state = ?, updated_at = ? WHERE credential_sha256 = ?");
  const del = db.prepare("DELETE FROM mpp_results WHERE credential_sha256 = ? AND state = 'pending'");
  const finish = db.prepare(
    `UPDATE mpp_results SET state = ?, tx = COALESCE(?, tx), response_status = ?, response_headers = ?,
       response_body = ?, updated_at = ? WHERE credential_sha256 = ?`,
  );
  const prune = db.prepare("DELETE FROM mpp_results WHERE updated_at < ? AND state != 'pending'");
  const prunePending = db.prepare("DELETE FROM mpp_results WHERE updated_at < ? AND state = 'pending'");
  const nowIso = () => new Date().toISOString();
  let claims = 0;

  return {
    claim(input) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (++claims % 100 === 1) {
          prune.run(new Date(Date.now() - ttlMs).toISOString());
          // A pending row older than 10 minutes is a crashed request.
          prunePending.run(new Date(Date.now() - 600_000).toISOString());
        }
        const found =
          (byCredential.get(input.credential_sha256) as Row | undefined) ??
          (input.tx ? (byTx.get(input.tx) as Row | undefined) : undefined);
        if (!found) {
          insert.run(input.credential_sha256, input.tx ?? null, input.route, input.request_sha256, input.ts, nowIso());
          db.exec("COMMIT");
          return { kind: "claimed" };
        }
        const existing = toEntry(found);
        if (
          existing.state === "unconfirmed" &&
          existing.credential_sha256 === input.credential_sha256 &&
          existing.request_sha256 === input.request_sha256
        ) {
          setState.run("pending", nowIso(), existing.credential_sha256);
          db.exec("COMMIT");
          return { kind: "retry_unconfirmed", original: existing };
        }
        db.exec("COMMIT");
        return { kind: "existing", existing };
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // already rolled back
        }
        throw error;
      }
    },
    release(credential) {
      del.run(credential);
    },
    restoreUnconfirmed(credential) {
      setState.run("unconfirmed", nowIso(), credential);
    },
    complete(credential, update) {
      finish.run(
        update.state,
        update.tx ?? null,
        update.response.status,
        JSON.stringify(update.response.headers),
        update.response.body,
        nowIso(),
        credential,
      );
    },
    get(credential) {
      const row = byCredential.get(credential) as Row | undefined;
      return row ? toEntry(row) : undefined;
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
