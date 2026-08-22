import { expect, test } from "bun:test";
import {
  applyLaneEvent,
  authorizeLaneEvent,
  type LaneAuthority,
  type LaneEvent,
  type LaneEventKind,
  type LaneRecord,
  type LaneState,
  projectLane,
} from "../src/lane.ts";

const LANE = "wf-lane:JWB-326";
const TICKET = "JWB-326";

const system: LaneAuthority = { principal: "wayfinder:test", role: "system" };
const orchestrator: LaneAuthority = { principal: "alice", role: "orchestrator" };
const worker: LaneAuthority = { principal: "w-quinn", role: "worker", laneScope: LANE };
const supervisor: LaneAuthority = { principal: "sup-a", role: "supervisor" };

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
}

function ev(kind: LaneEventKind, overrides: Partial<LaneEvent> = {}): LaneEvent {
  return {
    kind,
    lane: LANE,
    at: at(),
    actor: overrides.actor ?? "actor",
    role: overrides.role ?? "system",
    ...overrides,
  };
}

/** Fold a sequence of events with the system credential and require success. */
function fold(kinds: Array<LaneEventKind | LaneEvent>): LaneRecord {
  let record: LaneRecord | undefined;
  for (const item of kinds) {
    const event = typeof item === "string" ? ev(item, { ticket: TICKET }) : item;
    const result = applyLaneEvent(record, event, system);
    if (!result.ok) throw new Error(`unexpected rejection ${result.code}: ${result.reason}`);
    record = result.record;
  }
  if (!record) throw new Error("no record produced");
  return record;
}

test("lane.created builds the initial queued record and rejects duplicates", () => {
  const created = applyLaneEvent(undefined, ev("lane.created", { ticket: TICKET }), system);
  expect(created.ok).toBe(true);
  if (!created.ok) return;
  expect(created.record).toMatchObject({
    lane: LANE,
    ticket: TICKET,
    state: "queued",
    version: 1,
    revisions: 0,
    services: [],
    artifacts: [],
    observations: [],
    recovery: [],
  });

  const dup = applyLaneEvent(created.record, ev("lane.created", { ticket: TICKET }), system);
  expect(dup).toMatchObject({ ok: false, code: "already_exists" });
});

test("lane.created without a ticket is malformed", () => {
  const result = applyLaneEvent(undefined, ev("lane.created"), system);
  expect(result).toMatchObject({ ok: false, code: "malformed_event" });
});

test("events targeting an unknown lane are rejected", () => {
  const result = applyLaneEvent(undefined, ev("lane.running"), system);
  expect(result).toMatchObject({ ok: false, code: "unknown_lane" });
});

test("the full happy-path lifecycle advances state and version monotonically", () => {
  const record = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    "lane.validating",
    "lane.ready_for_review",
    "lane.reviewing",
    "lane.approved",
    "lane.human_ready",
    "lane.completed",
  ]);
  expect(record.state).toBe("completed");
  expect(record.version).toBe(10);
  expect(record.lastEventKind).toBe("lane.completed");
});

test("every legal transition in the machine is accepted from its source state", () => {
  // Shortest event path that lands the lane in each source state.
  const pathTo: Record<LaneState, LaneEventKind[]> = {
    queued: ["lane.created"],
    preparing: ["lane.created", "lane.preparing"],
    running: ["lane.created", "lane.preparing", "lane.running"],
    blocked: ["lane.created", "lane.preparing", "lane.running", "lane.blocked"],
    ready_for_validation: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
    ],
    validating: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
    ],
    revision_required: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
      "lane.revision_requested",
    ],
    ready_for_review: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
      "lane.ready_for_review",
    ],
    reviewing: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
      "lane.ready_for_review",
      "lane.reviewing",
    ],
    approved: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
      "lane.ready_for_review",
      "lane.reviewing",
      "lane.approved",
    ],
    human_ready: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.ready_for_validation",
      "lane.validating",
      "lane.ready_for_review",
      "lane.reviewing",
      "lane.approved",
      "lane.human_ready",
    ],
    completed: [],
    stopped: ["lane.created", "lane.preparing", "lane.running", "lane.stopped"],
    failed: ["lane.created", "lane.preparing", "lane.running", "lane.failed"],
    attention_required: [
      "lane.created",
      "lane.preparing",
      "lane.running",
      "lane.attention_required",
    ],
    recovery_required: ["lane.created", "lane.preparing", "lane.running", "lane.recovery_required"],
  };

  const legal: Array<[LaneState, LaneEventKind, LaneState]> = [
    ["queued", "lane.preparing", "preparing"],
    ["preparing", "lane.running", "running"],
    ["running", "lane.blocked", "blocked"],
    ["blocked", "lane.running", "running"],
    ["running", "lane.ready_for_validation", "ready_for_validation"],
    ["ready_for_validation", "lane.validating", "validating"],
    ["ready_for_validation", "lane.running", "running"],
    ["validating", "lane.ready_for_review", "ready_for_review"],
    ["validating", "lane.revision_requested", "revision_required"],
    ["ready_for_review", "lane.reviewing", "reviewing"],
    ["reviewing", "lane.approved", "approved"],
    ["reviewing", "lane.revision_requested", "revision_required"],
    ["approved", "lane.human_ready", "human_ready"],
    ["human_ready", "lane.completed", "completed"],
    ["human_ready", "lane.revision_requested", "revision_required"],
    ["revision_required", "lane.running", "running"],
    ["running", "lane.attention_required", "attention_required"],
    ["attention_required", "lane.recovery_required", "recovery_required"],
    ["recovery_required", "lane.running", "running"],
    ["running", "lane.failed", "failed"],
    ["failed", "lane.running", "running"],
    ["running", "lane.stopped", "stopped"],
    ["stopped", "lane.running", "running"],
  ];

  for (const [source, kind, target] of legal) {
    const record = fold([...pathTo[source]]);
    expect(record.state).toBe(source);
    const result = applyLaneEvent(record, ev(kind), system);
    if (!result.ok) {
      throw new Error(`expected ${source} -> ${target} via ${kind}, got ${result.code}`);
    }
    expect(result.record.state).toBe(target);
    expect(result.record.version).toBe(record.version + 1);
  }
});

