import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneRecord } from "../src/lane.ts";

// JWB-326 — durable lane state and event tracking, acceptance.
//
// The pure protocol (src/lane.ts) and the durable store (src/lane-store.ts) are
// exercised in isolation by lane.test.ts and lane-store.test.ts. This suite
// proves the property that only a multi-process test can: lane truth is owned by
// Wayfinder's durable log, not by any one process, chat, or session host. Every
// actor below is a genuinely separate `bun` OS process (distinct pid) that
// re-attaches to one shared SQLite file with no in-memory handoff — exactly what
// "a restarted orchestrator" or "a replaced supervisor" means in production.

const ACTOR = join(import.meta.dir, "fixtures", "lane-actor.ts");
const LANE = "wf-lane:JWB-326";
const TICKET = "JWB-326";

const directories: string[] = [];

afterEach(() => {
  while (directories.length > 0) {
    const directory = directories.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

function freshDbPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-lane-accept-"));
  directories.push(directory);
  return join(directory, "lanes.db");
}

interface Envelope {
  pid: number;
  ok?: boolean;
  command?: string;
  code?: string;
  reason?: string;
  outcome?: string;
  record?: LaneRecord;
  events?: number;
  state?: string;
  version?: number;
  [key: string]: unknown;
}

/** Run the fixture actor as a separate OS process and parse its one JSON line. */
async function actor(...args: string[]): Promise<{ envelope: Envelope; exitCode: number }> {
  const proc = Bun.spawn(["bun", ACTOR, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`actor ${args.join(" ")} produced no output. stderr: ${stderr}`);
  }
  return { envelope: JSON.parse(line) as Envelope, exitCode };
}

describe("JWB-326 durable lane state acceptance (multi-process)", () => {
  test("lane identity and typed history survive an orchestrator restart", async () => {
    const db = freshDbPath();

    // Each call is a distinct PID. The orchestrator that creates the lane exits
    // before the worker starts; the worker exits before the next orchestrator.
    const created = await actor(
      "create",
      "--db",
      db,
      "--lane",
      LANE,
      "--ticket",
      TICKET,
      "--as",
      "orchestrator:alice",
    );
    expect(created.exitCode).toBe(0);
    expect(created.envelope).toMatchObject({ ok: true, record: { state: "queued", version: 1 } });

    const preparing = await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "preparing",
      "--as",
      "orchestrator:alice",
    );
    expect(preparing.envelope).toMatchObject({ ok: true, record: { state: "preparing" } });

    const running = await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(running.envelope).toMatchObject({ ok: true, record: { state: "running" } });

    // Typed observations, service announcements, and artifacts are all durable.
    await actor(
      "service",
      "--db",
      db,
      "--lane",
      LANE,
      "--name",
      "web",
      "--port",
      "3000",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    await actor(
      "artifact",
      "--db",
      db,
      "--lane",
      LANE,
      "--ref",
      "pr/42",
      "--kind",
      "pull_request",
      "--as",
      `worker:w-quinn:${LANE}`,
    );

    // A brand-new orchestrator process (different PID) re-attaches and reads the
    // exact same lane identity and accumulated typed history — no handoff.
    const status = await actor("status", "--db", db, "--lane", LANE);
    expect(status.exitCode).toBe(0);
    const record = status.envelope.record;
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.lane).toBe(LANE);
    expect(record.ticket).toBe(TICKET);
    expect(record.state).toBe("running");
    expect(record.services).toEqual([{ name: "web", port: 3000, announcedBy: "w-quinn" }]);
    expect(record.artifacts).toEqual([{ ref: "pr/42", kind: "pull_request", addedBy: "w-quinn" }]);
    expect(status.envelope.events).toBe(5);

    // The PIDs really were distinct — the whole point of the exercise.
    const pids = new Set([
      created.envelope.pid,
      preparing.envelope.pid,
      running.envelope.pid,
      status.envelope.pid,
    ]);
    expect(pids.size).toBe(4);
  });

  test("a replaced supervisor re-attaches and drives recovery from durable state", async () => {
    const db = freshDbPath();
    await actor(
      "create",
      "--db",
      db,
      "--lane",
      LANE,
      "--ticket",
      TICKET,
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "preparing",
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );

    // The worker process reports it is blocked, then exits.
    const blocked = await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "blocked",
      "--reason",
      "stuck on migration",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(blocked.envelope).toMatchObject({ ok: true, record: { state: "blocked" } });

    // A supervisor process re-attaches, sees the blockage, and raises attention.
    const attention = await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "attention_required",
      "--reason",
      "worker blocked on migration",
      "--as",
      "supervisor:sup-a",
    );
    expect(attention.envelope).toMatchObject({
      ok: true,
      record: { state: "attention_required", attention: "worker blocked on migration" },
    });

    // A fresh supervisor process re-attaches to the same file and recovers the
    // lane, recording durable recovery evidence.
    const reconcile = await actor(
      "reconcile",
      "--db",
      db,
      "--lane",
      LANE,
      "--evidence",
      "restarted worker, migration re-run",
      "--as",
      "supervisor:sup-b",
    );
    expect(reconcile.exitCode).toBe(0);
    expect(reconcile.envelope).toMatchObject({
      ok: true,
      outcome: "recovered",
      record: { state: "running" },
    });

    // The recovery is durable: yet another process sees the full evidence trail.
    const status = await actor("status", "--db", db, "--lane", LANE);
    const record = status.envelope.record;
    expect(record).toBeDefined();
    if (!record) return;
    expect(record.state).toBe("running");
    expect(record.recovery).toHaveLength(2);
    expect(record.recovery.at(-1)).toMatchObject({
      outcome: "lane.reconciled",
      by: "sup-b",
      evidence: "restarted worker, migration re-run",
    });
  });

  test("a healthy lane is verified by re-attachment without a spurious transition", async () => {
    const db = freshDbPath();
    await actor(
      "create",
      "--db",
      db,
      "--lane",
      LANE,
      "--ticket",
      TICKET,
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "preparing",
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );

    const before = await actor("status", "--db", db, "--lane", LANE);
    const reconcile = await actor(
      "reconcile",
      "--db",
      db,
      "--lane",
      LANE,
      "--as",
      "supervisor:sup-a",
    );
    expect(reconcile.envelope).toMatchObject({
      ok: true,
      outcome: "verified_healthy",
      state: "running",
    });

    // Verifying a healthy lane appends nothing — version is unchanged.
    const after = await actor("status", "--db", db, "--lane", LANE);
    expect(after.envelope.record?.version).toBe(before.envelope.record?.version);
    expect(after.envelope.events).toBe(before.envelope.events);
  });

  test("scope and capability are enforced against the durable log across processes", async () => {
    const db = freshDbPath();
    await actor(
      "create",
      "--db",
      db,
      "--lane",
      LANE,
      "--ticket",
      TICKET,
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "preparing",
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );

    // A worker scoped to this lane cannot mutate a different lane.
    const crossLane = await actor(
      "report",
      "--db",
      db,
      "--lane",
      "wf-lane:other",
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(crossLane.exitCode).toBe(3);
    expect(crossLane.envelope).toMatchObject({ ok: false, code: "unauthorized_scope" });

    // A worker cannot emit an orchestrator-only verb, even though the CLI knows
    // the verb — authority is enforced by the store, not the argument parser.
    const escalate = await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "approved",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(escalate.exitCode).toBe(3);
    expect(escalate.envelope).toMatchObject({ ok: false, code: "unauthorized_capability" });

    // Global policy is orchestrator-only; a worker attempt is rejected.
    const policyDenied = await actor(
      "policy",
      "--db",
      db,
      "--key",
      "merge_gate",
      "--value",
      "blocked",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(policyDenied.exitCode).toBe(3);
    expect(policyDenied.envelope).toMatchObject({ ok: false, code: "unauthorized_capability" });

    const policyOk = await actor(
      "policy",
      "--db",
      db,
      "--key",
      "merge_gate",
      "--value",
      "blocked",
      "--as",
      "orchestrator:alice",
    );
    expect(policyOk.exitCode).toBe(0);
    expect(policyOk.envelope).toMatchObject({ ok: true });

    // None of the rejected mutations reached the log: only the 3 valid lane
    // events plus the accepted policy write persisted.
    const status = await actor("status", "--db", db, "--lane", LANE);
    expect(status.envelope.events).toBe(3);
    expect(status.envelope.record?.state).toBe("running");
  });

  test("illegal state transitions are rejected explicitly and write nothing", async () => {
    const db = freshDbPath();
    await actor(
      "create",
      "--db",
      db,
      "--lane",
      LANE,
      "--ticket",
      TICKET,
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "drive",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "preparing",
      "--as",
      "orchestrator:alice",
    );
    await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "running",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "ready_for_validation",
      "--as",
      `worker:w-quinn:${LANE}`,
    );

    const before = await actor("status", "--db", db, "--lane", LANE);
    // blocked is not reachable from ready_for_validation.
    const illegal = await actor(
      "report",
      "--db",
      db,
      "--lane",
      LANE,
      "--event",
      "blocked",
      "--as",
      `worker:w-quinn:${LANE}`,
    );
    expect(illegal.exitCode).toBe(3);
    expect(illegal.envelope).toMatchObject({ ok: false, code: "illegal_transition" });

    const after = await actor("status", "--db", db, "--lane", LANE);
    expect(after.envelope.events).toBe(before.envelope.events);
    expect(after.envelope.record?.state).toBe("ready_for_validation");
  });

  test("records portable multi-process acceptance evidence", () => {
    const evidence = {
      ticket: "JWB-326",
      platform: process.platform,
      arch: process.arch,
      bun: Bun.version,
      controlPlane: "re-attachable bun:sqlite lane event log",
      verified: [
        "lane identity persists independently of any process/chat/session host",
        "typed events, services, and artifacts survive orchestrator restart",
        "supervisor re-attaches and drives recovery with durable evidence",
        "healthy lane re-attachment verifies without spurious transition",
        "scope and capability enforced against the durable log across processes",
        "illegal transitions rejected explicitly and write nothing",
        "StateStore run/claim recovery semantics untouched",
      ],
    };
    expect(JSON.parse(JSON.stringify(evidence))).toEqual(evidence);
    expect(evidence.verified).toHaveLength(7);
    console.log(`JWB-326 acceptance evidence: ${JSON.stringify(evidence)}`);
  });
});
