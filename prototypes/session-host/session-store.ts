// PROTOTYPE (JWB-332) — throwaway durable adapter. Not the keeper.
//
// Two owners, one SQLite file, held apart by table:
//   * session_events  — the WAYFINDER control plane. Append-only; the durable
//     lane<->session mapping is a pure fold of this log (projectSession).
//   * host_registry   — simulated HOST-owned session state (what a real session
//     host such as T3 would keep on its side). Includes a steering inbox so a
//     reconnecting control surface can prove an instruction reached the session.
//
// Both are re-attachable: a fresh OS process opens the same path and recovers
// everything. WAL + strict + foreign_keys mirror the shipped store conventions.

import { Database } from "bun:sqlite";

import {
  type AgentInvocation,
  applySessionEvent,
  projectSession,
  type SessionEvent,
  type SessionHostKind,
  type SessionLifecycle,
  type SessionRecord,
} from "./session-host-protocol.ts";

export type AppendResult =
  | { ok: true; record: SessionRecord; seq: number }
  | { ok: false; code: string; reason: string };

interface EventRow {
  payload_json: string;
}

/** The Wayfinder-owned append-only mapping log. */
export class SessionStore {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lane TEXT NOT NULL,
        seq INTEGER NOT NULL,
        kind TEXT NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(lane, seq)
      )
    `);
    this.#db.exec(
      "CREATE INDEX IF NOT EXISTS idx_session_events_lane ON session_events(lane, seq)",
    );
  }

  /**
   * Authorize-and-apply one event inside a transaction that re-projects current
   * state from the durable log first, so concurrent processes never clobber the
   * mapping. `seq` is the reducer's monotonic version, guarded by UNIQUE(lane,seq).
   */
  append(event: SessionEvent): AppendResult {
    const tx = this.#db.transaction((): AppendResult => {
      const current = this.#project(event.lane);
      const reduction = applySessionEvent(current, event);
      if (!reduction.ok) return { ok: false, code: reduction.code, reason: reduction.reason };
      const seq = reduction.record.version;
      this.#db
        .query(
          `INSERT INTO session_events (lane, seq, kind, actor, at, payload_json)
           VALUES ($lane, $seq, $kind, $actor, $at, $payload)`,
        )
        .run({
          lane: event.lane,
          seq,
          kind: event.kind,
          actor: event.actor,
          at: event.at,
          payload: JSON.stringify(event),
        });
      return { ok: true, record: reduction.record, seq };
    });
    return tx();
  }

  events(lane: string): SessionEvent[] {
    const rows = this.#db
      .query("SELECT payload_json FROM session_events WHERE lane = $lane ORDER BY seq ASC")
      .all({ lane }) as EventRow[];
    return rows.map((row) => JSON.parse(row.payload_json) as SessionEvent);
  }

  project(lane: string): SessionRecord | undefined {
    return this.#project(lane);
  }

  lanes(): SessionRecord[] {
    const rows = this.#db
      .query("SELECT DISTINCT lane FROM session_events ORDER BY lane ASC")
      .all() as { lane: string }[];
    const records: SessionRecord[] = [];
    for (const row of rows) {
      const record = this.#project(row.lane);
      if (record) records.push(record);
    }
    return records;
  }

  close(): void {
    this.#db.close();
  }

  #project(lane: string): SessionRecord | undefined {
    return projectSession(this.events(lane));
  }
}

// ---------------------------------------------------------------------------
// Simulated host-owned session state. A real session host keeps this itself; we
// persist it so the prototype can prove durability + reattach across OS processes.
// ---------------------------------------------------------------------------

export interface HostSession {
  host: SessionHostKind;
  sessionId: string;
  lane: string;
  pid: number;
  agent: AgentInvocation;
  lifecycle: SessionLifecycle;
  detail: string;
  inbox: string[];
  startedAt: string;
  updatedAt: string;
}

interface HostRow {
  host: string;
  session_id: string;
  lane: string;
  pid: number;
  agent_json: string;
  lifecycle: string;
  detail: string;
  inbox_json: string;
  started_at: string;
  updated_at: string;
}

export class HostRegistry {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec("PRAGMA foreign_keys = ON");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS host_registry (
        host TEXT NOT NULL,
        session_id TEXT NOT NULL,
        lane TEXT NOT NULL,
        pid INTEGER NOT NULL,
        agent_json TEXT NOT NULL,
        lifecycle TEXT NOT NULL,
        detail TEXT NOT NULL,
        inbox_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (host, session_id)
      )
    `);
  }

  put(session: HostSession): void {
    this.#db
      .query(
        `INSERT OR REPLACE INTO host_registry
           (host, session_id, lane, pid, agent_json, lifecycle, detail, inbox_json, started_at, updated_at)
         VALUES ($host, $session_id, $lane, $pid, $agent_json, $lifecycle, $detail, $inbox_json, $started_at, $updated_at)`,
      )
      .run({
        host: session.host,
        session_id: session.sessionId,
        lane: session.lane,
        pid: session.pid,
        agent_json: JSON.stringify(session.agent),
        lifecycle: session.lifecycle,
        detail: session.detail,
        inbox_json: JSON.stringify(session.inbox),
        started_at: session.startedAt,
        updated_at: session.updatedAt,
      });
  }

  get(host: SessionHostKind, sessionId: string): HostSession | undefined {
    const row = this.#db
      .query("SELECT * FROM host_registry WHERE host = $host AND session_id = $session_id")
      .get({ host, session_id: sessionId }) as HostRow | null;
    return row ? this.#hydrate(row) : undefined;
  }

  setLifecycle(
    host: SessionHostKind,
    sessionId: string,
    lifecycle: SessionLifecycle,
    detail: string,
    at: string,
  ): void {
    this.#db
      .query(
        `UPDATE host_registry SET lifecycle = $lifecycle, detail = $detail, updated_at = $updated_at
         WHERE host = $host AND session_id = $session_id`,
      )
      .run({ host, session_id: sessionId, lifecycle, detail, updated_at: at });
  }

  pushInbox(host: SessionHostKind, sessionId: string, instruction: string, at: string): void {
    const current = this.get(host, sessionId);
    if (!current) return;
    const inbox = [...current.inbox, instruction];
    this.#db
      .query(
        `UPDATE host_registry SET inbox_json = $inbox_json, updated_at = $updated_at
         WHERE host = $host AND session_id = $session_id`,
      )
      .run({ host, session_id: sessionId, inbox_json: JSON.stringify(inbox), updated_at: at });
  }

  all(): HostSession[] {
    const rows = this.#db
      .query("SELECT * FROM host_registry ORDER BY started_at ASC")
      .all() as HostRow[];
    return rows.map((row) => this.#hydrate(row));
  }

  close(): void {
    this.#db.close();
  }

  #hydrate(row: HostRow): HostSession {
    return {
      host: row.host as SessionHostKind,
      sessionId: row.session_id,
      lane: row.lane,
      pid: row.pid,
      agent: JSON.parse(row.agent_json) as AgentInvocation,
      lifecycle: row.lifecycle as SessionLifecycle,
      detail: row.detail,
      inbox: JSON.parse(row.inbox_json) as string[],
      startedAt: row.started_at,
      updatedAt: row.updated_at,
    };
  }
}