test("illegal transitions are rejected explicitly, not silently applied", () => {
  const record = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
  ]);
  const illegal = applyLaneEvent(record, ev("lane.blocked"), system);
  expect(illegal).toMatchObject({ ok: false, code: "illegal_transition" });

  const completed = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    "lane.validating",
    "lane.ready_for_review",
    "lane.reviewing",
    "lane.approved",
    "lane.human_ready",
    "lane.completed",
  ]);
  // completed is terminal — no outgoing transitions.
  expect(applyLaneEvent(completed, ev("lane.running"), system)).toMatchObject({
    ok: false,
    code: "illegal_transition",
  });
});

test("attention and recovery states are explicit and carry reasons plus evidence", () => {
  const attention = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    ev("lane.attention_required", { reason: "heartbeat lost", evidence: { pid: 1 } }),
  ]);
  expect(attention.state).toBe("attention_required");
  expect(attention.attention).toBe("heartbeat lost");
  expect(attention.recovery).toHaveLength(1);
  expect(attention.recovery[0]).toMatchObject({
    outcome: "lane.attention_required",
    evidence: { pid: 1 },
  });

  const recovered = applyLaneEvent(
    attention,
    ev("lane.recovery_required", { reason: "manual", evidence: { step: "reclaim" } }),
    system,
  );
  expect(recovered.ok).toBe(true);
  if (!recovered.ok) return;
  expect(recovered.record.state).toBe("recovery_required");
  expect(recovered.record.recovery).toHaveLength(2);
});

test("deterministic validation results project onto the lane", () => {
  const record = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    ev("lane.validating", { checks: { tests: "passed", lint: "passed" } }),
  ]);
  expect(record.validation).toMatchObject({ checks: { tests: "passed", lint: "passed" } });
});

test("review outcomes project only for review-stage transitions", () => {
  const approved = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    "lane.validating",
    "lane.ready_for_review",
    "lane.reviewing",
    "lane.approved",
  ]);
  expect(approved.review).toMatchObject({ outcome: "approved" });

  const reviewRevision = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    "lane.validating",
    "lane.ready_for_review",
    "lane.reviewing",
    ev("lane.revision_requested", { findings: ["missing tests"] }),
  ]);
  expect(reviewRevision.state).toBe("revision_required");
  expect(reviewRevision.review).toMatchObject({
    outcome: "revision_required",
    findings: ["missing tests"],
  });

  // A validation-driven revision must NOT be recorded as a review verdict.
  const validationRevision = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    "lane.ready_for_validation",
    "lane.validating",
    ev("lane.revision_requested", { findings: ["flaky"] }),
  ]);
  expect(validationRevision.state).toBe("revision_required");
  expect(validationRevision.review).toBeUndefined();
  expect(validationRevision.revisions).toBe(1);
});

test("annotation events accumulate observations, services, and artifacts without moving state", () => {
  const record = fold([
    "lane.created",
    "lane.preparing",
    "lane.running",
    ev("lane.observed", { observation: { state: "healthy", detail: "cpu ok" }, actor: "sup-a" }),
    ev("lane.service_announced", { service: { name: "web", port: 3000 }, actor: "w-quinn" }),
    ev("lane.artifact_added", {
      artifact: { ref: "pr/12", kind: "pull_request" },
      actor: "w-quinn",
    }),
  ]);
  expect(record.state).toBe("running");
  expect(record.observations).toEqual([
    { state: "healthy", detail: "cpu ok", observedBy: "sup-a", observedAt: expect.any(String) },
  ]);
  expect(record.services).toEqual([{ name: "web", port: 3000, announcedBy: "w-quinn" }]);
  expect(record.artifacts).toEqual([{ ref: "pr/12", kind: "pull_request", addedBy: "w-quinn" }]);
});

