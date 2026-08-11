import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
} from "./contracts.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "./contracts.ts";
import type { ActorRef, TicketRef, TrackerSnapshot } from "./domain.ts";

export interface AssignmentState {
  version: string;
  assignee?: ActorRef;
}

export abstract class AssignmentTrackerAdapter {
  readonly #claimOwners = new Map<string, ActorRef>();
  abstract readAssignment(ticket: TicketRef): Promise<AssignmentState>;
  abstract writeAssignment(ticket: TicketRef, assignee?: ActorRef): Promise<void>;

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const state = await this.readAssignment(ticket);
    return { version: state.version, payload: { assignee: state.assignee ?? null } };
  }

  async claim(request: ClaimRequest): Promise<void> {
    const before = await this.readAssignment(request.ticket);
    if (before.version !== request.expectedVersion || before.assignee !== undefined) {
      throw new ClaimCollisionError();
    }
    this.#claimOwners.set(request.claim, request.owner);
    try {
      await this.writeAssignment(request.ticket, request.owner);
    } catch (error) {
      throw new AmbiguousTrackerResultError(message(error));
    }
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    const after = await this.readAssignment(request.ticket);
    if (after.assignee !== request.owner) {
      throw new ClaimCollisionError("Claim owner changed before verification");
    }
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    const current = await this.readAssignment(request.ticket);
    const original = snapshotAssignee(request.originalSnapshot);
    if (current.assignee === original) return;
    const claimedOwner = this.#claimOwners.get(request.claim);
    if (claimedOwner === undefined || current.assignee !== claimedOwner) {
      throw new ClaimCollisionError("Claim owner changed before restoration");
    }
    try {
      await this.writeAssignment(request.ticket, original);
    } catch (error) {
      throw new AmbiguousTrackerResultError(message(error));
    }
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    const current = await this.readAssignment(request.ticket);
    if (current.assignee !== snapshotAssignee(request.originalSnapshot)) {
      throw new AmbiguousTrackerResultError("Original assignment was not restored");
    }
    this.#claimOwners.delete(request.claim);
  }

  async renewLease(_request: RenewLeaseRequest): Promise<void> {
    throw new Error("Tracker does not expose verified lease metadata");
  }

  async verifyLease(_request: RenewLeaseRequest): Promise<void> {
    throw new Error("Tracker does not expose verified lease metadata");
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.restoreClaimState({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot: request.originalSnapshot,
    });
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.verifyRestored({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot: request.originalSnapshot,
    });
  }

  async reclaim(_request: ReclaimRequest): Promise<void> {
    throw new Error("Tracker does not expose a verified stale-claim identity");
  }

  async verifyReclaimed(_request: ReclaimRequest): Promise<void> {
    throw new Error("Tracker does not expose a verified stale-claim identity");
  }
}

function snapshotAssignee(snapshot: TrackerSnapshot): ActorRef | undefined {
  const payload = snapshot.payload;
  if (typeof payload !== "object" || payload === null || !("assignee" in payload)) {
    throw new Error("Claim snapshot is missing assignee state");
  }
  const assignee = (payload as { assignee: unknown }).assignee;
  if (assignee === null) return undefined;
  if (typeof assignee !== "string") throw new Error("Claim snapshot has an invalid assignee");
  return assignee as ActorRef;
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
