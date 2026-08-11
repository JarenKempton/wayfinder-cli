import { Database } from "bun:sqlite";
import type { Claim, ClaimRef, Run, RunRef } from "./domain.ts";

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
CREATE TABLE IF NOT EXISTS recovery_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_ref TEXT NOT NULL REFERENCES runs(ref),
  outcome TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS supervisor_lock (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  owner TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
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
  execution_json?: string | null;
  observation_json?: string | null;
}

interface ClaimRow {
  ref: ClaimRef;
  ticket: Claim["ticket"];
  human_owner: Claim["humanOwner"];
  run_ref: RunRef;
  previous_state_json: string;
  claimed_at: string;
  lease_expires_at: string;
  status: Claim["status"];
  current_version?: string | null;
  supersedes?: ClaimRef | null;
  superseded_by?: ClaimRef | null;
}

export class StateStore {
  readonly #database: Database;

  constructor(path: string) {
    if (!path) throw new Error("Database path is required");
    this.#database = new Database(path, { create: true, strict: true });
    this.#database.exec("PRAGMA journal_mode=WAL");
    this.#database.exec("PRAGMA foreign_keys=ON");
    this.#database.exec(schema);
    ensureColumn(this.#database, "runs", "execution_json", "TEXT");
    ensureColumn(this.#database, "runs", "observation_json", "TEXT");
    ensureColumn(this.#database, "claims", "current_version", "TEXT");
    ensureColumn(this.#database, "claims", "supersedes", "TEXT");
    ensureColumn(this.#database, "claims", "superseded_by", "TEXT");
  }

  close(): void {
    this.#database.close();
  }

  saveRun(run: Run): void {
    this.#database
      .query(`INSERT INTO runs(ref,ticket,harness,model,workspace_json,capabilities_json,status,created_at,updated_at,execution_json,observation_json)
        VALUES($ref,$ticket,$harness,$model,$workspace,$capabilities,$status,$createdAt,$updatedAt,$execution,$observation)
        ON CONFLICT(ref) DO UPDATE SET model=excluded.model,workspace_json=excluded.workspace_json,
          capabilities_json=excluded.capabilities_json,status=excluded.status,updated_at=excluded.updated_at,
          execution_json=excluded.execution_json,observation_json=excluded.observation_json`)
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
        execution: run.execution ? JSON.stringify(run.execution) : null,
        observation: run.observation ? JSON.stringify(run.observation) : null,
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
      ...(row.execution_json ? { execution: JSON.parse(row.execution_json) } : {}),
      ...(row.observation_json ? { observation: JSON.parse(row.observation_json) } : {}),
    };
  }

  saveClaim(claim: Claim): void {
    this.#database
      .query(`INSERT INTO claims(ref,ticket,human_owner,run_ref,previous_state_json,claimed_at,lease_expires_at,status,current_version,supersedes,superseded_by)
        VALUES($ref,$ticket,$owner,$run,$previous,$claimedAt,$expiresAt,$status,$version,$supersedes,$supersededBy)
        ON CONFLICT(ref) DO UPDATE SET lease_expires_at=excluded.lease_expires_at,status=excluded.status,
          current_version=excluded.current_version,supersedes=excluded.supersedes,superseded_by=excluded.superseded_by`)
      .run({
        ref: claim.ref,
        ticket: claim.ticket,
        owner: claim.humanOwner,
        run: claim.run,
        previous: JSON.stringify(claim.previousState),
        claimedAt: claim.claimedAt,
        expiresAt: claim.leaseExpiresAt,
        status: claim.status,
        version: claim.currentVersion ?? null,
        supersedes: claim.supersedes ?? null,
        supersededBy: claim.supersededBy ?? null,
      });
  }

  claim(ref: ClaimRef): Claim {
    const row = this.#database
      .query("SELECT * FROM claims WHERE ref=?")
      .get(ref) as ClaimRow | null;
    if (!row) throw new Error(`Claim not found: ${ref}`);
    return claimFromRow(row);
  }

  claimForRun(run: RunRef): Claim {
    const row = this.#database
      .query("SELECT * FROM claims WHERE run_ref=? ORDER BY claimed_at DESC LIMIT 1")
      .get(run) as ClaimRow | null;
    if (!row) throw new Error(`Claim not found for run: ${run}`);
    return claimFromRow(row);
  }

  activeRuns(): Run[] {
    const rows = this.#database
      .query("SELECT ref FROM runs WHERE status='active' ORDER BY created_at")
      .all() as Array<{ ref: RunRef }>;
    return rows.map(({ ref }) => this.run(ref));
  }

  steps(run: RunRef): unknown[] {
    return this.#database
      .query(
        "SELECT state,receipt_json,error_text,occurred_at FROM transaction_steps WHERE run_ref=? ORDER BY id",
      )
      .all(run);
  }

  recordRecovery(run: RunRef, outcome: string, evidence: unknown): void {
    this.#database
      .query(
        "INSERT INTO recovery_evidence(run_ref,outcome,evidence_json,occurred_at) VALUES(?,?,?,?)",
      )
      .run(run, outcome, JSON.stringify(evidence), new Date().toISOString());
  }

  recoveryEvidence(run: RunRef): unknown[] {
    return this.#database
      .query(
        "SELECT outcome,evidence_json,occurred_at FROM recovery_evidence WHERE run_ref=? ORDER BY id",
      )
      .all(run);
  }

  acquireSupervisor(owner: string, heartbeatAt: string, expiresAt: string): boolean {
    const result = this.#database
      .query(`INSERT INTO supervisor_lock(singleton,owner,heartbeat_at,expires_at) VALUES(1,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET owner=excluded.owner,heartbeat_at=excluded.heartbeat_at,
          expires_at=excluded.expires_at WHERE supervisor_lock.owner=excluded.owner OR supervisor_lock.expires_at<=excluded.heartbeat_at`)
      .run(owner, heartbeatAt, expiresAt);
    return result.changes === 1;
  }

  supervisorStatus(): unknown | undefined {
    return this.#database
      .query("SELECT owner,heartbeat_at,expires_at FROM supervisor_lock WHERE singleton=1")
      .get() as unknown | undefined;
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

function claimFromRow(row: ClaimRow): Claim {
  return {
    ref: row.ref,
    ticket: row.ticket,
    humanOwner: row.human_owner,
    run: row.run_ref,
    previousState: JSON.parse(row.previous_state_json),
    claimedAt: row.claimed_at,
    leaseExpiresAt: row.lease_expires_at,
    status: row.status,
    ...(row.current_version ? { currentVersion: row.current_version } : {}),
    ...(row.supersedes ? { supersedes: row.supersedes } : {}),
    ...(row.superseded_by ? { supersededBy: row.superseded_by } : {}),
  };
}

function ensureColumn(database: Database, table: string, column: string, type: string): void {
  const columns = database.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
