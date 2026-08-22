// PROTOTYPE (JWB-332) — throwaway shell, but THIS module is the keeper.
//
// Question this prototype answers:
//   Can T3 Code act as an *optional* persistent session host for Wayfinder lanes
//   without becoming required, and without conflating the session host with the
//   underlying agent runtime?
//
// The validated design lives here: two distinct seams held apart in the type
// system. The AGENT seam (`AgentInvocation`) is "which coding agent to run" and
// is chosen independently. The SESSION-HOST seam (`SessionHostAdapter`,
// `SessionHostKind`) is "who owns the durable interactive session and how a
// control surface attaches to it". A session host *carries* an agent invocation;
// it never dictates the agent. The durable lane->session mapping is a pure fold
// over a Wayfinder-owned event log, so a restarted control surface recovers it.
//
// This file has NO I/O. It imports the production capability vocabulary from
// src/domain.ts on purpose: the existing session_* capabilities already describe
// a session host, which is the evidence that this lifts cleanly into `src/` as a
// fifth "session-host" adapter seam (today `t3` is miscategorised as a harness).

import type { Capability, CapabilitySet } from "../../src/domain.ts";
import { capabilities, missingCapabilities } from "../../src/domain.ts";

/** Where a durable, re-attachable interactive session actually lives. */
export type SessionHostKind = "native" | "t3";

/**
 * The AGENT seam — portable and independently selectable. A session host runs
 * this; it does not own it. argv-only, never shell text (AGENTS.md).
 */
export interface AgentInvocation {
  /** The underlying agent/provider runtime, e.g. "codex", "claude". */
  agent: string;
  argv: readonly string[];
  cwd: string;
  model?: string;
}

/**
 * Lifecycle observed through a structured status surface — never by scraping
 * terminal output. `lost` means the host can no longer report a disposition.
 */
export type SessionLifecycle = "requested" | "running" | "settled" | "failed" | "lost";

/** The Wayfinder-owned durable channel for the lane<->session mapping. */
export type SessionEventKind =
  | "session.requested" // a lane asks a host to host an agent invocation (genesis)
  | "session.bound" // the host returned a session identity; the mapping is durable
  | "session.observed" // a structured lifecycle observation (not scraped)
  | "session.steered" // a revision/steering instruction delivered to the same session
  | "session.detached" // the control surface disconnected; the session keeps living
  | "session.reattached" // a fresh control process recovered the mapping and re-attached
  | "session.closed"; // the session ended

/** A structured session event. `at` is caller-supplied to keep this module pure. */
export interface SessionEvent {
  kind: SessionEventKind;
  lane: string;
  at: string;
  actor: string;
  host?: SessionHostKind;
  sessionId?: string;
  agent?: AgentInvocation;
  lifecycle?: SessionLifecycle;
  instruction?: string;
  detail?: string;
}

/** Durable projection of one lane's session binding — a pure fold of its log. */
export interface SessionRecord {
  lane: string;
  host: SessionHostKind;
  /** Host-owned session identity. Empty until `session.bound`. */
  sessionId: string;
  agent: AgentInvocation;
  lifecycle: SessionLifecycle;
  /** Monotonic truth version; increments once per applied event. */
  version: number;
  steerings: string[];
  detachments: number;
  reattachments: number;
  createdAt: string;
  updatedAt: string;
  lastEventKind: SessionEventKind;
  detail?: string;
}

export type SessionReductionCode = "already_exists" | "unknown_session" | "malformed_event";

export type SessionReduction =
  | { ok: true; record: SessionRecord }
  | { ok: false; code: SessionReductionCode; reason: string };

/**
 * Pure reducer: apply one session event to the current mapping projection.
 * No I/O, no clock, no globals. `session.requested` is the genesis; every other
 * event requires an existing mapping, so replay is deterministic.
 */
