// Durable, re-attachable lane control plane (JWB-326).
//
// The lane's truth is an append-only event log owned by Wayfinder rather than by
// any one process, chat, or session host. Nothing ever mutates a lane row in
// place; the projection is always recomputed by folding events through the pure
// reducer in ./lane.ts. That is exactly what lets a fresh process — a restarted
// orchestrator or a replaced supervisor — re-attach to the same file and recover
// identical lane identity and state with no in-memory handoff.
//
// This mirrors the re-attach conventions already proven in src/state.ts (WAL,
// strict mode, foreign_keys ON, additive migrations, transactional writes) and
// deliberately leaves that store untouched so existing run/claim recovery
// semantics are preserved.

import { Database } from "bun:sqlite";
import type { LaneAuthority, LaneEvent, LaneRecord, ReductionCode } from "./lane.ts";
import { applyLaneEvent, authorizeLaneEvent, projectLane } from "./lane.ts";

const schema = `
CREATE TABLE IF NOT EXISTS lane_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lane TEXT NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  role TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE (lane, seq)
);
CREATE INDEX IF NOT EXISTS lane_events_by_lane ON lane_events (lane, seq);
CREATE TABLE IF NOT EXISTS lane_policy (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

interface EventRow {
  lane: string;
  seq: number;
  kind: string;
  actor: string;
  role: string;
  at: string;
  payload_json: string;
}

interface PolicyRow {
  key: string;
  value_json: string;
  updated_by: string;
  updated_at: string;
}

/** Outcome of an attempted append. On rejection, `code`/`reason` explain why. */
export type AppendResult =
  | { ok: true; record: LaneRecord; seq: number }
  | { ok: false; code: ReductionCode; reason: string };

/** Outcome of a global policy write; rejected before any write on bad authority. */
export type PolicyResult = { ok: true } | { ok: false; code: ReductionCode; reason: string };

/** A single durable log entry, for machine-readable history. */
export interface LaneHistoryEntry {
  seq: number;
  kind: LaneEvent["kind"];
  actor: string;
  role: LaneEvent["role"];
  at: string;
}

/**
 * Stable, machine-readable lane status suitable for orchestrators and UIs: the
 * current projection plus its full ordered history and event count. Everything
 * here is derived purely from the durable log.
 */
export interface LaneStatus {
  record: LaneRecord;
  history: LaneHistoryEntry[];
  eventCount: number;
}

export interface PolicyEntry {
  key: string;
  value: unknown;
  updatedBy: string;
  updatedAt: string;
}

export class LaneStore {
  readonly #database: Database;

  constructor(path: string) {
    if (!path) throw new Error("Lane store path is required");
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec(schema);
  }

  close(): void {
    this.#database.close();
  }

  /**
   * The single mutation entry point — the "Wayfinder-owned channel". Every
   * append is authorized against the credential and validated against the
   * current projection inside one transaction, so an unauthorized or illegal
   * event never touches the log. The durable `seq` is the projected record's
   * version; the UNIQUE(lane, seq) constraint makes concurrent appends fail
   * rather than silently interleave (optimistic concurrency).
   */
  append(event: LaneEvent, authority: LaneAuthority): AppendResult {
    const auth = authorizeLaneEvent(authority, event);
    if (!auth.ok) return { ok: false, code: auth.code, reason: auth.reason };

    const commit = this.#database.transaction((): AppendResult => {
      const current = this.#project(event.lane);
      const reduction = applyLaneEvent(current, event, authority);
      if (!reduction.ok) return { ok: false, code: reduction.code, reason: reduction.reason };
      const seq = reduction.record.version;
      this.#database
        .query(
          `INSERT INTO lane_events (lane, seq, kind, actor, role, at, payload_json)
           VALUES ($lane, $seq, $kind, $actor, $role, $at, $payload)`,
        )
        .run({
          lane: event.lane,
          seq,
          kind: event.kind,
          actor: event.actor,
          role: event.role,
          at: event.at,
          payload: JSON.stringify(event),
        });
      return { ok: true, record: reduction.record, seq };
    });

    return commit();
  }

  /** Re-derive a lane projection purely from its durable event log. */
  project(lane: string): LaneRecord | undefined {
    return this.#project(lane);
  }

  /** The full ordered event log for a lane, as originally appended. */
  events(lane: string): LaneEvent[] {
    const rows = this.#database
      .query("SELECT * FROM lane_events WHERE lane=? ORDER BY seq ASC")
      .all(lane) as EventRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as LaneEvent);
  }

  /**
   * Stable machine-readable status/history for a lane (acceptance #4). Returns
   * undefined for an unknown lane so callers can distinguish "no such lane" from
   * a lane with no history.
   */
  status(lane: string): LaneStatus | undefined {
    const rows = this.#database
      .query("SELECT * FROM lane_events WHERE lane=? ORDER BY seq ASC")
      .all(lane) as EventRow[];
    if (rows.length === 0) return undefined;
    const events = rows.map((row) => JSON.parse(row.payload_json) as LaneEvent);
    const record = projectLane(events);
    if (!record) return undefined;
    const history: LaneHistoryEntry[] = rows.map((row) => ({
      seq: row.seq,
      kind: row.kind as LaneEvent["kind"],
      actor: row.actor,
      role: row.role as LaneEvent["role"],
      at: row.at,
    }));
    return { record, history, eventCount: rows.length };
  }

  /** Every known lane's current projection, ordered by lane id. */
  lanes(): LaneRecord[] {
    const rows = this.#database
      .query("SELECT DISTINCT lane FROM lane_events ORDER BY lane ASC")
      .all() as Array<{ lane: string }>;
    const records: LaneRecord[] = [];
    for (const row of rows) {
      const record = this.#project(row.lane);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Global control-plane policy lives outside any lane. Only an orchestrator
   * credential may write it; a worker/supervisor attempt is rejected before any
   * write, reusing the same authorization guard as lane events.
   */
  setPolicy(key: string, value: unknown, authority: LaneAuthority, at: string): PolicyResult {
    const probe: LaneEvent = {
      kind: "policy.set",
      lane: "",
      at,
      actor: authority.principal,
      role: authority.role,
      policy: { key, value },
    };
    const auth = authorizeLaneEvent(authority, probe);
    if (!auth.ok) return { ok: false, code: auth.code, reason: auth.reason };
    this.#database
      .query(
        `INSERT INTO lane_policy (key, value_json, updated_by, updated_at)
         VALUES ($key, $value, $by, $at)
         ON CONFLICT (key) DO UPDATE SET
           value_json=excluded.value_json,
           updated_by=excluded.updated_by,
           updated_at=excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), by: authority.principal, at });
    return { ok: true };
  }

  policy(key: string): unknown {
    const row = this.#database
      .query("SELECT * FROM lane_policy WHERE key=?")
      .get(key) as PolicyRow | null;
    return row ? (JSON.parse(row.value_json) as unknown) : undefined;
  }

  policies(): PolicyEntry[] {
    const rows = this.#database
      .query("SELECT * FROM lane_policy ORDER BY key ASC")
      .all() as PolicyRow[];
    return rows.map((row) => ({
      key: row.key,
      value: JSON.parse(row.value_json),
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
    }));
  }

  #project(lane: string): LaneRecord | undefined {
    return projectLane(this.events(lane));
  }
}
