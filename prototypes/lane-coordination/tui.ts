// PROTOTYPE (JWB-325) — throwaway interactive shell.
//
// A hand-driven terminal for feeling the lane state machine and its guards: press
// keys to emit structured events, watch the projection and durable event log
// update, force an "orchestrator restart" that re-derives state purely from the
// store, and watch scoped-authority guards reject cross-lane and policy writes.
//
// Restart survival is real here too: quit with `q`, run `bun run proto:lane`
// again, and the lane is still exactly where you left it — the state lives in the
// SQLite file (.tui-lane.db), not in this process.
//
// Run:  bun run proto:lane

import type { LaneAuthority, LaneEvent, LaneEventKind, LaneRecord } from "./lane-protocol.ts";
import { LaneStore } from "./lane-store.ts";

const DB = `${import.meta.dir}/.tui-lane.db`;
const LANE = "wf-lane:tui-demo";
const TICKET = "JWB-325";
const OTHER_LANE = "wf-lane:someone-elses";

const ORCH: LaneAuthority = { principal: "orchestrator-ann", role: "orchestrator" };
const WORKER: LaneAuthority = { principal: "worker-wei", role: "worker", laneScope: LANE };
const SUPER: LaneAuthority = { principal: "supervisor-sam", role: "supervisor" };

const store = new LaneStore(DB);
let record: LaneRecord | undefined = store.project(LANE);
let lastMessage = record
  ? "Re-attached to the durable store — lane survived a restart."
  : "Fresh store. Press [c] to create the lane.";
let servicePort = 3000;
let artifactSeq = 1;

interface Binding {
  key: string;
  label: string;
  run(): void;
}

function event(kind: LaneEventKind, who: LaneAuthority, extra: Partial<LaneEvent> = {}): LaneEvent {
  return {
    kind,
    lane: LANE,
    at: new Date().toISOString(),
    actor: who.principal,
    role: who.role,
    ...extra,
  };
}

function apply(kind: LaneEventKind, who: LaneAuthority, extra: Partial<LaneEvent> = {}): void {
  const result = store.append(event(kind, who, extra), who);
  if (result.ok && result.record) {
    record = result.record;
    lastMessage = `${who.role} emitted ${kind} -> ${result.record.state}`;
  } else {
    lastMessage = `REJECTED ${kind}: [${result.code}] ${result.reason}`;
  }
}

const bindings: Binding[] = [
  {
    key: "c",
    label: "orchestrator: create lane",
    run: () => apply("lane.created", ORCH, { ticket: TICKET }),
  },
  { key: "p", label: "orchestrator: preparing", run: () => apply("lane.preparing", ORCH) },
  { key: "r", label: "worker: running", run: () => apply("lane.running", WORKER) },
  { key: "b", label: "worker: blocked", run: () => apply("lane.blocked", WORKER) },
  {
    key: "s",
    label: "worker: announce service",
    run: () =>
      apply("lane.service_announced", WORKER, { service: { name: "web", port: servicePort++ } }),
  },
  {
    key: "f",
    label: "worker: add artifact",
    run: () =>
      apply("lane.artifact_added", WORKER, {
        artifact: { ref: `pr/${artifactSeq++}`, kind: "pull_request" },
      }),
  },
  {
    key: "v",
    label: "worker: ready_for_validation",
    run: () => apply("lane.ready_for_validation", WORKER),
  },
  { key: "d", label: "orchestrator: validating", run: () => apply("lane.validating", ORCH) },
  {
    key: "R",
    label: "orchestrator: revision_requested",
    run: () => apply("lane.revision_requested", ORCH),
  },
  {
    key: "w",
    label: "orchestrator: ready_for_review",
    run: () => apply("lane.ready_for_review", ORCH),
  },
  { key: "e", label: "orchestrator: reviewing", run: () => apply("lane.reviewing", ORCH) },
  { key: "a", label: "orchestrator: approved", run: () => apply("lane.approved", ORCH) },
  { key: "h", label: "orchestrator: human_ready", run: () => apply("lane.human_ready", ORCH) },
  { key: "m", label: "orchestrator: completed", run: () => apply("lane.completed", ORCH) },
  { key: "z", label: "worker: stopped", run: () => apply("lane.stopped", WORKER) },
  {
    key: "!",
    label: "worker attempts to mutate ANOTHER lane (should reject)",
    run: () => {
      const attempt = event("lane.running", WORKER, {});
      const result = store.append({ ...attempt, lane: OTHER_LANE }, WORKER);
      lastMessage = result.ok
        ? "!! guard failure: cross-lane write was allowed"
        : `guard held: cross-lane write rejected [${result.code}]`;
    },
  },
  {
    key: "@",
    label: "worker attempts GLOBAL policy write (should reject)",
    run: () => {
      const result = store.setPolicy("merge_gate", "disabled", WORKER, new Date().toISOString());
      lastMessage = result.ok
        ? "!! guard failure: worker set global policy"
        : `guard held: policy write rejected [${result.code}]`;
    },
  },
  {
    key: "k",
    label: "supervisor: reconcile (recovers only if lane needs it)",
    run: () => {
      if (!record) {
        lastMessage = "no lane to reconcile";
        return;
      }
      if (record.state === "attention_required" || record.state === "recovery_required") {
        apply("lane.reconciled", SUPER);
        return;
      }
      lastMessage = `supervisor verified healthy lane @ ${record.state} v${record.version} (no mutation)`;
    },
  },
  {
    key: "X",
    label: "SIMULATE orchestrator restart (drop cache, re-project from log)",
    run: () => {
      record = undefined;
      const events = store.events(LANE).length;
      record = store.project(LANE);
      lastMessage = `re-projected lane from ${events} durable events -> ${record?.state ?? "none"}`;
    },
  },
];

