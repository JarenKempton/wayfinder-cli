export type TrackerRef = string & { readonly __kind: "TrackerRef" };
export type WorkspaceRef = string & { readonly __kind: "WorkspaceRef" };
export type GroupRef = string & { readonly __kind: "GroupRef" };
export type MapRef = string & { readonly __kind: "MapRef" };
export type TicketRef = string & { readonly __kind: "TicketRef" };
export type RunRef = `wayfinder-run:${string}`;
export type ClaimRef = `wayfinder-claim:${string}`;
export type ActorRef = string & { readonly __kind: "ActorRef" };
export type AdapterRef = string & { readonly __kind: "AdapterRef" };

export type Capability =
  | "native_maps"
  | "native_groups"
  | "native_dependencies"
  | "cross_map_dependencies"
  | "atomic_assignment"
  | "workflow_transition"
  | "conditional_update"
  | "native_properties"
  | "claim_comments"
  | "lease_metadata"
  | "resolution_comments"
  | "artifact_links"
  | "prompt_generation"
  | "workspace_open"
  | "process_launch"
  | "session_create"
  | "session_resume"
  | "session_status"
  | "session_interrupt"
  | "session_close"
  | "model_selection"
  | "reasoning_selection"
  | "tool_configuration"
  | "visible_multi_session"
  | "workspace_prepare";

export type CapabilitySet = Partial<Record<Capability, true>>;

export function capabilities(...values: Capability[]): CapabilitySet {
  return Object.fromEntries(values.map((value) => [value, true])) as CapabilitySet;
}

export function missingCapabilities(
  available: CapabilitySet,
  required: CapabilitySet,
): Capability[] {
  return (Object.keys(required) as Capability[]).filter((item) => !available[item]);
}

export interface RepositorySpec {
  name: string;
  remote: string;
  path: string;
  worktreeRoot: string;
  baseBranch: string;
}

export type PolicySet = Record<string, unknown>;

export interface NativeReference {
  id: string;
  url?: string;
}

export interface Workspace {
  ref: WorkspaceRef;
  tracker: TrackerRef;
  repository?: RepositorySpec;
  policies?: PolicySet;
  capabilities: CapabilitySet;
}

export interface WorkGroup {
  ref: GroupRef;
  parent?: GroupRef;
  maps: MapRef[];
  native: NativeReference;
}

export interface WayfinderMap {
  ref: MapRef;
  group?: GroupRef;
  tickets: TicketRef[];
  order: number;
  native: NativeReference;
}

export type TicketKind = "task" | "research" | "prototype" | "decision";
export type TicketState = "open" | "closed";
export type DependencyKind = "blocks";

export interface Dependency {
  blocking: TicketRef;
  blocked: TicketRef;
  kind: DependencyKind;
}

export interface Ticket {
  ref: TicketRef;
  map: MapRef;
  group?: GroupRef;
  kind: TicketKind;
  state: TicketState;
  status: string;
  assignee?: ActorRef;
  dependencies?: Dependency[];
  order: number;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface TrackerSnapshot {
  version: string;
  payload: unknown;
}

export type ClaimStatus = "active" | "stale" | "released" | "superseded";

export interface Claim {
  ref: ClaimRef;
  ticket: TicketRef;
  humanOwner: ActorRef;
  run: RunRef;
  previousState: TrackerSnapshot;
  claimedAt: string;
  leaseExpiresAt: string;
  status: ClaimStatus;
  supersedes?: ClaimRef;
  supersededBy?: ClaimRef;
}

/** Lease expiry is observational: it never mutates assignment or claim ownership. */
export function claimStatusAt(claim: Claim, at: Date): ClaimStatus {
  if (claim.status !== "active") return claim.status;
  return at.getTime() >= Date.parse(claim.leaseExpiresAt) ? "stale" : "active";
}

export type ClaimLifecycleEvent =
  | "claimed"
  | "renewed"
  | "reclaimed"
  | "released"
  | "recovery_required";

/** Heartbeats remain machine-readable metadata; lifecycle boundaries are human-visible. */
export function claimEventRequiresComment(event: ClaimLifecycleEvent): boolean {
  return event !== "renewed";
}

export type RunStatus =
  | "planning"
  | "active"
  | "stopped"
  | "attention_required"
  | "recovery_required";

export interface PreparedWorkspace {
  path: string;
  branch?: string;
}

export interface Run {
  ref: RunRef;
  ticket: TicketRef;
  harness: AdapterRef;
  model?: string;
  workspace: PreparedWorkspace;
  capabilities: CapabilitySet;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
}

/** Stopping execution preserves workspace and claim/tracker ownership outside the run record. */
export function stopRun(run: Run, stoppedAt: Date): Run {
  return { ...run, status: "stopped", updatedAt: stoppedAt.toISOString() };
}
