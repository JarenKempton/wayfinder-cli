import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type HarnessAdapter,
  type LaunchReceipt,
  type Ledger,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
  type TrackerAdapter,
  type WorkspaceAdapter,
} from "../src/contracts.ts";
import {
  type ActorRef,
  type AdapterRef,
  type ClaimRef,
  capabilities,
  type MapRef,
  type Run,
  type RunRef,
  type Ticket,
  type TicketKind,
  type TicketRef,
  type TrackerSnapshot,
} from "../src/domain.ts";
import { evaluateFrontier } from "../src/frontier.ts";
import { PickupCoordinator, PickupResultError, type PickupState } from "../src/pickup.ts";

const fixtureRoot = join(import.meta.dir, "fixtures", "compatibility");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
}

interface TicketFixture {
  ref: string;
  map: string;
  kind: TicketKind;
  state: Ticket["state"];
  status: string;
  assignee?: string;
  order: number;
  blockedBy?: string;
}

function ticketFromFixture(value: TicketFixture): Ticket {
  const ref = value.ref as TicketRef;
  return {
    ref,
    map: value.map as MapRef,
    kind: value.kind,
    state: value.state,
    status: value.status,
    ...(value.assignee ? { assignee: value.assignee as ActorRef } : {}),
    ...(value.blockedBy
      ? {
          dependencies: [
            {
              blocking: value.blockedBy as TicketRef,
              blocked: ref,
              kind: "blocks" as const,
            },
          ],
        }
      : {}),
    order: value.order,
  };
}

interface PickupFixture {
  ticket: TicketFixture;
  request: { owner: string; harness: string };
  snapshot: TrackerSnapshot;
  workspacePlan: { path: string; branch: string };
  clock: string;
  expected: {
    state: PickupState;
    humanOwner: string;
    expectedVersion: string;
    leaseExpiresAt: string;
    workspace: { path: string; branch: string };
    steps: string[];
  };
}

class FixtureLedger implements Ledger {
  readonly steps: string[] = [];
  readonly runs: Run[] = [];

  saveRun(run: Run): void {
    this.runs.push(structuredClone(run));
  }

  recordStep(_run: RunRef, state: string): void {
    this.steps.push(state);
  }
}

class FixtureTracker implements TrackerAdapter {
  claimError?: Error;
  verifyRestoreError?: Error;
  claimRequest?: ClaimRequest;
  restoreRequest?: RestoreClaimRequest;
  restoreCalls = 0;

  constructor(
    readonly ticket: Ticket,
    readonly snapshot: TrackerSnapshot,
  ) {}

  async describe() {
    return capabilities("conditional_update");
  }
  async preflight(_ticket: TicketRef) {}
  async getTicket(_ticket: TicketRef): Promise<Ticket> {
    return this.ticket;
  }
  async snapshotClaimState(_ticket: TicketRef): Promise<TrackerSnapshot> {
    return this.snapshot;
  }
  async claim(request: ClaimRequest) {
    this.claimRequest = request;
    if (this.claimError) throw this.claimError;
  }
  async verifyClaim(_request: ClaimRequest) {}
  async restoreClaimState(request: RestoreClaimRequest) {
    this.restoreCalls += 1;
    this.restoreRequest = request;
  }
  async verifyRestored(_request: RestoreClaimRequest) {
    if (this.verifyRestoreError) throw this.verifyRestoreError;
  }
  async renewLease(_request: RenewLeaseRequest) {}
  async verifyLease(_request: RenewLeaseRequest) {}
  async releaseClaim(_request: ReleaseClaimRequest) {}
  async verifyReleased(_request: ReleaseClaimRequest) {}
  async reclaim(_request: ReclaimRequest) {}
  async verifyReclaimed(_request: ReclaimRequest) {}
}

class FixtureWorkspace implements WorkspaceAdapter {
  prepareError?: Error;
  prepareCalls = 0;
  preflightTicket?: Ticket;

  constructor(readonly planResult: { ticket: TicketRef; path: string; branch: string }) {}

  async preflight(ticket: Ticket) {
    this.preflightTicket = ticket;
  }
  async plan(_ticket: Ticket) {
    return this.planResult;
  }
  async prepare(plan: { ticket: TicketRef; path: string; branch: string }) {
    this.prepareCalls += 1;
    if (this.prepareError) throw this.prepareError;
    return { path: plan.path, branch: plan.branch };
  }
}

class FixtureHarness implements HarnessAdapter {
  launchError?: Error;
  launchCalls = 0;

  async describe() {
    return capabilities("process_launch");
  }
  async preflight() {}
  async launch(): Promise<LaunchReceipt> {
    this.launchCalls += 1;
    if (this.launchError) throw this.launchError;
    return { sessionId: "fixture-session", tier: "launch" };
  }
  async stop() {}
}

