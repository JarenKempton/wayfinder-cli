// PROTOTYPE (JWB-325) — throwaway evidence harness.
//
// This is the proof. It spawns lane-actor.ts as genuinely separate OS processes
// (distinct PIDs) that share ONE SQLite file, then checks the five acceptance
// criteria against their captured JSON output. Because each step is a real
// process that exits before the next begins, "orchestrator restart" and
// "supervisor restart" are not simulated — they are new PIDs re-attaching to the
// durable store with zero in-memory carryover.
//
// Run:  bun run proto:lane:demo
// It prints a human-readable transcript and a machine-readable JSON block, and
// exits non-zero if any acceptance criterion fails.

import { unlinkSync } from "node:fs";

const ACTOR = `${import.meta.dir}/lane-actor.ts`;
const DB = `${import.meta.dir}/.evidence.db`;
const LANE = "wf-lane:JWB-325-demo";
const OTHER_LANE = "wf-lane:JWB-999-other";
const TICKET = "JWB-325";

interface Envelope {
  pid: number;
  ok: boolean;
  command?: string;
  record?: {
    lane: string;
    ticket: string;
    state: string;
    version: number;
    services: unknown[];
    artifacts: unknown[];
  };
  events?: number;
  state?: string;
  version?: number;
  outcome?: string;
  code?: string;
  reason?: string;
}

const pids = new Set<number>();
const transcript: string[] = [];

async function run(label: string, args: string[]): Promise<Envelope> {
  const proc = Bun.spawn(["bun", ACTOR, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const line = stdout.trim().split("\n").filter(Boolean).at(-1);
  if (!line) {
    throw new Error(`no output from step "${label}" (exit ${code}): ${stderr}`);
  }
  const envelope = JSON.parse(line) as Envelope;
  pids.add(envelope.pid);
  transcript.push(
    `  [pid ${envelope.pid}] ${label}\n      -> ${JSON.stringify({
      ok: envelope.ok,
      state: envelope.record?.state ?? envelope.state,
      version: envelope.record?.version ?? envelope.version,
      outcome: envelope.outcome,
      code: envelope.code,
    })}`,
  );
  return envelope;
}

const checks: Array<{ criterion: string; pass: boolean; detail: string }> = [];
function check(criterion: string, pass: boolean, detail: string): void {
  checks.push({ criterion, pass, detail });
}

function cleanup(): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      unlinkSync(`${DB}${suffix}`);
    } catch {
      // best-effort; the files are gitignored
    }
  }
}

