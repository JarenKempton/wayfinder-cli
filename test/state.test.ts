import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Claim, capabilities, type Run } from "../src/domain.ts";
import { StateStore } from "../src/state.ts";

test("SQLite store round-trips runs", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
  const store = new StateStore(join(directory, "wayfinder.db"));
  const now = new Date().toISOString();
  const run: Run = {
    ref: "wayfinder-run:test",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "codex" as Run["harness"],
    model: "gpt",
    effort: "high",
    context: "repository",
    workspace: { path: "/tmp/work", branch: "task/A" },
    capabilities: capabilities("process_launch"),
    status: "active",
    createdAt: now,
    updatedAt: now,
    execution: { sessionId: "session", tier: "managed" },
    observation: { state: "running", observedAt: now },
  };
  try {
    store.saveRun(run);
    expect(store.run(run.ref)).toEqual(run);
    const claim: Claim = {
      ref: "wayfinder-claim:test",
      ticket: run.ticket,
      humanOwner: "human" as Claim["humanOwner"],
      run: run.ref,
      previousState: { version: "1", payload: { status: "To Do" } },
      claimedAt: now,
      leaseExpiresAt: now,
      status: "active",
      currentVersion: "2",
    };
    store.saveClaim(claim);
    expect(store.claim(claim.ref)).toEqual(claim);
    expect(store.claimForRun(run.ref)).toEqual(claim);
    expect(store.activeRuns()).toEqual([run]);
    const lifecycleUpdate: Run = {
      ...run,
      status: "attention_required",
      updatedAt: new Date(Date.parse(now) + 1_000).toISOString(),
      observation: { state: "unknown", observedAt: now, detail: "reconcile" },
    };
    store.commitRun(lifecycleUpdate, "attention_required", { reason: "test" });
    expect(store.run(run.ref)).toEqual(lifecycleUpdate);
    expect(store.run(run.ref)).toMatchObject({ effort: "high", context: "repository" });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite store additively migrates legacy run routing columns", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
  const path = join(directory, "wayfinder.db");
  const legacy = new Database(path, { create: true });
  legacy.exec(`CREATE TABLE runs (
    ref TEXT PRIMARY KEY,
    ticket TEXT NOT NULL,
    harness TEXT NOT NULL,
    model TEXT,
    workspace_json TEXT NOT NULL,
    capabilities_json TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  legacy.close();

  const store = new StateStore(path);
  const now = new Date().toISOString();
  const run: Run = {
    ref: "wayfinder-run:migrated",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "codex" as Run["harness"],
    model: "gpt",
    effort: "high",
    context: "repository",
    workspace: { path: "/tmp/work" },
    capabilities: capabilities("process_launch"),
    status: "active",
    createdAt: now,
    updatedAt: now,
    execution: { pid: 123, processIdentity: "legacy-migrated", tier: "launch" },
    observation: { state: "running", observedAt: now },
  };
  try {
    store.saveRun(run);
    expect(store.run(run.ref)).toEqual(run);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite store atomically records recovery-required run, step, and evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
  const store = new StateStore(join(directory, "wayfinder.db"));
  const now = new Date().toISOString();
  const run: Run = {
    ref: "wayfinder-run:recovery",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "codex" as Run["harness"],
    workspace: { path: "/tmp/work" },
    capabilities: capabilities("process_launch"),
    status: "planning",
    createdAt: now,
    updatedAt: now,
  };
  try {
    store.saveRun(run);
    const recoveryRun = { ...run, status: "recovery_required" as const };
    const receipt = { state: "recovery_required", recoveryCommand: "wayfinder recover" };
    const evidence = { tracker: "verification_required", session: "not_started" };

    store.saveRecoveryRequired(recoveryRun, receipt, new Error("ambiguous"), evidence);

    expect(store.run(run.ref).status).toBe("recovery_required");
    expect(store.steps(run.ref)).toHaveLength(1);
    expect(store.steps(run.ref)[0]).toMatchObject({
      state: "recovery_required",
      error_text: "ambiguous",
    });
    expect(store.recoveryEvidence(run.ref)).toHaveLength(1);
    expect(store.recoveryEvidence(run.ref)[0]).toMatchObject({
      outcome: "verification_required",
      evidence_json: JSON.stringify(evidence),
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("SQLite recovery-required transaction rolls back every row on a mid-transaction failure", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
  const path = join(directory, "wayfinder.db");
  const store = new StateStore(path);
  const now = new Date().toISOString();
  const run: Run = {
    ref: "wayfinder-run:rollback",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "codex" as Run["harness"],
    workspace: { path: "/tmp/work" },
    capabilities: capabilities("process_launch"),
    status: "planning",
    createdAt: now,
    updatedAt: now,
  };
  try {
    store.saveRun(run);
    const injector = new Database(path);
    injector.exec(`CREATE TRIGGER fail_recovery_evidence
      BEFORE INSERT ON recovery_evidence
      BEGIN
        SELECT RAISE(ABORT, 'injected recovery evidence failure');
      END`);
    injector.close();

    expect(() =>
      store.saveRecoveryRequired(
        { ...run, status: "recovery_required" },
        { state: "recovery_required" },
        new Error("ambiguous"),
        { tracker: "verification_required" },
      ),
    ).toThrow("injected recovery evidence failure");

    expect(store.run(run.ref).status).toBe("planning");
    expect(store.steps(run.ref)).toEqual([]);
    expect(store.recoveryEvidence(run.ref)).toEqual([]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
