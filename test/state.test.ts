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
    workspace: { path: "/tmp/work", branch: "task/A" },
    capabilities: capabilities("process_launch"),
    status: "active",
    createdAt: now,
    updatedAt: now,
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
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