function frame(): string {
  const lines: string[] = [];
  lines.push("\x1b[1mWayfinder lane coordination — PROTOTYPE (JWB-325)\x1b[0m");
  lines.push("\x1b[2mDurable, re-attachable lane state via structured events. Throwaway.\x1b[0m");
  lines.push("");
  if (record) {
    lines.push(`  lane        ${record.lane}`);
    lines.push(`  ticket      ${record.ticket}`);
    lines.push(`  state       \x1b[1m${record.state}\x1b[0m   (version ${record.version})`);
    lines.push(`  revisions   ${record.revisions}`);
    lines.push(
      `  services    ${record.services.map((s) => `${s.name}:${s.port}`).join(", ") || "—"}`,
    );
    lines.push(`  artifacts   ${record.artifacts.map((a) => a.ref).join(", ") || "—"}`);
    if (record.attention) lines.push(`  attention   ${record.attention}`);
  } else {
    lines.push("  (no lane yet)");
  }
  lines.push("");
  lines.push("  \x1b[2mrecent events (durable log):\x1b[0m");
  const events = store.events(LANE);
  for (const evt of events.slice(-6)) {
    lines.push(`    ${evt.at.slice(11, 19)}  ${evt.role.padEnd(12)} ${evt.kind}`);
  }
  if (events.length === 0) lines.push("    —");
  lines.push("");
  lines.push(`  \x1b[36m${lastMessage}\x1b[0m`);
  lines.push("");
  lines.push("  \x1b[2mkeys:\x1b[0m");
  for (const binding of bindings) {
    lines.push(`    ${binding.key}  ${binding.label}`);
  }
  lines.push("    q  quit (lane persists — re-run to prove restart survival)");
  return lines.join("\n");
}

function render(): void {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  process.stdout.write(`${frame()}\n`);
}

function shutdown(): void {
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  store.close();
  process.stdout.write("\nLane left durable in the store. Bye.\n");
  process.exit(0);
}

if (!process.stdin.isTTY) {
  process.stdout.write(
    "This prototype is interactive; run it in a terminal (bun run proto:lane).\n" +
      "For an automated, assertable proof run: bun run proto:lane:demo\n",
  );
  store.close();
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");
process.stdin.on("data", (key: string) => {
  if (key === "" || key === "q") {
    shutdown();
    return;
  }
  const binding = bindings.find((b) => b.key === key);
  if (binding) binding.run();
  render();
});

render();
