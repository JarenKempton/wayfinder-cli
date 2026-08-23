// PROTOTYPE — JWB-329. Throwaway code that answers one question. Do not import
// from src/ or ship this shell into production. See ./README.md for the verdict.
//
// This is the ONE part of the prototype worth keeping past its lifetime: a pure,
// I/O-free lane state machine. The durable lane projection is a *fold* over an
// append-only event log, so any fresh orchestrator process re-derives byte-identical
// state (the reconnect proof). No docker, no fs, no clock, no console in here.

export type LanePhase =
  | "declared"
  | "workspace_ready"
  | "agent_running"
  | "ready"
  | "attention_required"
  | "stopped"
  | "torn_down"
  | "failed";

/** An AgentInvocation in the JWB-327 shape: launch is separate from execution. */
export interface AgentInvocation {
  agent: string;
  argv: readonly string[];
  /** cwd is a path in the *sandbox's* frame of reference (ADR 0001 §15), not the host. */
  cwd: string;
}

/**
 * The append-only lane event vocabulary. Every event carries the lane it belongs
 * to and a monotonically-assigned sequence number so two processes fold in the
 * same order. Timestamps are supplied by the shell; the fold never reads a clock.
 */
export type LaneEvent =
  | { type: "lane_declared"; laneId: string; adapter: string; profile: string }
  | {
      type: "preflight_recorded";
      laneId: string;
      strongIsolation: boolean;
      boundary: string;
      reasons: readonly string[];
    }
  | {
      type: "plan_recorded";
      laneId: string;
      planId: string;
      summary: string;
      warnings: readonly string[];
      containsSecrets: false;
    }
  | {
      type: "workspace_materialized";
      laneId: string;
      // The workspace handle in the sandbox frame of reference (§15).
      workspaceHandle: string;
      privateClone: true;
      sourceRef: string;
      // A sandbox-private clone must never have writable host-repository access (§6).
      hostRepositoryWritable: false;
    }
  | { type: "agent_launched"; laneId: string; sandboxId: string; invocation: AgentInvocation }
  | {
      type: "service_exposed";
      laneId: string;
      endpoint: string;
      containerPort: number;
      resourceId: string;
    }
  | { type: "readiness_verified"; laneId: string; evidence: string }
  | { type: "readiness_failed"; laneId: string; evidence: string }
  | {
      type: "reconnect_observed";
      laneId: string;
      byProcess: number;
      liveSandbox: boolean;
      endpointAnswered: boolean;
    }
  | { type: "stop_requested"; laneId: string }
  | { type: "stopped"; laneId: string; releasedResourceIds: readonly string[] }
  | { type: "teardown_completed"; laneId: string; removed: readonly string[] }
  | {
      type: "lane_failed";
      laneId: string;
      phaseAtFailure: LanePhase;
      evidence: string;
      compensated: boolean;
    };

export type LaneEventType = LaneEvent["type"];

export interface LaneReceipt {
  /** Only resources the adapter can prove it owns; stop is scoped to exactly these. */
  ownedResourceIds: string[];
}

export interface LaneState {
  laneId: string | null;
  phase: LanePhase;
  adapter: string | null;
  profile: string | null;
  strongIsolation: boolean;
  boundary: string | null;
  planId: string | null;
  workspaceHandle: string | null;
  privateClone: boolean;
  hostRepositoryWritable: boolean;
  sandboxId: string | null;
  invocation: AgentInvocation | null;
  endpoint: string | null;
  receipt: LaneReceipt;
  readinessEvidence: string | null;
  failure: { phaseAtFailure: LanePhase; evidence: string; compensated: boolean } | null;
  reconnects: number;
}

export function initialLaneState(): LaneState {
  return {
    laneId: null,
    phase: "declared",
    adapter: null,
    profile: null,
    strongIsolation: false,
    boundary: null,
    planId: null,
    workspaceHandle: null,
    privateClone: false,
    hostRepositoryWritable: false,
    sandboxId: null,
    invocation: null,
    endpoint: null,
    receipt: { ownedResourceIds: [] },
    readinessEvidence: null,
    failure: null,
    reconnects: 0,
  };
}

/**
 * Guard: which event types may legally follow the current phase. Returning a
 * reason (not throwing) keeps this pure; the shell decides what to do with it.
 * A failed readiness check must NEVER become success — that invariant lives here.
 */
