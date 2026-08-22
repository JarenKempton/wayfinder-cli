#!/usr/bin/env bun
// PROTOTYPE (JWB-332) — throwaway evidence harness. Not the keeper.
//
// THE PROOF. Drives session-actor.ts as many genuinely distinct OS processes,
// all sharing ONE durable SQLite file, and asserts every JWB-332 acceptance
// criterion + scope item. Prints a human transcript and a machine-readable
// block, and exits non-zero if any criterion fails.
//
// Distinct pids are the whole point: if a fresh process can recover the lane's
// session identity, steer it, observe it, and re-attach — then the mapping is
// durable across a control-surface restart, not held in one live process.

import { unlinkSync } from "node:fs";

const ACTOR = `${import.meta.dir}/session-actor.ts`;
const DB = `${import.meta.dir}/.evidence.db`;

interface Envelope {
  pid: number;
  ok: boolean;
  [key: string]: unknown;
}

interface Step {
  label: string;
  args: string[];
  code: number;
  envelope: Envelope;
}

const transcript: Step[] = [];
const pids = new Set<number>();

async function run(label: string, args: string[]): Promise<Envelope> {
  const proc = Bun.spawn(["bun", ACTOR, ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const lines = out.split("\n").filter((l) => l.trim().length > 0);
  const last = lines.at(-1);
  if (!last) {
    throw new Error(`${label}: no stdout envelope (exit ${code}); stderr: ${err}`);
  }
  const envelope = JSON.parse(last) as Envelope;
  pids.add(envelope.pid);
  transcript.push({ label, args, code, envelope });
  return envelope;
}

interface Check {
  criterion: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];

function check(criterion: string, pass: boolean, detail: string): void {
  checks.push({ criterion, pass, detail });
}

function cleanup(): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      unlinkSync(`${DB}${suffix}`);
    } catch {
      // fine — nothing to remove
    }
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return (value ?? {}) as Record<string, unknown>;
}