function pickupSubject(value: PickupFixture) {
  const ticket = ticketFromFixture(value.ticket);
  const tracker = new FixtureTracker(ticket, value.snapshot);
  const workspace = new FixtureWorkspace({
    ticket: ticket.ref,
    path: value.workspacePlan.path,
    branch: value.workspacePlan.branch,
  });
  const harness = new FixtureHarness();
  const ledger = new FixtureLedger();
  const coordinator = new PickupCoordinator({
    tracker,
    workspace,
    harness,
    ledger,
    ids: {
      run: () => "wayfinder-run:fixture" as RunRef,
      claim: () => "wayfinder-claim:fixture" as ClaimRef,
    },
    clock: { now: () => new Date(value.clock) },
  });
  const request = {
    ticket: ticket.ref,
    owner: value.request.owner as ActorRef,
    harness: value.request.harness as AdapterRef,
  };
  return { coordinator, tracker, workspace, harness, ledger, request };
}

async function pickupFailure(
  subject: ReturnType<typeof pickupSubject>,
): Promise<PickupResultError> {
  try {
    await subject.coordinator.execute(subject.request);
    throw new Error("Expected pickup fixture to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PickupResultError);
    return error as PickupResultError;
  }
}

describe("compatibility fixtures exercise production behavior", () => {
  test("frontier fixture is evaluated and ordered by evaluateFrontier", () => {
    const value = fixture<{
      scope: string;
      availableStatuses: string[];
      tickets: TicketFixture[];
      expectedRefs: string[];
    }>("frontier.json");
    const tickets = value.tickets.map(ticketFromFixture);

    const result = evaluateFrontier(
      tickets,
      { map: value.scope as MapRef },
      {
        availableStatuses: new Set(value.availableStatuses),
      },
    );

    expect(result.map((ticket) => String(ticket.ref))).toEqual(value.expectedRefs);
  });

  test("pickup fixture drives PickupCoordinator and asserts every expected field", async () => {
    const value = fixture<PickupFixture>("pickup.json");
    const subject = pickupSubject(value);

    const result = await subject.coordinator.execute(subject.request);

    expect(result.state).toBe(value.expected.state);
    expect(result.workspace).toEqual(value.expected.workspace);
    expect(subject.tracker.claimRequest).toMatchObject({
      owner: value.expected.humanOwner,
      expectedVersion: value.expected.expectedVersion,
      leaseExpiresAt: value.expected.leaseExpiresAt,
    });
    expect(subject.workspace.preflightTicket).toEqual(ticketFromFixture(value.ticket));
    expect(subject.workspace.planResult).toEqual({
      ticket: value.ticket.ref as TicketRef,
      path: value.workspacePlan.path,
      branch: value.workspacePlan.branch,
    });
    expect(subject.ledger.steps).toEqual(value.expected.steps);
    expect(subject.ledger.runs.at(-1)).toMatchObject({
      ticket: value.ticket.ref,
      harness: value.request.harness,
      workspace: value.expected.workspace,
      status: "active",
    });
  });

  test("failure fixtures drive coordinator compensation paths", async () => {
    const pickup = fixture<PickupFixture>("pickup.json");
    const value = fixture<{
      cases: Array<{
        name: string;
        failure: {
          phase: "claim" | "workspace_prepare" | "harness_launch";
          error: "claim_collision" | "ambiguous_tracker_result" | "error";
          restorationError?: "ambiguous_tracker_result";
        };
        expected: {
          state: PickupState;
          restoreCalls: number;
          restoresOriginalSnapshot?: boolean;
          workspacePrepareCalls?: number;
          harnessLaunchCalls?: number;
        };
      }>;
    }>("errors.json");

    for (const scenario of value.cases) {
      const subject = pickupSubject(pickup);
      const error =
        scenario.failure.error === "claim_collision"
          ? new ClaimCollisionError()
          : scenario.failure.error === "ambiguous_tracker_result"
            ? new AmbiguousTrackerResultError()
            : new Error(`${scenario.failure.phase} failed`);
      if (scenario.failure.phase === "claim") subject.tracker.claimError = error;
      if (scenario.failure.phase === "workspace_prepare") subject.workspace.prepareError = error;
      if (scenario.failure.phase === "harness_launch") subject.harness.launchError = error;
      if (scenario.failure.restorationError === "ambiguous_tracker_result") {
        subject.tracker.verifyRestoreError = new AmbiguousTrackerResultError();
      }

      const result = await pickupFailure(subject);

      expect(result.receipt.state, scenario.name).toBe(scenario.expected.state);
      expect(subject.tracker.restoreCalls, scenario.name).toBe(scenario.expected.restoreCalls);
      if (scenario.expected.restoresOriginalSnapshot !== undefined) {
        expect(
          subject.tracker.restoreRequest?.originalSnapshot === pickup.snapshot,
          scenario.name,
        ).toBe(scenario.expected.restoresOriginalSnapshot);
      }
      if (scenario.expected.workspacePrepareCalls !== undefined) {
        expect(subject.workspace.prepareCalls, scenario.name).toBe(
          scenario.expected.workspacePrepareCalls,
        );
      }
      if (scenario.expected.harnessLaunchCalls !== undefined) {
        expect(subject.harness.launchCalls, scenario.name).toBe(
          scenario.expected.harnessLaunchCalls,
        );
      }
    }
  });
});
