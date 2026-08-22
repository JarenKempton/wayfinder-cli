// Production lane state machine and typed event vocabulary (JWB-326).
//
// This is the portable coordination logic promised by docs/agent-runtime-
// architecture.md and proven by the JWB-325 prototype: a pure lane state
// machine, a typed event vocabulary (the "Wayfinder-owned channel"), a
// scoped-authority guard, and a pure projection fold. It has NO I/O and imports
// nothing from the durable store — the reducer is `(record, event, authority) =>
// record`, so any fresh process can re-derive identical lane state purely from a
// durable event log (see src/lane-store.ts).
//
// Lane truth is an append-only log of typed events. The projection is never
// mutated in place; it is always recomputed by folding events through this
// reducer. That is what lets a restarted orchestrator or a replaced supervisor
// re-attach and recover identical lane identity and state with no in-memory
// handoff.

/** Lane lifecycle states (docs/agent-runtime-architecture.md § lane state machine). */
export type LaneState =
  | "queued"
  | "preparing"
  | "running"
  | "blocked"
  | "ready_for_validation"
  | "validating"
  | "revision_required"
  | "ready_for_review"
  | "reviewing"
  | "approved"
  | "human_ready"
  | "completed"
  | "stopped"
  | "failed"
  | "attention_required"
  | "recovery_required";

/** Every way a lane's truth can change flows through one typed event kind. */
export type LaneEventKind =
  // lifecycle transitions
  | "lane.created"
  | "lane.preparing"
  | "lane.running"
  | "lane.blocked"
  | "lane.ready_for_validation"
  | "lane.validating"
  | "lane.ready_for_review"
  | "lane.revision_requested"
  | "lane.reviewing"
  | "lane.approved"
  | "lane.human_ready"
  | "lane.completed"
  | "lane.stopped"
  | "lane.failed"
  | "lane.attention_required"
  | "lane.recovery_required"
  | "lane.recovered"
  | "lane.reconciled"
  // observations that annotate a lane without moving its lifecycle state
  | "lane.observed"
  | "lane.service_announced"
  | "lane.artifact_added"
  // global control-plane policy — deliberately NOT lane-scoped
  | "policy.set";

export type LaneRole = "worker" | "orchestrator" | "supervisor" | "system";

/**
 * A scoped capability credential. A worker credential carries `laneScope` and
 * may only ever touch that one lane; it can never widen its own authority by
 * naming a different role, because authorization derives from the credential,
 * never from the event body.
 */
export interface LaneAuthority {
  principal: string;
  role: LaneRole;
  /** Required for `worker`: the only lane this credential may mutate. */
  laneScope?: string;
}

export interface LaneServiceEndpoint {
  name: string;
  port: number;
  announcedBy: string;
}

export interface LaneArtifact {
  ref: string;
  kind?: string;
  addedBy: string;
}

/** A durable liveness/progress observation that annotates a lane. */
export interface LaneObservation {
  state: string;
  detail?: string;
  observedBy: string;
  observedAt: string;
}

/** Latest deterministic-validation result projected onto the lane. */
export interface LaneValidation {
  checks: Record<string, "passed" | "failed">;
  at: string;
  by: string;
}

/** Latest independent-review result projected onto the lane. */
export interface LaneReview {
  outcome: "approved" | "revision_required";
  findings?: string[];
  at: string;
  by: string;
}

/** Durable recovery/attention evidence, mirroring src/state.ts recovery rows. */
export interface LaneRecoveryEvidence {
  outcome: LaneEventKind;
  evidence?: unknown;
  at: string;
  by: string;
}

/** A structured lane event. `at` is supplied by the caller to keep this module pure. */
export interface LaneEvent {
  kind: LaneEventKind;
  /** Lane id. Empty string for `policy.set` (global). */
  lane: string;
  at: string;
  actor: string;
  role: LaneRole;
  reason?: string;
  ticket?: string;
  observation?: { state: string; detail?: string };
  service?: { name: string; port: number };
  artifact?: { ref: string; kind?: string };
  policy?: { key: string; value: unknown };
  checks?: Record<string, "passed" | "failed">;
  findings?: string[];
  evidence?: unknown;
}

/** Durable projection of a lane — a pure fold over its event log. */
export interface LaneRecord {
  lane: string;
  ticket: string;
  state: LaneState;
  /** Monotonic truth version; increments once per applied event. */
  version: number;
  services: LaneServiceEndpoint[];
  artifacts: LaneArtifact[];
  observations: LaneObservation[];
  recovery: LaneRecoveryEvidence[];
  revisions: number;
  lastEventKind: LaneEventKind;
  createdAt: string;
  updatedAt: string;
  attention?: string;
  validation?: LaneValidation;
  review?: LaneReview;
}

export type ReductionCode =
  | "unauthorized_scope"
  | "unauthorized_capability"
  | "scope_missing"
  | "unknown_lane"
  | "already_exists"
  | "illegal_transition"
  | "malformed_event";

export type LaneReduction =
  | { ok: true; record: LaneRecord }
  | { ok: false; code: ReductionCode; reason: string };