async function main(): Promise<number> {
  cleanup();

  // --- Bind a durable T3-hosted session (genesis + identity) -----------------
  const p1 = await run("bind durable-t3 (t3, agent=codex)", [
    "bind",
    "--db",
    DB,
    "--lane",
    "durable-t3",
    "--host",
    "t3",
    "--agent",
    "codex",
    "--model",
    "o3",
  ]);
  const t3SessionId = String(p1.sessionId ?? "");

  // --- Fresh process recovers the mapping ------------------------------------
  const p2 = await run("status durable-t3 (fresh process)", [
    "status",
    "--db",
    DB,
    "--lane",
    "durable-t3",
  ]);
  const recovered = asRecord(p2.record);
  check(
    "1. durable lane<->T3 session identity recovered by a fresh process",
    p2.ok &&
      recovered.host === "t3" &&
      recovered.sessionId === t3SessionId &&
      t3SessionId.length > 0 &&
      p2.pid !== p1.pid,
    `bound ${t3SessionId} in pid ${p1.pid}; recovered "${String(recovered.sessionId)}" in pid ${p2.pid}`,
  );

  // --- Steer the same T3 session through the adapter boundary -----------------
  const p3 = await run("steer durable-t3 (t3 supports steering)", [
    "steer",
    "--db",
    DB,
    "--lane",
    "durable-t3",
    "--instruction",
    "revise: tighten scope to the adapter boundary",
  ]);

  // --- Disconnect/reconnect: a fresh process re-attaches ---------------------
  const p4 = await run("reattach durable-t3 (fresh process)", [
    "reattach",
    "--db",
    DB,
    "--lane",
    "durable-t3",
  ]);
  check(
    "scope. disconnect/reconnect the control surface without losing the lane",
    p4.ok && p4.sessionId === t3SessionId && Number(p4.reattachments ?? 0) >= 1,
    `re-attached ${String(p4.sessionId)} in pid ${p4.pid}; reattachments=${String(p4.reattachments)}`,
  );

  // --- Observe the same session (structured, not scraped) --------------------
  await run("observe durable-t3 (fresh process)", ["observe", "--db", DB, "--lane", "durable-t3"]);

  // --- Two different agents under the SAME native host -----------------------
  const p6 = await run("bind agent-a (native, agent=codex)", [
    "bind",
    "--db",
    DB,
    "--lane",
    "agent-a",
    "--host",
    "native",
    "--agent",
    "codex",
    "--linger",
    "3",
  ]);
  const p7 = await run("bind agent-b (native, agent=claude)", [
    "bind",
    "--db",
    DB,
    "--lane",
    "agent-b",
    "--host",
    "native",
    "--agent",
    "claude",
    "--linger",
    "3",
  ]);
  const agentA = String(asRecord(p6.agent).agent ?? "");
  const agentB = String(asRecord(p7.agent).agent ?? "");
  const agentOnT3 = String(asRecord(p1.agent).agent ?? "");
  check(
    "3. underlying agent adapter is independently selectable",
    p6.ok &&
      p7.ok &&
      p6.host === "native" &&
      p7.host === "native" &&
      agentA === "codex" &&
      agentB === "claude" &&
      agentA !== agentB &&
      // same agent identity ("codex") runs under BOTH native and t3 hosts
      agentOnT3 === "codex",
    `native ran agents [${agentA}, ${agentB}]; agent "codex" ran under both t3 and native`,
  );

  // --- The boundary gates capabilities: native cannot fake steering ----------
  const p8 = await run("steer agent-b (native cannot steer)", [
    "steer",
    "--db",
    DB,
    "--lane",
    "agent-b",
    "--instruction",
    "revise: should be rejected",
  ]);
  const p8Missing = Array.isArray(p8.missing) ? (p8.missing as string[]) : [];
  check(
    "2. T3-specific behaviour stays behind a capability-gated adapter boundary",
    p3.ok &&
      p3.accepted === true &&
      p8.ok === false &&
      p8.code === "unsupported_capability" &&
      p8Missing.includes("session_interrupt"),
    `t3 steering accepted via adapter; native steering rejected (missing ${p8Missing.join(", ")})`,
  );

  // --- Lifecycle observation from REAL exit codes (no scraping) --------------
  const p9 = await run("run-native native-ok (exit 0)", [
    "run-native",
    "--db",
    DB,
    "--lane",
    "native-ok",
    "--agent",
    "codex",
    "--outcome",
    "ok",
  ]);
  const p10 = await run("run-native native-fail (exit 1)", [
    "run-native",
    "--db",
    DB,
    "--lane",
    "native-fail",
    "--agent",
    "codex",
    "--outcome",
    "fail",
  ]);

  // --- Cross-process liveness of a real running process ----------------------
  const p11 = await run("bind native-live (native, real sleep 3)", [
    "bind",
    "--db",
    DB,
    "--lane",
    "native-live",
    "--host",
    "native",
    "--agent",
    "codex",
    "--linger",
    "3",
  ]);
  const p12 = await run("observe native-live (fresh process)", [
    "observe",
    "--db",
    DB,
    "--lane",
    "native-live",
  ]);
  check(
    "scope. observe running / settled / failed without terminal scraping",
    p12.ok &&
      p12.lifecycle === "running" &&
      p9.ok &&
      p9.lifecycle === "settled" &&
      p10.ok &&
      p10.lifecycle === "failed" &&
      p11.ok,
    `running (pid ${p12.pid} observed lane bound in pid ${p11.pid}), settled (exit 0), failed (exit 1)`,
  );

  // --- Optionality: lack of a usable T3 does not block native ----------------
  const p13 = await run("select preferred=t3 (real surface), need launch caps", [
    "select",
    "--host",
    "t3",
    "--need",
    "session_create,session_status",
  ]);
  const sel13 = asRecord(p13.selection);
  check(
    "4. lack of T3 does not prevent native/other session-host execution",
    p13.ok &&
      sel13.ok === true &&
      sel13.chosen === "native" &&
      sel13.fellBack === true &&
      // ...and native execution actually proceeded end to end above
      p9.lifecycle === "settled",
    `real T3 surface lacked lifecycle caps -> fell back to native; native lane ran to settled`,
  );

  // --- Honesty: required-but-unverifiable T3 fails closed --------------------
  const p14 = await run("select preferred=t3 required, need session_interrupt", [
    "select",
    "--host",
    "t3",
    "--required",
    "--need",
    "session_interrupt",
  ]);
  const sel14 = asRecord(p14.selection);
  const catalog14 = Array.isArray(p14.catalog) ? (p14.catalog as Record<string, unknown>[]) : [];
  const t3Note = String(catalog14.find((c) => c.kind === "t3")?.note ?? "");
  check(
    "5. unsupported/unstable T3 lifecycle recorded, not advertised",
    p14.ok === false &&
      sel14.ok === false &&
      sel14.code === "unverified_capability" &&
      t3Note.length > 0,
    `required T3 steering refused (${String(sel14.code)}); recorded note: "${t3Note.slice(0, 60)}..."`,
  );

  // --- The boundary works once T3 exposes a stable surface -------------------
  const p15 = await run("select preferred=t3 (simulated stable), need session_interrupt", [
    "select",
    "--host",
    "t3",
    "--need",
    "session_interrupt",
    "--t3-mode",
    "simulated",
  ]);
  const sel15 = asRecord(p15.selection);
  check(
    "bonus. a stable T3 surface is selected as host once it verifies capabilities",
    p15.ok && sel15.ok === true && sel15.chosen === "t3" && sel15.fellBack === false,
    `simulated stable T3 verified session_interrupt -> chosen as host (no fallback)`,
  );

  // --- All work came from genuinely distinct OS processes --------------------
  check(
    "foundation. every guarded action ran in a genuinely distinct OS process",
    pids.size === transcript.length,
    `${pids.size} distinct pids across ${transcript.length} actor invocations`,
  );

  // ---------------------------------------------------------------- report ---
  console.log("\n╭─ JWB-332 · T3 as an optional persistent Wayfinder session host ─╮\n");
  for (const step of transcript) {
    const status = step.envelope.ok ? "ok " : "REJ";
    const facts: string[] = [];
    if (step.envelope.host) facts.push(`host=${String(step.envelope.host)}`);
    if (step.envelope.sessionId) facts.push(`sid=${String(step.envelope.sessionId)}`);
    if (step.envelope.lifecycle) facts.push(`life=${String(step.envelope.lifecycle)}`);
    if (step.envelope.selection) {
      const s = asRecord(step.envelope.selection);
      facts.push(`select=${s.ok ? String(s.chosen) : `refused:${String(s.code)}`}`);
    }
    console.log(`  [${status}] pid ${String(step.envelope.pid).padEnd(7)} ${step.label}`);
    if (facts.length > 0) console.log(`         ${facts.join("  ")}`);
  }

  console.log("\n── Acceptance ──");
  let allPass = true;
  for (const c of checks) {
    allPass = allPass && c.pass;
    console.log(`  ${c.pass ? "✅" : "❌"} ${c.criterion}`);
    console.log(`       ${c.detail}`);
  }

  const machine = {
    allPass,
    distinctProcesses: pids.size,
    invocations: transcript.length,
    pids: [...pids],
    checks: checks.map((c) => ({ criterion: c.criterion, pass: c.pass })),
  };
  console.log("\n── Machine-readable ──");
  console.log(JSON.stringify(machine, null, 2));

  cleanup();
  return allPass ? 0 : 1;
}

process.exit(await main());