export function applySessionEvent(
  current: SessionRecord | undefined,
  event: SessionEvent,
): SessionReduction {
  if (event.kind === "session.requested") {
    if (current) return deny("already_exists", `lane ${event.lane} already has a session mapping`);
    if (!event.host) return deny("malformed_event", "session.requested requires a host");
    if (!event.agent) return deny("malformed_event", "session.requested requires an agent");
    return { ok: true, record: initialRecord(event, event.host, event.agent) };
  }

  if (!current) return deny("unknown_session", `no session mapping for lane ${event.lane}`);

  const base: SessionRecord = {
    ...current,
    version: current.version + 1,
    updatedAt: event.at,
    lastEventKind: event.kind,
  };

  switch (event.kind) {
    case "session.bound": {
      if (!event.sessionId) return deny("malformed_event", "session.bound requires a sessionId");
      return { ok: true, record: { ...base, sessionId: event.sessionId, lifecycle: "running" } };
    }
    case "session.observed": {
      if (!event.lifecycle) return deny("malformed_event", "session.observed requires a lifecycle");
      return {
        ok: true,
        record: {
          ...base,
          lifecycle: event.lifecycle,
          ...(event.detail ? { detail: event.detail } : {}),
        },
      };
    }
    case "session.steered": {
      if (!event.instruction)
        return deny("malformed_event", "session.steered requires an instruction");
      return {
        ok: true,
        record: { ...base, steerings: [...current.steerings, event.instruction] },
      };
    }
    case "session.detached":
      return { ok: true, record: { ...base, detachments: current.detachments + 1 } };
    case "session.reattached":
      return { ok: true, record: { ...base, reattachments: current.reattachments + 1 } };
    case "session.closed":
      return {
        ok: true,
        record: { ...base, lifecycle: current.lifecycle === "failed" ? "failed" : "settled" },
      };
    default:
      return deny("malformed_event", `unhandled event ${event.kind}`);
  }
}

/**
 * Rebuild a lane's session mapping purely from its durable log. This is what
 * makes a control-surface restart safe: the mapping is a deterministic fold over
 * durable events, not something held in a live process.
 */
export function projectSession(events: SessionEvent[]): SessionRecord | undefined {
  let record: SessionRecord | undefined;
  for (const event of events) {
    const result = applySessionEvent(record, event);
    if (!result.ok) throw new Error(`corrupt session log at ${event.kind}: ${result.reason}`);
    record = result.record;
  }
  return record;
}

// ---------------------------------------------------------------------------
// The session-host adapter boundary (JWB-332 acceptance criterion 2).
// T3-specific behaviour lives entirely behind this interface. The orchestrator
// only ever speaks these methods, so a host is swappable and never special-cased.
// ---------------------------------------------------------------------------

export interface SessionHandle {
  host: SessionHostKind;
  sessionId: string;
  agent: AgentInvocation;
}