export type Authorization = { ok: true } | { ok: false; code: ReductionCode; reason: string };

const WORKER_EVENTS = new Set<LaneEventKind>([
  "lane.running",
  "lane.blocked",
  "lane.ready_for_validation",
  "lane.observed",
  "lane.service_announced",
  "lane.artifact_added",
  "lane.stopped",
]);

const ORCHESTRATOR_EVENTS = new Set<LaneEventKind>([
  "lane.created",
  "lane.preparing",
  "lane.validating",
  "lane.ready_for_review",
  "lane.revision_requested",
  "lane.reviewing",
  "lane.approved",
  "lane.human_ready",
  "lane.completed",
  "lane.failed",
  "lane.stopped",
  "policy.set",
]);

const SUPERVISOR_EVENTS = new Set<LaneEventKind>([
  "lane.observed",
  "lane.attention_required",
  "lane.recovery_required",
  "lane.recovered",
  "lane.reconciled",
]);

/** Kinds whose only effect is to annotate a lane, never to move its state. */
const ANNOTATION_EVENTS = new Set<LaneEventKind>([
  "lane.observed",
  "lane.service_announced",
  "lane.artifact_added",
]);

/** Kinds that carry recovery/attention evidence into the durable projection. */
const RECOVERY_EVENTS = new Set<LaneEventKind>([
  "lane.attention_required",
  "lane.recovery_required",
  "lane.recovered",
  "lane.reconciled",
]);

/** Legal lifecycle transitions. Failure/recovery states are explicit, never inferred. */
const TRANSITIONS: Record<LaneState, LaneState[]> = {
  queued: ["preparing", "failed", "stopped"],
  preparing: ["running", "failed", "stopped", "attention_required"],
  running: [
    "blocked",
    "ready_for_validation",
    "stopped",
    "failed",
    "attention_required",
    "recovery_required",
  ],
  blocked: ["running", "stopped", "failed", "attention_required"],
  ready_for_validation: ["validating", "running", "stopped", "attention_required"],
  validating: ["ready_for_review", "revision_required", "failed", "attention_required"],
  revision_required: ["running", "stopped", "failed"],
  ready_for_review: ["reviewing", "stopped", "attention_required"],
  reviewing: ["approved", "revision_required", "attention_required"],
  approved: ["human_ready", "stopped"],
  human_ready: ["completed", "revision_required"],
  completed: [],
  stopped: ["running"],
  failed: ["running", "stopped"],
  attention_required: ["running", "stopped", "recovery_required", "failed"],
  recovery_required: ["running", "stopped", "failed"],
};

const EVENT_TARGET: Partial<Record<LaneEventKind, LaneState>> = {
  "lane.preparing": "preparing",
  "lane.running": "running",
  "lane.blocked": "blocked",
  "lane.ready_for_validation": "ready_for_validation",
  "lane.validating": "validating",
  "lane.ready_for_review": "ready_for_review",
  "lane.revision_requested": "revision_required",
  "lane.reviewing": "reviewing",
  "lane.approved": "approved",
  "lane.human_ready": "human_ready",
  "lane.completed": "completed",
  "lane.stopped": "stopped",
  "lane.failed": "failed",
  "lane.attention_required": "attention_required",
  "lane.recovery_required": "recovery_required",
  "lane.recovered": "running",
  "lane.reconciled": "running",
};

/**
 * Authorize an event against a credential. This is the whole of "scoped lane
 * authority": a worker is pinned to one lane and a small verb set, only the
 * orchestrator/control-plane touches global policy, and the supervisor may only
 * drive recovery/reconciliation and observation — never implement.
 */
export function authorizeLaneEvent(authority: LaneAuthority, event: LaneEvent): Authorization {
  if (event.kind === "policy.set") {
    if (authority.role !== "orchestrator") {
      return deny("unauthorized_capability", `${authority.role} may not mutate global policy`);
    }
    return { ok: true };
  }
  switch (authority.role) {
    case "system":
      return { ok: true };
    case "worker": {
      if (authority.laneScope === undefined) {
        return deny("scope_missing", "worker credential carries no lane scope");
      }
      if (event.lane !== authority.laneScope) {
        return deny(
          "unauthorized_scope",
          `worker scoped to ${authority.laneScope} may not mutate ${event.lane}`,
        );
      }
      if (!WORKER_EVENTS.has(event.kind)) {
        return deny("unauthorized_capability", `worker may not emit ${event.kind}`);
      }
      return { ok: true };
    }
    case "orchestrator":
      if (!ORCHESTRATOR_EVENTS.has(event.kind)) {
        return deny("unauthorized_capability", `orchestrator may not emit ${event.kind}`);
      }
      return { ok: true };
    case "supervisor":
      if (!SUPERVISOR_EVENTS.has(event.kind)) {
        return deny("unauthorized_capability", `supervisor may not emit ${event.kind}`);
      }
      return { ok: true };
  }
}

/**
 * Pure reducer: apply one authorized event to the current lane projection.
 * `(record, event, authority) => record`. No I/O, no clock, no globals.
 */