async function main(): Promise<number> {
  cleanup();
  transcript.push("── Lane coordination evidence (JWB-325) ──\n");
  transcript.push("Structured events driving one lane across separate processes:\n");

  // ---- Criterion 1: structured state transitions through a Wayfinder channel ----
  const orch = "orchestrator:alice";
  const worker = `worker:w-quinn:${LANE}`;
  await run("orchestrator creates lane", [
    "create",
    "--db",
    DB,
    "--lane",
    LANE,
    "--ticket",
    TICKET,
    "--as",
    orch,
  ]);
  await run("orchestrator: preparing", [
    "drive",
    "--db",
    DB,
    "--lane",
    LANE,
    "--event",
    "preparing",
    "--as",
    orch,
  ]);
  const running = await run("worker: running", [
    "report",
    "--db",
    DB,
    "--lane",
    LANE,
    "--event",
    "running",
    "--as",
    worker,
  ]);
  await run("worker: announce service web:3000", [
    "service",
    "--db",
    DB,
    "--lane",
    LANE,
    "--name",
    "web",
    "--port",
    "3000",
    "--as",
    worker,
  ]);
  await run("worker: add artifact pr/12", [
    "artifact",
    "--db",
    DB,
    "--lane",
    LANE,
    "--ref",
    "pr/12",
    "--kind",
    "pull_request",
    "--as",
    worker,
  ]);
  const rfv = await run("worker: ready_for_validation", [
    "report",
    "--db",
    DB,
    "--lane",
    LANE,
    "--event",
    "ready_for_validation",
    "--as",
    worker,
  ]);
  check(
    "1. Lane reports structured state transitions through a Wayfinder-owned channel",
    running.ok &&
      running.record?.state === "running" &&
      rfv.ok &&
      rfv.record?.state === "ready_for_validation" &&
      (rfv.record?.version ?? 0) >= 6,
    `typed events advanced the lane to ${rfv.record?.state} at version ${rfv.record?.version}`,
  );

  // The channel enforces the state machine: an illegal transition is rejected
  // even from an authorized worker, so state is never free-form or scraped.
  const illegal = await run("worker: illegal blocked<-ready_for_validation (rejected)", [
    "report",
    "--db",
    DB,
    "--lane",
    LANE,
    "--event",
    "blocked",
    "--as",
    worker,
  ]);
  check(
    "1b. Illegal transitions are rejected by the protocol, not silently applied",
    !illegal.ok && illegal.code === "illegal_transition",
    `blocked from ready_for_validation rejected as ${illegal.code}`,
  );

  // ---- Criterion 2: orchestrator restart preserves identity + state ----
  const creatorPids = new Set(pids);
  const restarted = await run("FRESH orchestrator process: status (restart)", [
    "status",
    "--db",
    DB,
    "--lane",
    LANE,
  ]);
  check(
    "2. Restarting/replacing the orchestrator preserves lane identity and state",
    restarted.ok &&
      restarted.record?.lane === LANE &&
      restarted.record?.ticket === TICKET &&
      !creatorPids.has(restarted.pid),
    `a new PID (${restarted.pid}) re-derived lane ${restarted.record?.lane} @ ${restarted.record?.state} ` +
      "purely from the durable log, with no in-memory handoff",
  );

  // ---- Criterion 3: supervisor restart reconciles the same active lane ----
  const sup1 = await run("supervisor #1: reconcile", [
    "reconcile",
    "--db",
    DB,
    "--lane",
    LANE,
    "--as",
    "supervisor:sup-a",
  ]);
  const sup2 = await run("supervisor #2 (restart): reconcile", [
    "reconcile",
    "--db",
    DB,
    "--lane",
    LANE,
    "--as",
    "supervisor:sup-b",
  ]);
  check(
    "3. Restarting the supervisor reconciles the same active lane",
    sup1.ok &&
      sup2.ok &&
      sup1.state === sup2.state &&
      sup1.version === sup2.version &&
      sup1.pid !== sup2.pid,
    `two distinct supervisor PIDs (${sup1.pid}, ${sup2.pid}) reconciled the same lane at ` +
      `state ${sup2.state} / version ${sup2.version}`,
  );

  // ---- Criterion 4: worker credential cannot mutate another lane or global policy ----
  const crossLane = await run("worker attempts to mutate ANOTHER lane (rejected)", [
    "report",
    "--db",
    DB,
    "--lane",
    OTHER_LANE,
    "--event",
    "running",
    "--as",
    worker,
  ]);
  const policyAttempt = await run("worker attempts to set GLOBAL policy (rejected)", [
    "policy",
    "--db",
    DB,
    "--key",
    "merge_gate",
    "--value",
    "disabled",
    "--as",
    worker,
  ]);
  check(
    "4. Worker credentials cannot mutate another lane or global policy",
    !crossLane.ok &&
      crossLane.code === "unauthorized_scope" &&
      !policyAttempt.ok &&
      policyAttempt.code === "unauthorized_capability",
    `cross-lane rejected (${crossLane.code}); policy rejected (${policyAttempt.code})`,
  );

  // ---- Criterion 5: enough evidence to define the production protocol ----
  const finalStatus = await run("final: full lane status", ["status", "--db", DB, "--lane", LANE]);
  check(
    "5. Prototype records enough evidence to define the production lane protocol",
    finalStatus.ok &&
      (finalStatus.events ?? 0) >= 6 &&
      (finalStatus.record?.services.length ?? 0) === 1 &&
      (finalStatus.record?.artifacts.length ?? 0) === 1,
    `durable log holds ${finalStatus.events} typed events; projection carries ` +
      `${finalStatus.record?.services.length} service(s) and ${finalStatus.record?.artifacts.length} artifact(s)`,
  );

  // ---- Report ----
  const out: string[] = [];
  out.push(transcript.join("\n"));
  out.push("\n── Acceptance ──");
  let allPass = true;
  for (const c of checks) {
    allPass = allPass && c.pass;
    out.push(`  ${c.pass ? "PASS" : "FAIL"}  ${c.criterion}\n        ${c.detail}`);
  }
  out.push(
    `\n  ${pids.size} distinct OS processes (PIDs: ${[...pids].join(", ")}) shared one durable store.`,
  );
  out.push(`\n${allPass ? "ALL ACCEPTANCE CRITERIA PASS" : "SOME CRITERIA FAILED"}`);
  out.push("\n── Machine-readable ──");
  out.push(
    JSON.stringify({ allPass, distinctProcesses: pids.size, pids: [...pids], checks }, null, 2),
  );

  process.stdout.write(`${out.join("\n")}\n`);
  cleanup();
  return allPass ? 0 : 1;
}

process.exit(await main());
