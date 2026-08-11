import { Database } from "bun:sqlite";
import type { Run, RunRef } from "./domain.ts";

const schema = `
CREATE TABLE IF NOT EXISTS runs (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  workspace_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS claims (
  ref TEXT PRIMARY KEY,
  ticket TEXT NOT NULL,
  human_owner TEXT NOT NULL,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  previous_state_json TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  lease_expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS transaction_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  state TEXT NOT NULL,
  receipt_json TEXT,
  error_text TEXT,
  occurred_at TEXT NOT NULL
);`;

interface RunRow {
  ref: RunRef;
  ticket: Run["ticket"];
  harness: Run["harness"];
  model: string | null;
  workspace_json: string;
  capabilities_json: string;
  status: Run["status"];
  created_at: string;
  updated_at: string;
}

export class StateStore {
  readonly #database: Database;

  constructor(path: string) {
    if (!path) throw new Error("Database path is required");
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec(schema);
  }

  close(): void {
    this.#database.close();
  }

  saveRun(run: Run): void {
    this.#database
      .query(`INSERT INTO runs(ref,ticket,harness,model,workspace_json,capabilities_json,status,created_at,updated_at)
        VALUES($ref,$ticket,$harness,$model,$workspace,$capabilities,$status,$createdAt,$updatedAt)
        ON CONFLICT(ref) DO UPDATE SET model=excluded.model,workspace_json=excluded.workspace_json,
          capabilities_json=excluded.capabilities_json,status=excluded.status,updated_at=excluded.updated_at`)
      .run({
        ref: run.ref,
        ticket: run.ticket,
        harness: run.harness,
        model: run.model ?? null,
        workspace: JSON.stringify(run.workspace),
        capabilities: JSON.stringify(run.capabilities),
        status: run.status,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
      });
  }

  run(ref: RunRef): Run {
    const row = this.#database.query("SELECT * FROM runs WHERE ref=?").get(ref) as RunRow | null;
    if (!row) throw new Error(`Run not found: ${ref}`);
    return {
      ref: row.ref,
      ticket: row.ticket,
      harness: row.harness,
      ...(row.model ? { model: row.model } : {}),
      workspace: JSON.parse(row.workspace_json),
      capabilities: JSON.parse(row.capabilities_json),
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listRuns(): Run[] {
    const rows = this.#database
      .query("SELECT ref FROM runs ORDER BY created_at DESC")
      .all() as Array<{ ref: RunRef }>;
    return rows.map(({ ref }) => this.run(ref));
  }

  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void {
    this.#database
      .query(`INSERT INTO transaction_steps(run_ref,state,receipt_json,error_text,occurred_at)
        VALUES(?,?,?,?,?)`)
      .run(
        run,
        state,
        receipt === undefined ? null : JSON.stringify(receipt),
        error === undefined ? null : errorMessage(error),
        new Date().toISOString(),
      );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
