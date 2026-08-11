import type {
  ActorRef,
  AdapterRef,
  CapabilitySet,
  ClaimRef,
  PreparedWorkspace,
  Run,
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

export interface TrackerAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(ticket: TicketRef): Promise<void>;
  getTicket(ticket: TicketRef): Promise<Ticket>;
  snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot>;
  claim(request: ClaimRequest): Promise<void>;
  verifyClaim(request: ClaimRequest): Promise<void>;
  restoreClaimState(ticket: TicketRef, snapshot: TrackerSnapshot): Promise<void>;
  verifyRestored(ticket: TicketRef, snapshot: TrackerSnapshot): Promise<void>;
  renewLease(claim: ClaimRef, expiresAt: string): Promise<void>;
  releaseClaim(claim: ClaimRef): Promise<void>;
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

export interface LaunchRequest {
  run: RunRef;
  ticket: Ticket;
  workspace: PreparedWorkspace;
  model?: string;
  effort?: string;
}

export interface LaunchReceipt {
  sessionId?: string;
  pid?: number;
  tier: "prepare" | "launch" | "managed" | "lifecycle";
}

export interface HarnessAdapter {
  describe(): Promise<CapabilitySet>;
  preflight(request: LaunchRequest): Promise<void>;
  launch(request: LaunchRequest): Promise<LaunchReceipt>;
  stop(receipt: LaunchReceipt): Promise<void>;
}

export interface Ledger {
  saveRun(run: Run): void | Promise<void>;
  recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void | Promise<void>;
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
}