export interface SessionHostAdapter {
  readonly kind: SessionHostKind;
  /** Only capabilities this host can actually verify (AGENTS.md: no bluffing). */
  describe(): CapabilitySet;
  create(lane: string, agent: AgentInvocation): Promise<SessionHandle>;
  observe(sessionId: string): Promise<SessionLifecycle>;
  steer(sessionId: string, instruction: string): Promise<void>;
  reattach(sessionId: string): Promise<SessionHandle | undefined>;
  close(sessionId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Optional host selection (criteria 4 & 5). Native is the must-support baseline.
// T3 is preferred-when-verifiable, gated-out-when-not, and fail-closed only when
// explicitly required. Capability claims are never advertised unverified.
// ---------------------------------------------------------------------------

export interface SessionHostCandidate {
  kind: SessionHostKind;
  provisioned: boolean;
  capabilities: CapabilitySet;
  simulated?: boolean;
  /** Recorded unsupported/unstable behaviour — surfaced, not hidden. */
  note?: string;
}

export interface SessionHostRequest {
  preferred?: SessionHostKind;
  /** When true, the preferred host must be usable or selection fails closed. */
  required?: boolean;
  requiredCapabilities: CapabilitySet;
}

export type HostSelection =
  | { ok: true; chosen: SessionHostKind; reason: string; fellBack: boolean }
  | { ok: false; code: "host_unavailable" | "unverified_capability"; reason: string };

const NATIVE_BASELINE: SessionHostKind = "native";

/**
 * Resolve which session host to use. The native baseline always exists, so a
 * missing or under-capable T3 degrades to native rather than blocking the lane —
 * unless T3 was explicitly required, in which case we refuse loudly instead of
 * pretending a capability we cannot verify.
 */
export function selectSessionHost(
  request: SessionHostRequest,
  catalog: readonly SessionHostCandidate[],
): HostSelection {
  const native = catalog.find((c) => c.kind === NATIVE_BASELINE);
  const preferred = request.preferred ?? NATIVE_BASELINE;
  const candidate = catalog.find((c) => c.kind === preferred);

  if (!candidate?.provisioned) {
    if (request.required) {
      return { ok: false, code: "host_unavailable", reason: `${preferred} is not provisioned` };
    }
    return fallBackToNative(native, request, `${preferred} not provisioned`);
  }

  const missing = missingCapabilities(candidate.capabilities, request.requiredCapabilities);
  if (missing.length > 0) {
    const gap = `${preferred} cannot verify ${missing.join(", ")}`;
    if (request.required) {
      return { ok: false, code: "unverified_capability", reason: gap };
    }
    return fallBackToNative(native, request, gap);
  }

  return {
    ok: true,
    chosen: preferred,
    reason:
      preferred === NATIVE_BASELINE
        ? "native baseline"
        : `${preferred} verified all required capabilities`,
    fellBack: false,
  };
}

function fallBackToNative(
  native: SessionHostCandidate | undefined,
  request: SessionHostRequest,
  why: string,
): HostSelection {
  if (!native?.provisioned) {
    return { ok: false, code: "host_unavailable", reason: `${why}; native baseline unavailable` };
  }
  const missing = missingCapabilities(native.capabilities, request.requiredCapabilities);
  if (missing.length > 0) {
    return {
      ok: false,
      code: "unverified_capability",
      reason: `${why}; native baseline also cannot verify ${missing.join(", ")}`,
    };
  }
  return {
    ok: true,
    chosen: NATIVE_BASELINE,
    reason: `${why}; fell back to native`,
    fellBack: true,
  };
}

/** The lifecycle capabilities that steering a session requires. */
export function steeringCapabilities(): CapabilitySet {
  return capabilities("session_interrupt");
}

/**
 * Capabilities the native baseline can actually verify. It launches and observes
 * real processes but deliberately does NOT claim mid-session steering or a
 * visible multi-session surface — those it cannot honour.
 */
export function capabilitiesForNative(): CapabilitySet {
  return capabilities("process_launch", "session_create", "session_status", "session_close");
}

/**
 * Capabilities a stable T3 session host would verify: everything native has,
 * plus resume, mid-session interrupt/steer, and a visible multi-session surface.
 */
export function capabilitiesForSimulatedT3(): CapabilitySet {
  return capabilities(
    "process_launch",
    "session_create",
    "session_status",
    "session_resume",
    "session_interrupt",
    "session_close",
    "visible_multi_session",
  );
}

/** The lifecycle capabilities the shipped CLI needs to launch on a host at all. */
export function launchCapabilities(): CapabilitySet {
  return capabilities("process_launch", "session_create", "session_status");
}

function initialRecord(
  event: SessionEvent,
  host: SessionHostKind,
  agent: AgentInvocation,
): SessionRecord {
  return {
    lane: event.lane,
    host,
    sessionId: event.sessionId ?? "",
    agent,
    lifecycle: "requested",
    version: 1,
    steerings: [],
    detachments: 0,
    reattachments: 0,
    createdAt: event.at,
    updatedAt: event.at,
    lastEventKind: "session.requested",
  };
}

function deny(code: SessionReductionCode, reason: string): SessionReduction {
  return { ok: false, code, reason };
}

/** Convenience for callers assembling required-capability sets. */
export function requiredCapabilitySet(...values: Capability[]): CapabilitySet {
  return capabilities(...values);
}
