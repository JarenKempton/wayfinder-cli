// PROTOTYPE (JWB-325) — throwaway durable adapter.
//
// A re-attachable SQLite control plane for lanes, owned by Wayfinder rather than
// by any one process. It mirrors the re-attach patterns already proven in
// src/state.ts (WAL, strict, foreign_keys ON) but stays deliberately minimal.
//
// The lane's truth is an append-only event log. Nothing ever mutates a lane row
// in place; the projection is always recomputed by folding events through the
// pure reducer in lane-protocol.ts. That is exactly what lets a fresh process
// (a restarted orchestrator or a replaced supervisor) re-attach to the same file
// and recover identical lane state without any live in-memory handoff.

import { Database } from "bun:sqlite";
import type { LaneAuthority, LaneEvent, LaneRecord } from "./lane-protocol.ts";
import { applyLaneEvent, authorizeLaneEvent, projectLane } from "./lane-protocol.ts";

export interface AppendResult {
  ok: boolean;
  record?: LaneRecord;
  code?: string;
  reason?: string;
  seq?: number;
}

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

export class LaneStore {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
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
      );
    `);
  }

  /**
   * The single mutation entry point — the "Wayfinder-owned channel". Every
   * append is authorized against the credential and validated against the current
   * projection inside one transaction, so an unauthorized or illegal event never
   * touches the log.
   */
  append(event: LaneEvent, authority: LaneAuthority): AppendResult {
    const auth = authorizeLaneEvent(authority, event);
    if (!auth.ok) return { ok: false, code: auth.code, reason: auth.reason };

    const commit = this.#db.transaction((): AppendResult => {
      const current = this.#project(event.lane);
      const reduction = applyLaneEvent(current, event, authority);
      if (!reduction.ok) return { ok: false, code: reduction.code, reason: reduction.reason };
      const seq = reduction.record.version;
      this.#db
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

  events(lane: string): LaneEvent[] {
    const rows = this.#db
      .query<EventRow, { lane: string }>(
        "SELECT * FROM lane_events WHERE lane = $lane ORDER BY seq ASC",
      )
      .all({ lane });
    return rows.map((row) => JSON.parse(row.payload_json) as LaneEvent);
  }

  lanes(): LaneRecord[] {
    const rows = this.#db
      .query<{ lane: string }, []>("SELECT DISTINCT lane FROM lane_events ORDER BY lane ASC")
      .all();
    const records: LaneRecord[] = [];
    for (const row of rows) {
      const record = this.#project(row.lane);
      if (record) records.push(record);
    }
    return records;
  }

  /**
   * Global policy lives outside any lane. Only an orchestrator/control-plane
   * credential may write it; a worker attempt is rejected before any write.
   */
  setPolicy(key: string, value: unknown, authority: LaneAuthority, at: string): AppendResult {
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
    this.#db
      .query(
        `INSERT INTO lane_policy (key, value_json, updated_by, updated_at)
         VALUES ($key, $value, $by, $at)
         ON CONFLICT (key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`,
      )
      .run({ key, value: JSON.stringify(value), by: authority.principal, at });
    return { ok: true };
  }

  policy(key: string): unknown {
    const row = this.#db
      .query<PolicyRow, { key: string }>("SELECT * FROM lane_policy WHERE key = $key")
      .get({ key });
    return row ? (JSON.parse(row.value_json) as unknown) : undefined;
  }

  close(): void {
    this.#db.close();
  }

  #project(lane: string): LaneRecord | undefined {
    return projectLane(this.events(lane));
  }
}
