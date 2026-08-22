// PROTOTYPE (JWB-332) — throwaway concrete hosts. Not the keeper.
//
// Two adapters behind ONE boundary (SessionHostAdapter), plus an honest probe
// of the real T3 surface:
//
//   * NativeSessionHost — the must-support baseline. Launches a REAL OS process
//     (argv-only, unref'd so it outlives the launcher) and observes lifecycle
//     from real liveness + real exit codes. It honestly does NOT advertise
//     session_interrupt or visible_multi_session.
//
//   * T3SessionHost — a SIMULATED stable session host. Its durable state lives in
//     the HostRegistry, so a session genuinely survives a control-surface restart:
//     a fresh process reattaches, observes, and steers the SAME session id. This
//     stands in for the API T3 would need to expose to be a Wayfinder session host.
//
//   * probeRealT3Surface() — reports what T3 Code exposes to Wayfinder TODAY
//     (browser-preview automation, `preview_*`), which is NOT session lifecycle.
//     It advertises no lifecycle capability and records the gap (criterion 5).

import { requireCapabilities } from "../../src/domain.ts";
import {
  type AgentInvocation,
  capabilitiesForNative,
  capabilitiesForSimulatedT3,
  type SessionHandle,
  type SessionHostAdapter,
  type SessionHostCandidate,
  type SessionLifecycle,
  steeringCapabilities,
} from "./session-host-protocol.ts";
import type { HostRegistry } from "./session-store.ts";

function now(): string {
  return new Date().toISOString();
}

/** Real-process baseline session host. */
export class NativeSessionHost implements SessionHostAdapter {
  readonly kind = "native" as const;
  readonly #registry: HostRegistry;
  /** Child handles owned by THIS process only — the source of exit disposition. */
  readonly #handles = new Map<string, Bun.Subprocess>();

  constructor(registry: HostRegistry) {
    this.#registry = registry;
  }

  describe() {
    return capabilitiesForNative();
  }

  async create(lane: string, agent: AgentInvocation): Promise<SessionHandle> {
    const child = Bun.spawn([...agent.argv], {
      cwd: agent.cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    // Outlive the launcher: the session must survive the control process exiting.
    child.unref();
    const sessionId = `native:${crypto.randomUUID()}`;
    this.#handles.set(sessionId, child);
    this.#registry.put({
      host: "native",
      sessionId,
      lane,
      pid: child.pid,
      agent,
      lifecycle: "running",
      detail: "launched",
      inbox: [],
      startedAt: now(),
      updatedAt: now(),
    });
    return { host: "native", sessionId, agent };
  }

  /**
   * Await terminal disposition via the launching handle and record it. This is
   * the honest way to observe settled/failed WITHOUT scraping: the exit code is
   * read from the child handle, not from parsed output. Only works in the process
   * that launched the session (see close()/observe() for the cross-process gap).
   */
  async settle(sessionId: string): Promise<SessionLifecycle> {
    const child = this.#handles.get(sessionId);
    if (!child) {
      throw new Error(`native session ${sessionId} has no local handle in this process`);
    }
    const code = await child.exited;
    const lifecycle: SessionLifecycle = code === 0 ? "settled" : "failed";
    this.#registry.setLifecycle("native", sessionId, lifecycle, `exit code ${code}`, now());
    return lifecycle;
  }

  async observe(sessionId: string): Promise<SessionLifecycle> {
    const row = this.#registry.get("native", sessionId);
    if (!row) return "lost";
    // A recorded terminal disposition wins (set by the launcher via settle()).
    if (row.lifecycle === "settled" || row.lifecycle === "failed") return row.lifecycle;
    // Otherwise report liveness of the real OS process via signal 0 — structured,
    // not terminal scraping. A dead pid with no recorded disposition is genuinely
    // "lost": cross-process native observation cannot recover the exit code.
    try {
      process.kill(row.pid, 0);
      return "running";
    } catch {
      return "lost";
    }
  }

  async steer(_sessionId: string, _instruction: string): Promise<void> {
    // Fails closed: the native baseline cannot verify mid-session steering.
    requireCapabilities(this.describe(), steeringCapabilities());
  }

