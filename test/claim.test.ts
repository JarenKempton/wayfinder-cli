import { describe, expect, test } from "bun:test";
import type { ReclaimRequest, ReleaseClaimRequest } from "../src/contracts.ts";
import {
  type ActorRef,
  type Claim,
  claimEventRequiresComment,
  claimStatusAt,
  type Run,
  type RunRef,
  stopRun,
  type TicketRef,
  type TrackerSnapshot,
} from "../src/domain.ts";

const originalSnapshot: TrackerSnapshot = {
  version: "before-claim",
  payload: { assignee: null, status: "To Do", claim: null },
};

const claim: Claim = {
  ref: "wayfinder-claim:first",
  ticket: "jira:x:W:ticket:A" as TicketRef,
  humanOwner: "jaren" as ActorRef,
  run: "wayfinder-run:first",
  previousState: originalSnapshot,
  claimedAt: "2026-08-10T12:00:00.000Z",
  leaseExpiresAt: "2026-08-10T12:15:00.000Z",
  status: "active",
};

describe("claim semantics", () => {
  test("lease expiry derives stale status without mutating the claim", () => {
    expect(claimStatusAt(claim, new Date("2026-08-10T12:14:59.999Z"))).toBe("active");
    expect(claimStatusAt(claim, new Date("2026-08-10T12:15:00.000Z"))).toBe("stale");
    expect(claim.status).toBe("active");
    expect(String(claim.humanOwner)).toBe("jaren");
  });

  test("reclaim contract requires authorization, expected state, and original snapshot", () => {
    const request: ReclaimRequest = {
      staleClaim: claim.ref,
      claim: "wayfinder-claim:second",
      run: "wayfinder-run:second",
      ticket: claim.ticket,
      owner: "new-owner" as ActorRef,
      authorizedBy: "operator" as ActorRef,
      leaseExpiresAt: "2026-08-10T12:30:00.000Z",
      expectedVersion: "stale-version",
      originalSnapshot: claim.previousState,
    };
    expect(String(request.authorizedBy)).toBe("operator");
    expect(request.staleClaim).toBe("wayfinder-claim:first");
    expect(request.originalSnapshot).toBe(originalSnapshot);
  });

  test("release contract restores the original snapshot under an expected version", () => {
    const request: ReleaseClaimRequest = {
      claim: claim.ref,
      ticket: claim.ticket,
      claimedOwner: claim.humanOwner,
      originalSnapshot: claim.previousState,
      expectedVersion: "claimed-version",
      authorizedBy: "operator" as ActorRef,
    };
    expect(request.originalSnapshot.payload).toEqual({
      assignee: null,
      status: "To Do",
      claim: null,
    });
  });

  test("stop changes only run execution fields", () => {
    const run: Run = {
      ref: "wayfinder-run:first" as RunRef,
      ticket: claim.ticket,
      harness: "codex" as Run["harness"],
      workspace: { path: "/work", branch: "decision/A" },
      capabilities: {},
      status: "active",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    const stopped = stopRun(run, new Date("2026-08-10T12:05:00.000Z"));
    expect(stopped).toEqual({
      ...run,
      status: "stopped",
      updatedAt: "2026-08-10T12:05:00.000Z",
    });
    expect(stopped.workspace).toBe(run.workspace);
  });

  test("heartbeats are metadata-only while lifecycle boundaries require comments", () => {
    expect(claimEventRequiresComment("renewed")).toBeFalse();
    for (const event of ["claimed", "reclaimed", "released", "recovery_required"] as const) {
      expect(claimEventRequiresComment(event)).toBeTrue();
    }
  });
});
