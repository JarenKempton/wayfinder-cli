import type {
  ActorRef,
  AdapterRef,
  CapabilitySet,
  ClaimRef,
  EnvironmentPlan,
  EnvironmentProfileRef,
  EnvironmentStartAuthorization,
  PreparedEnvironment,
  PreparedWorkspace,
  Run,
  RunObservation,
  RunRef,
  Ticket,
  TicketRef,
  TrackerSnapshot,
} from "./domain.ts";

export interface ClaimRequest {
  claim: ClaimRef;
  run: RunRef;
  ticket: TicketRef;
  owner: ActorRef;
  leaseExpiresAt: string;
  expectedVersion: string;
}

export interface RenewLeaseRequest {
  claim: ClaimRef;
  ticket: TicketRef;
  leaseExpiresAt: string;
  expectedVersion: string;
}

export interface ReleaseClaimRequest {
  claim: ClaimRef;
  ticket: TicketRef;
  /** Persisted owner installed by the claim; required by guarded release implementations. */
  claimedOwner?: ActorRef;
  originalSnapshot: TrackerSnapshot;
  expectedVersion: string;
  authorizedBy: ActorRef;
}

export interface ReclaimRequest {
  staleClaim: ClaimRef;
  claim: ClaimRef;
  run: RunRef;
  ticket: TicketRef;
  owner: ActorRef;
  authorizedBy: ActorRef;
  leaseExpiresAt: string;
  expectedVersion: string;
  originalSnapshot: TrackerSnapshot;
}

export interface RestoreClaimRequest {
  ticket: TicketRef;
  claim: ClaimRef;
  /** Persisted owner installed by the claim; required for restart-safe restoration. */
  claimedOwner?: ActorRef;
  originalSnapshot: TrackerSnapshot;
}

export class ClaimCollisionError extends Error {
  readonly code = "claim_collision";

  constructor(message = "Claim state changed concurrently") {
    super(message);
    this.name = "ClaimCollisionError";
  }
}

export class AmbiguousTrackerResultError extends Error {
  readonly code = "ambiguous_tracker_result";

  constructor(message = "Tracker mutation result is ambiguous") {
    super(message);
    this.name = "AmbiguousTrackerResultError";
  }
}

export interface TrackerAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(ticket: TicketRef): Promise<void>;
  getTicket(ticket: TicketRef): Promise<Ticket>;
  snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot>;
  claim(request: ClaimRequest): Promise<void>;
  verifyClaim(request: ClaimRequest): Promise<void>;
  restoreClaimState(request: RestoreClaimRequest): Promise<void>;
  verifyRestored(request: RestoreClaimRequest): Promise<void>;
  renewLease(request: RenewLeaseRequest): Promise<void>;
  verifyLease(request: RenewLeaseRequest): Promise<void>;
  releaseClaim(request: ReleaseClaimRequest): Promise<void>;
  verifyReleased(request: ReleaseClaimRequest): Promise<void>;
  reclaim(request: ReclaimRequest): Promise<void>;
  verifyReclaimed(request: ReclaimRequest): Promise<void>;
}

/** Optional read surface implemented by adapters that can hydrate a complete map frontier. */
export interface FrontierTrackerAdapter extends TrackerAdapter {
  listMapTickets(map: import("./domain.ts").MapRef): Promise<Ticket[]>;
}

export interface WorkspacePlan {
  ticket: TicketRef;
  path: string;
  branch: string;
}

export interface WorkspaceAdapter {
  preflight(ticket: Ticket): Promise<void>;
  plan(ticket: Ticket): Promise<WorkspacePlan>;
  prepare(plan: WorkspacePlan): Promise<PreparedWorkspace>;
}

export interface EnvironmentPlanRequest {
  ticket: Ticket;
  workspaces: Record<string, PreparedWorkspace>;
  profile: EnvironmentProfileRef;
}

export interface EnvironmentStartRequest {
  plan: EnvironmentPlan;
  authorization: EnvironmentStartAuthorization;
}