test("malformed annotation events are rejected", () => {
  const running = fold(["lane.created", "lane.preparing", "lane.running"]);
  expect(applyLaneEvent(running, ev("lane.observed"), system)).toMatchObject({
    ok: false,
    code: "malformed_event",
  });
  expect(applyLaneEvent(running, ev("lane.service_announced"), system)).toMatchObject({
    ok: false,
    code: "malformed_event",
  });
  expect(applyLaneEvent(running, ev("lane.artifact_added"), system)).toMatchObject({
    ok: false,
    code: "malformed_event",
  });
});

test("worker authority is pinned to one lane and a small verb set", () => {
  const running = fold(["lane.created", "lane.preparing", "lane.running"]);

  // In-scope, allowed verb.
  expect(authorizeLaneEvent(worker, ev("lane.ready_for_validation", { role: "worker" }))).toEqual({
    ok: true,
  });

  // Out-of-scope lane.
  expect(
    authorizeLaneEvent(worker, ev("lane.running", { lane: "wf-lane:other", role: "worker" })),
  ).toMatchObject({ ok: false, code: "unauthorized_scope" });

  // Verb a worker may not emit.
  expect(authorizeLaneEvent(worker, ev("lane.approved", { role: "worker" }))).toMatchObject({
    ok: false,
    code: "unauthorized_capability",
  });

  // A worker credential without a lane scope cannot act.
  const scopeless: LaneAuthority = { principal: "w", role: "worker" };
  expect(authorizeLaneEvent(scopeless, ev("lane.running", { role: "worker" }))).toMatchObject({
    ok: false,
    code: "scope_missing",
  });

  // applyLaneEvent enforces authority too, not just the standalone guard.
  const denied = applyLaneEvent(running, ev("lane.approved", { role: "worker" }), worker);
  expect(denied).toMatchObject({ ok: false, code: "unauthorized_capability" });
});

test("only an orchestrator may set global policy", () => {
  const policy = (a: LaneAuthority) =>
    authorizeLaneEvent(a, {
      kind: "policy.set",
      lane: "",
      at: at(),
      actor: a.principal,
      role: a.role,
      policy: { key: "merge_gate", value: "blocked" },
    });
  expect(policy(orchestrator)).toEqual({ ok: true });
  expect(policy(worker)).toMatchObject({ ok: false, code: "unauthorized_capability" });
  expect(policy(supervisor)).toMatchObject({ ok: false, code: "unauthorized_capability" });
});

test("supervisor may observe and drive recovery but not implement", () => {
  expect(authorizeLaneEvent(supervisor, ev("lane.reconciled", { role: "supervisor" }))).toEqual({
    ok: true,
  });
  expect(authorizeLaneEvent(supervisor, ev("lane.observed", { role: "supervisor" }))).toEqual({
    ok: true,
  });
  expect(authorizeLaneEvent(supervisor, ev("lane.running", { role: "supervisor" }))).toMatchObject({
    ok: false,
    code: "unauthorized_capability",
  });
});

test("policy.set has no lane record and is rejected by the reducer", () => {
  const result = applyLaneEvent(
    undefined,
    {
      kind: "policy.set",
      lane: "",
      at: at(),
      actor: "alice",
      role: "orchestrator",
      policy: { key: "k", value: 1 },
    },
    orchestrator,
  );
  expect(result).toMatchObject({ ok: false, code: "malformed_event" });
});

test("projectLane deterministically replays an event log to identical state", () => {
  const events: LaneEvent[] = [
    ev("lane.created", { ticket: TICKET, role: "orchestrator", actor: "alice" }),
    ev("lane.preparing", { role: "orchestrator", actor: "alice" }),
    ev("lane.running", { role: "worker", actor: "w-quinn" }),
    ev("lane.service_announced", {
      service: { name: "web", port: 3000 },
      role: "worker",
      actor: "w-quinn",
    }),
    ev("lane.ready_for_validation", { role: "worker", actor: "w-quinn" }),
  ];
  const first = projectLane(events);
  const second = projectLane(events);
  expect(first).toEqual(second);
  expect(first?.state).toBe("ready_for_validation");
  expect(first?.version).toBe(5);
  expect(projectLane([])).toBeUndefined();
});

test("projectLane throws on a corrupt (illegal) event log", () => {
  const events: LaneEvent[] = [
    ev("lane.created", { ticket: TICKET }),
    ev("lane.approved"), // illegal from queued
  ];
  expect(() => projectLane(events)).toThrow(/corrupt lane log/);
});