export function transitionError(state: LaneState, next: LaneEventType): string | null {
  const p = state.phase;
  switch (next) {
    case "lane_declared":
      return state.laneId === null ? null : "lane already declared";
    case "preflight_recorded":
    case "plan_recorded":
      return p === "declared" ? null : `cannot ${next} from phase ${p}`;
    case "workspace_materialized":
      return p === "declared" ? null : `cannot materialize workspace from phase ${p}`;
    case "agent_launched":
      return p === "workspace_ready" ? null : `cannot launch agent from phase ${p}`;
    case "service_exposed":
      return p === "agent_running" ? null : `cannot expose service from phase ${p}`;
    case "readiness_verified":
    case "readiness_failed":
      // Readiness is only meaningful once a service endpoint exists.
      return state.endpoint !== null ? null : "cannot verify readiness before a service is exposed";
    case "reconnect_observed":
      return state.sandboxId !== null ? null : "cannot reconnect to a lane with no sandbox";
    case "stop_requested":
      return p === "torn_down" ? "lane already torn down" : null;
    case "stopped":
      return p === "torn_down" ? "lane already torn down" : null;
    case "teardown_completed":
      return null;
    case "lane_failed":
      return null;
  }
}

/** The pure reducer. Unknown/illegal orderings still fold deterministically. */
export function reduce(state: LaneState, event: LaneEvent): LaneState {
  switch (event.type) {
    case "lane_declared":
      return { ...state, laneId: event.laneId, adapter: event.adapter, profile: event.profile };
    case "preflight_recorded":
      return {
        ...state,
        strongIsolation: event.strongIsolation,
        boundary: event.boundary,
      };
    case "plan_recorded":
      return { ...state, planId: event.planId };
    case "workspace_materialized":
      return {
        ...state,
        phase: "workspace_ready",
        workspaceHandle: event.workspaceHandle,
        privateClone: event.privateClone,
        hostRepositoryWritable: event.hostRepositoryWritable,
      };
    case "agent_launched":
      return {
        ...state,
        phase: "agent_running",
        sandboxId: event.sandboxId,
        invocation: event.invocation,
        receipt: { ownedResourceIds: addOnce(state.receipt.ownedResourceIds, event.sandboxId) },
      };
    case "service_exposed":
      return {
        ...state,
        endpoint: event.endpoint,
        receipt: { ownedResourceIds: addOnce(state.receipt.ownedResourceIds, event.resourceId) },
      };
    case "readiness_verified":
      return { ...state, phase: "ready", readinessEvidence: event.evidence };
    case "readiness_failed":
      // Ambiguous/failed readiness is attention-required and retains its evidence.
      return { ...state, phase: "attention_required", readinessEvidence: event.evidence };
    case "reconnect_observed":
      return { ...state, reconnects: state.reconnects + 1 };
    case "stop_requested":
      return state;
    case "stopped":
      return { ...state, phase: "stopped" };
    case "teardown_completed":
      return { ...state, phase: "torn_down", endpoint: null };
    case "lane_failed":
      return {
        ...state,
        phase: "failed",
        failure: {
          phaseAtFailure: event.phaseAtFailure,
          evidence: event.evidence,
          compensated: event.compensated,
        },
      };
  }
}

/** Fold an ordered event log into lane state. Deterministic and total. */
export function project(events: readonly LaneEvent[]): LaneState {
  return events.reduce(reduce, initialLaneState());
}

/**
 * A stable fingerprint of the *durable* lane identity — the fields a reconnecting
 * process must recover exactly. Volatile counters (reconnects) are excluded so
 * that "same lane, observed again" fingerprints equal across processes.
 */
export function durableFingerprint(state: LaneState): string {
  const durable = {
    laneId: state.laneId,
    phase: state.phase,
    adapter: state.adapter,
    profile: state.profile,
    strongIsolation: state.strongIsolation,
    boundary: state.boundary,
    planId: state.planId,
    workspaceHandle: state.workspaceHandle,
    privateClone: state.privateClone,
    hostRepositoryWritable: state.hostRepositoryWritable,
    sandboxId: state.sandboxId,
    invocation: state.invocation,
    endpoint: state.endpoint,
    receipt: { ownedResourceIds: [...state.receipt.ownedResourceIds].sort() },
    readinessEvidence: state.readinessEvidence,
    failure: state.failure,
  };
  return JSON.stringify(durable);
}

function addOnce(list: readonly string[], value: string): string[] {
  return list.includes(value) ? [...list] : [...list, value];
}