/** Application-specific lifecycle boundary, whether embedded or external. */
export interface EnvironmentAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(request: EnvironmentPlanRequest): Promise<void>;
  plan(request: EnvironmentPlanRequest): Promise<EnvironmentPlan>;
  start(request: EnvironmentStartRequest): Promise<PreparedEnvironment>;
  verifyReady(environment: PreparedEnvironment): Promise<void>;
  logs(environment: PreparedEnvironment): Promise<string[]>;
  resume(id: string): Promise<PreparedEnvironment>;
  stop(environment: PreparedEnvironment): Promise<void>;
}

export interface LaunchRequest {
  run: RunRef;
  ticket: Ticket;
  workspace: PreparedWorkspace;
  model?: string;
  effort?: string;
  context?: string;
}

export interface LaunchReceipt {
  sessionId?: string;
  pid?: number;
  tier: "prepare" | "launch" | "managed" | "lifecycle";
}

export class HarnessLaunchError extends Error {
  constructor(
    message: string,
    readonly receipt?: LaunchReceipt,
  ) {
    super(message);
    this.name = "HarnessLaunchError";
  }
}

/**
 * A portable, host-agnostic description of how to invoke and steer an agent.
 * It carries no process, no session, and no assumption about where it runs, so
 * a host, container, or remote runtime can execute the identical invocation.
 */
export interface AgentInvocation {
  /** The agent/harness label that produced this invocation. */
  agent: string;
  /** The argument vector to execute. Always an array, never shell text. */
  argv: readonly string[];
  /** The workspace path in the executing runtime's own frame of reference. */
  cwd: string;
}

/**
 * The agent-provider contract. It negotiates capabilities and describes how to
 * invoke and steer an agent; it never spawns a host process. Where and how the
 * invocation executes is the {@link AgentRuntime}'s concern, keeping
 * agent-provider concerns separate from session-host concerns.
 */
export interface AgentAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(request: LaunchRequest): Promise<void>;
  invoke(request: LaunchRequest): Promise<AgentInvocation>;
}

/**
 * The session-host/execution contract. It owns where and how an invocation
 * executes and how the resulting session is stopped. `host` is the first
 * concrete runtime; isolated container or remote runtimes are peers that
 * execute the same portable {@link AgentInvocation}.
 */
export interface AgentRuntime {
  describe(): Promise<CapabilitySet>;
  execute(invocation: AgentInvocation): Promise<LaunchReceipt>;
  stop(receipt: LaunchReceipt): Promise<void>;
}

/**
 * v1 host-bound convenience: an {@link AgentAdapter} pre-composed with a host
 * {@link AgentRuntime} so `launch` both describes an invocation and executes it
 * on the host. New code should prefer the {@link AgentAdapter} +
 * {@link AgentRuntime} seam so the same invocation can run on isolated runtimes.
 */
export interface HarnessAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(request: LaunchRequest): Promise<void>;
  launch(request: LaunchRequest): Promise<LaunchReceipt>;
  stop(receipt: LaunchReceipt): Promise<void>;
}

export interface Ledger {
  saveRun(run: Run): void | Promise<void>;
  saveClaim(claim: import("./domain.ts").Claim): void | Promise<void>;
  commitClaim(claim: import("./domain.ts").Claim, receipt: unknown): void | Promise<void>;
  commitRun(run: Run, state: string, receipt: unknown): void | Promise<void>;
  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void | Promise<void>;
  saveRecoveryRequired(
    run: Run,
    receipt: unknown,
    error: unknown,
    evidence: unknown,
  ): void | Promise<void>;
}

/** Harness-specific observation is kept behind this portable lifecycle boundary. */
export interface RunLifecycleAdapter {
  capabilities: CapabilitySet;
  observe(run: Run): Promise<RunObservation>;
  stop(run: Run): Promise<void>;
}

export interface RecoveryVerification {
  verified: boolean;
  evidence: unknown;
  resolvedStatus?: "active" | "stopped";
}

export interface IdFactory {
  run(): RunRef;
  claim(): ClaimRef;
}

export interface Clock {
  now(): Date;
}

export interface PickupRequest {
  ticket: TicketRef;
  owner: ActorRef;
  harness: AdapterRef;
  model?: string;
  effort?: string;
  context?: string;
  requiredCapabilities?: CapabilitySet;
}