export function applyLaneEvent(
  current: LaneRecord | undefined,
  event: LaneEvent,
  authority: LaneAuthority,
): LaneReduction {
  const auth = authorizeLaneEvent(authority, event);
  if (!auth.ok) return auth;

  if (event.kind === "policy.set") {
    return deny("malformed_event", "policy.set is a global event with no lane record");
  }

  if (event.kind === "lane.created") {
    if (current) return deny("already_exists", `lane ${event.lane} already exists`);
    if (!event.ticket) return deny("malformed_event", "lane.created requires a ticket");
    return { ok: true, record: initialRecord(event, event.ticket) };
  }

  if (!current) return deny("unknown_lane", `no lane ${event.lane}`);

  if (ANNOTATION_EVENTS.has(event.kind)) {
    return annotate(current, event);
  }

  const target = EVENT_TARGET[event.kind];
  if (!target) return deny("malformed_event", `no transition defined for ${event.kind}`);
  if (!TRANSITIONS[current.state].includes(target)) {
    return deny("illegal_transition", `${current.state} -> ${target} is not a legal transition`);
  }

  const attention = target === "attention_required" || target === "recovery_required";
  const next: LaneRecord = {
    ...current,
    state: target,
    version: current.version + 1,
    updatedAt: event.at,
    lastEventKind: event.kind,
    revisions: event.kind === "lane.revision_requested" ? current.revisions + 1 : current.revisions,
    ...(attention && event.reason ? { attention: event.reason } : {}),
  };

  // Validation results (deterministic checks) project onto the lane whenever an
  // orchestrator carries them, regardless of which validation transition fired.
  if (event.checks) {
    next.validation = { checks: event.checks, at: event.at, by: event.actor };
  }

  // Independent-review outcomes project only for review-stage transitions, so a
  // validation-driven revision is never mislabeled as a review verdict.
  if (event.kind === "lane.approved") {
    next.review = { outcome: "approved", at: event.at, by: event.actor };
  } else if (event.kind === "lane.revision_requested" && current.state === "reviewing") {
    next.review = {
      outcome: "revision_required",
      at: event.at,
      by: event.actor,
      ...(event.findings ? { findings: event.findings } : {}),
    };
  }

  if (RECOVERY_EVENTS.has(event.kind)) {
    next.recovery = [
      ...current.recovery,
      {
        outcome: event.kind,
        at: event.at,
        by: event.actor,
        ...(event.evidence !== undefined ? { evidence: event.evidence } : {}),
      },
    ];
  }

  return { ok: true, record: next };
}

/**
 * Rebuild a lane's projection purely from its durable event log. This is what
 * makes an orchestrator restart safe: state is a deterministic fold over durable
 * events, not something held in a live process. Replay trusts the log, because
 * every event was authorized at append time.
 */
export function projectLane(events: LaneEvent[]): LaneRecord | undefined {
  const system: LaneAuthority = { principal: "wayfinder:replay", role: "system" };
  let record: LaneRecord | undefined;
  for (const event of events) {
    const result = applyLaneEvent(record, event, system);
    if (!result.ok) {
      throw new Error(`corrupt lane log at ${event.kind}: ${result.reason}`);
    }
    record = result.record;
  }
  return record;
}

function annotate(current: LaneRecord, event: LaneEvent): LaneReduction {
  const base: LaneRecord = {
    ...current,
    version: current.version + 1,
    updatedAt: event.at,
    lastEventKind: event.kind,
  };

  if (event.kind === "lane.observed") {
    if (!event.observation) return deny("malformed_event", "lane.observed requires an observation");
    const observation: LaneObservation = {
      state: event.observation.state,
      observedBy: event.actor,
      observedAt: event.at,
      ...(event.observation.detail ? { detail: event.observation.detail } : {}),
    };
    return { ok: true, record: { ...base, observations: [...current.observations, observation] } };
  }

  if (event.kind === "lane.service_announced") {
    if (!event.service) return deny("malformed_event", "service_announced requires a service");
    return {
      ok: true,
      record: {
        ...base,
        services: [...current.services, { ...event.service, announcedBy: event.actor }],
      },
    };
  }

  // lane.artifact_added
  if (!event.artifact) return deny("malformed_event", "artifact_added requires an artifact");
  const artifact: LaneArtifact = {
    ref: event.artifact.ref,
    addedBy: event.actor,
    ...(event.artifact.kind ? { kind: event.artifact.kind } : {}),
  };
  return { ok: true, record: { ...base, artifacts: [...current.artifacts, artifact] } };
}

function initialRecord(event: LaneEvent, ticket: string): LaneRecord {
  return {
    lane: event.lane,
    ticket,
    state: "queued",
    version: 1,
    services: [],
    artifacts: [],
    observations: [],
    recovery: [],
    revisions: 0,
    lastEventKind: "lane.created",
    createdAt: event.at,
    updatedAt: event.at,
  };
}

function deny(
  code: ReductionCode,
  reason: string,
): { ok: false; code: ReductionCode; reason: string } {
  return { ok: false, code, reason };
}