  async reattach(sessionId: string): Promise<SessionHandle | undefined> {
    const row = this.#registry.get("native", sessionId);
    if (!row) return undefined;
    return { host: "native", sessionId, agent: row.agent };
  }

  async close(sessionId: string): Promise<void> {
    const child = this.#handles.get(sessionId);
    if (child) {
      child.kill();
      this.#registry.setLifecycle("native", sessionId, "settled", "closed via handle", now());
      return;
    }
    // Cross-process: we will NOT bare-pid signal a process this control surface
    // did not launch (AGENTS.md). Record the limitation instead of faking a kill.
    this.#registry.setLifecycle(
      "native",
      sessionId,
      "lost",
      "cross-process close needs a host-owned control channel; native ties termination to the launching handle",
      now(),
    );
  }
}

/** Simulated stable T3 session host — durable, re-attachable, steerable. */
export class T3SessionHost implements SessionHostAdapter {
  readonly kind = "t3" as const;
  readonly simulated = true;
  readonly #registry: HostRegistry;

  constructor(registry: HostRegistry) {
    this.#registry = registry;
  }

  describe() {
    return capabilitiesForSimulatedT3();
  }

  async create(lane: string, agent: AgentInvocation): Promise<SessionHandle> {
    const sessionId = `t3:${crypto.randomUUID()}`;
    // pid 0: the session lives on the (simulated) host, not as a local child.
    this.#registry.put({
      host: "t3",
      sessionId,
      lane,
      pid: 0,
      agent,
      lifecycle: "running",
      detail: "hosted",
      inbox: [],
      startedAt: now(),
      updatedAt: now(),
    });
    return { host: "t3", sessionId, agent };
  }

  async observe(sessionId: string): Promise<SessionLifecycle> {
    const row = this.#registry.get("t3", sessionId);
    return row ? row.lifecycle : "lost";
  }

  async steer(sessionId: string, instruction: string): Promise<void> {
    requireCapabilities(this.describe(), steeringCapabilities());
    const row = this.#registry.get("t3", sessionId);
    if (!row) throw new Error(`t3 session ${sessionId} not found`);
    this.#registry.pushInbox("t3", sessionId, instruction, now());
  }

  async reattach(sessionId: string): Promise<SessionHandle | undefined> {
    const row = this.#registry.get("t3", sessionId);
    if (!row) return undefined;
    return { host: "t3", sessionId, agent: row.agent };
  }

  async close(sessionId: string): Promise<void> {
    this.#registry.setLifecycle("t3", sessionId, "settled", "closed", now());
  }

  /** Simulate the host reporting a terminal disposition (settled/failed). */
  settleWith(sessionId: string, lifecycle: SessionLifecycle, detail: string): void {
    this.#registry.setLifecycle("t3", sessionId, lifecycle, detail, now());
  }
}

/**
 * Honest probe of the T3 Code surface Wayfinder can reach today. The tools
 * actually exposed are browser-preview automation (preview_navigate, preview_click,
 * preview_snapshot, ...), NOT session lifecycle. So we advertise NO session
 * lifecycle capability and record the gap, rather than claiming create/observe/
 * steer/resume we cannot verify (JWB-332 acceptance criterion 5).
 */
export function probeRealT3Surface(): SessionHostCandidate {
  return {
    kind: "t3",
    provisioned: true, // T3 is reachable...
    capabilities: {}, // ...but exposes no *verifiable* session lifecycle
    simulated: false,
    note:
      "Observed T3 surface = browser-preview automation (preview_* tools). " +
      "No session_create/session_status/session_interrupt/session_resume advertised; " +
      "lifecycle API unverified/unstable. Not advertising unverified capability.",
  };
}

/** Build the concrete adapters over one registry (same SQLite path). */
export function buildHosts(registry: HostRegistry): {
  native: NativeSessionHost;
  t3: T3SessionHost;
} {
  return { native: new NativeSessionHost(registry), t3: new T3SessionHost(registry) };
}
