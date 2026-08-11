import { Database } from "bun:sqlite";

export type ObservedStatus = "active" | "stale" | "attention_required";

export interface Snapshot {
  run: string;
  claim: string;
  status: ObservedStatus;
  harnessPid: number;
  supervisorPid: number | null;
  supervisorEpoch: number;
  leaseExpiresAt: number;
  lastEvidence: string;
}

const schema = `
CREATE TABLE IF NOT EXISTS prototype_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  run_ref TEXT NOT NULL,
  claim_ref TEXT NOT NULL,
  harness_pid INTEGER NOT NULL,
  supervisor_pid INTEGER,
  supervisor_epoch INTEGER NOT NULL DEFAULT 0,
  lease_expires_at INTEGER NOT NULL,
  attention_required INTEGER NOT NULL DEFAULT 0,
  last_evidence TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prototype_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  evidence TEXT NOT NULL,
  occurred_at INTEGER NOT NULL
);`;

/** PROTOTYPE: durable model used only to answer JWB-281's crash-recovery question. */
export class PrototypeLedger {
  readonly #db: Database;

  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec("PRAGMA journal_mode=WAL");
    this.#db.exec("PRAGMA synchronous=FULL");
    this.#db.exec(schema);
  }

  initialize(harnessPid: number, now: number, leaseMs: number): void {
    this.#db
      .query(`INSERT INTO prototype_state
        (singleton,run_ref,claim_ref,harness_pid,lease_expires_at,last_evidence)
        VALUES (1,'wayfinder-run:jwb-281','wayfinder-claim:jwb-281',?,?,?)`)
      .run(harnessPid, now + leaseMs, "CLI committed run and claim before exiting");
    this.event("cli_committed", "run, claim, harness PID, and lease are durable", now);
  }

  bootSupervisor(pid: number, now: number): void {
    this.#db.transaction(() => {
      this.#db
        .query(`UPDATE prototype_state SET supervisor_pid=?, supervisor_epoch=supervisor_epoch+1,
          last_evidence='supervisor booted from SQLite state' WHERE singleton=1`)
        .run(pid);
      this.event("supervisor_booted", `pid=${pid}`, now);
    })();
  }

  supervise(now: number, leaseMs: number, harnessAlive: boolean): void {
    this.#db.transaction(() => {
      if (harnessAlive) {
        this.#db
          .query(`UPDATE prototype_state SET lease_expires_at=?, attention_required=0,
            last_evidence='matching durable claim renewed by supervisor' WHERE singleton=1`)
          .run(now + leaseMs);
        this.event("lease_renewed", "matching claim retained; expiry advanced", now);
      } else {
        this.#db
          .query(`UPDATE prototype_state SET attention_required=1,
            last_evidence='harness PID is absent; human attention required' WHERE singleton=1`)
          .run();
        this.event("harness_missing", "attention_required persisted", now);
      }
    })();
  }

  snapshot(now = Date.now()): Snapshot {
    const row = this.#db.query("SELECT * FROM prototype_state WHERE singleton=1").get() as {
      run_ref: string;
      claim_ref: string;
      harness_pid: number;
      supervisor_pid: number | null;
      supervisor_epoch: number;
      lease_expires_at: number;
      attention_required: number;
      last_evidence: string;
    };
    const status: ObservedStatus = row.attention_required
      ? "attention_required"
      : now >= row.lease_expires_at
        ? "stale"
        : "active";
    return {
      run: row.run_ref,
      claim: row.claim_ref,
      status,
      harnessPid: row.harness_pid,
      supervisorPid: row.supervisor_pid,
      supervisorEpoch: row.supervisor_epoch,
      leaseExpiresAt: row.lease_expires_at,
      lastEvidence: row.last_evidence,
    };
  }

  events(): Array<{ kind: string; evidence: string; occurredAt: number }> {
    return this.#db
      .query("SELECT kind,evidence,occurred_at AS occurredAt FROM prototype_events ORDER BY id")
      .all() as Array<{ kind: string; evidence: string; occurredAt: number }>;
  }

  close(): void {
    this.#db.close();
  }

  private event(kind: string, evidence: string, now: number): void {
    this.#db
      .query("INSERT INTO prototype_events(kind,evidence,occurred_at) VALUES (?,?,?)")
      .run(kind, evidence, now);
  }
}

export function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
