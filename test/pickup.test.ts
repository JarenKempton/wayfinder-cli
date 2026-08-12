import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type HarnessAdapter,
  HarnessLaunchError,
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
  type ClaimRef,
  capabilities,
  type Run,
  type RunRef,
  type Ticket,
  type TicketRef,
  type TrackerSnapshot,
} from "../src/domain.ts";
import { PickupCoordinator, PickupResultError } from "../src/pickup.ts";
import { StateStore } from "../src/state.ts";

class FailingCompensatedStateStore extends StateStore {
  readonly compensatedStepError = new Error("cannot persist compensated step");

  override recordStep(run: RunRef, state: string, receipt?: unknown, error?: unknown): void {
    if (state === "compensated") throw this.compensatedStepError;
    super.recordStep(run, state, receipt, error);
  }
}

class FakeLedger implements Ledger {
  readonly steps: string[] = [];
  recordStepError?: Error;
  recordStepErrorState?: string;
  saveRecoveryRequiredError?: Error;
  saveClaim(_claim: import("../src/domain.ts").Claim): void {}
  commitClaim(_claim: import("../src/domain.ts").Claim): void {
    this.steps.push("claimed");
  }
  recoveryRun?: Run;
  savedRun?: Run;
  saveRun(run: Run): void {
    this.savedRun = structuredClone(run);
  }
  commitRun(run: Run, state: string): void {
    this.savedRun = structuredClone(run);
    this.steps.push(state);
  }
  recordStep(_run: RunRef, state: string): void {
    if (state === this.recordStepErrorState && this.recordStepError) {
      throw this.recordStepError;
    }
    this.steps.push(state);
  }
  saveRecoveryRequired(run: Run): void {
    if (this.saveRecoveryRequiredError) throw this.saveRecoveryRequiredError;
    this.recoveryRun = structuredClone(run);
    this.steps.push("recovery_required");
  }
}

class FakeTracker implements TrackerAdapter {
  describedCapabilities = capabilities(
    "atomic_assignment",
    "conditional_update",
    "claim_comments",
    "claim_identity",
    "lease_metadata",
  );
  claimError?: Error;
  preflightError?: Error;
  restoreError?: Error;
  verifyClaimError?: Error;
  verifyRestoreError?: Error;
  claimRequest?: ClaimRequest;
  restoreRequest?: RestoreClaimRequest;
  claimCalls = 0;
  restoreCalls = 0;
  snapshotCalls = 0;

  async describe() {
    return this.describedCapabilities;
  }
  async preflight(_ticket: TicketRef) {
    if (this.preflightError) throw this.preflightError;
  }
  async getTicket(ticket: TicketRef): Promise<Ticket> {
    return {
      ref: ticket,
      map: "jira:x:W:map:M" as Ticket["map"],
      kind: "task",
      state: "open",
      status: "To Do",
      order: 0,
    };
  }
  async snapshotClaimState(_ticket: TicketRef): Promise<TrackerSnapshot> {
    this.snapshotCalls += 1;
    return { version: "1", payload: { assignee: null, status: "To Do" } };
  }
  async claim(request: ClaimRequest) {
    this.claimCalls += 1;
    this.claimRequest = request;
    if (this.claimError) throw this.claimError;
  }
  async verifyClaim(_request: ClaimRequest) {
    if (this.verifyClaimError) throw this.verifyClaimError;
  }
  async restoreClaimState(request: RestoreClaimRequest) {
    this.restoreCalls += 1;
    this.restoreRequest = request;
    if (this.restoreError) throw this.restoreError;
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

class FakeWorkspace implements WorkspaceAdapter {
  prepareError?: Error;
  async preflight(_ticket: Ticket) {}
  async plan(ticket: Ticket) {
    return { ticket: ticket.ref, path: "/work", branch: "task/A" };
  }
  async prepare() {
    if (this.prepareError) throw this.prepareError;
    return { path: "/work", branch: "task/A" };
  }
}

class FakeHarness implements HarnessAdapter {
  launchError?: Error;
  stopError?: Error;
  stopped = false;
  describedCapabilities = capabilities("process_launch");
  preflightRequest?: Parameters<HarnessAdapter["preflight"]>[0];
  launchRequest?: Parameters<HarnessAdapter["launch"]>[0];
  async describe() {
    return this.describedCapabilities;
  }
  async preflight(request: Parameters<HarnessAdapter["preflight"]>[0]) {
    this.preflightRequest = request;
  }
  async launch(request: Parameters<HarnessAdapter["launch"]>[0]): Promise<LaunchReceipt> {
    this.launchRequest = request;
    if (this.launchError) throw this.launchError;
    return { sessionId: "s", tier: "launch" };
  }
  async stop() {
    this.stopped = true;
    if (this.stopError) throw this.stopError;
  }
}

const request = {
  ticket: "jira:x:W:ticket:A" as TicketRef,
  owner: "human" as ActorRef,
  harness: "codex" as Run["harness"],
};

function coordinator(
  tracker = new FakeTracker(),
  workspace = new FakeWorkspace(),
  harness = new FakeHarness(),
) {
  const ledger = new FakeLedger();
  return {
    tracker,
    workspace,
    harness,
    ledger,
    coordinator: new PickupCoordinator({
      tracker,
      workspace,
      harness,
      ledger,
      ids: {
        run: () => "wayfinder-run:test" as RunRef,
        claim: () => "wayfinder-claim:test" as ClaimRef,
      },
      clock: { now: () => new Date("2026-08-10T12:00:00Z") },
    }),
  };
}

async function failure(subject: PickupCoordinator): Promise<PickupResultError> {
  try {
    await subject.execute(request);
    throw new Error("Expected pickup to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(PickupResultError);
    return error as PickupResultError;
  }
}

describe("pickup coordinator", () => {
  test("commits a verified pickup with a default 15-minute lease", async () => {
    const { coordinator: subject, tracker, ledger } = coordinator();
    expect(await subject.execute(request)).toMatchObject({ ok: true, state: "committed" });
    expect(tracker.claimRequest?.leaseExpiresAt).toBe("2026-08-10T12:15:00.000Z");
    expect(ledger.steps).toEqual([
      "planning",
      "claiming",
      "claimed",
      "workspace_prepared",
      "launched",
      "committed",
    ]);
  });

  test("preflight failure performs no tracker mutation", async () => {
    const tracker = new FakeTracker();
    tracker.preflightError = new Error("unsupported");
    const { coordinator: subject } = coordinator(tracker);
    await expect(subject.execute(request)).rejects.toThrow("unsupported");
    expect(tracker.claimCalls).toBe(0);
    expect(tracker.restoreCalls).toBe(0);
  });

  test("hosted-style weak tracker capabilities fail before snapshot or mutation", async () => {
    const tracker = new FakeTracker();
    tracker.describedCapabilities = capabilities("native_maps", "native_dependencies");
    const { coordinator: subject } = coordinator(tracker);
    await expect(subject.execute(request)).rejects.toThrow(
      "Unsupported capabilities: atomic_assignment, conditional_update, claim_comments, claim_identity, lease_metadata",
    );
    expect(tracker.snapshotCalls).toBe(0);
    expect(tracker.claimCalls).toBe(0);
  });

  test("requested routing capabilities are rejected before claim", async () => {
    const harness = new FakeHarness();
    harness.describedCapabilities = capabilities("process_launch", "model_selection");
    const {
      coordinator: subject,
      tracker,
      workspace,
    } = coordinator(new FakeTracker(), new FakeWorkspace(), harness);
    await expect(
      subject.execute({
        ...request,
        model: "gpt",
        effort: "high",
        context: "repo",
        requiredCapabilities: capabilities("session_resume"),
      }),
    ).rejects.toThrow(
      "Unsupported capabilities: session_resume, reasoning_selection, context_selection",
    );
    expect(tracker.claimCalls).toBe(0);
    expect(workspace).toBeDefined();
    expect(harness.preflightRequest).toBeUndefined();
  });

  test("validated routing settings reach preflight, launch, and the run ledger", async () => {
    const harness = new FakeHarness();
    harness.describedCapabilities = capabilities(
      "process_launch",
      "model_selection",
      "reasoning_selection",
      "context_selection",
    );
    const { coordinator: subject, ledger } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    await subject.execute({
      ...request,
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(harness.preflightRequest).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(harness.launchRequest).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
    });
    expect(ledger.savedRun).toMatchObject({
      model: "gpt",
      effort: "high",
      context: "repo",
      capabilities: harness.describedCapabilities,
      status: "active",
    });
  });

  test("definite claim collision does not compensate", async () => {
    const tracker = new FakeTracker();
    tracker.claimError = new ClaimCollisionError();
    const { coordinator: subject, ledger } = coordinator(tracker);
    expect((await failure(subject)).receipt.state).toBe("collision");
    expect(tracker.restoreCalls).toBe(0);
    expect(ledger.steps).toEqual(["planning", "claiming", "collision"]);
  });

  test("ambiguous claim failure compensates the exact snapshot", async () => {
    const tracker = new FakeTracker();
    tracker.claimError = new AmbiguousTrackerResultError();
    const { coordinator: subject } = coordinator(tracker);
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreRequest).toEqual({
      ticket: request.ticket,
      claim: "wayfinder-claim:test",
      claimedOwner: request.owner,
      originalSnapshot: { version: "1", payload: { assignee: null, status: "To Do" } },
    });
  });

  test("post-mutation claim verification collision compensates", async () => {
    const tracker = new FakeTracker();
    tracker.verifyClaimError = new ClaimCollisionError("claim changed before verification");
    const { coordinator: subject } = coordinator(tracker);
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("workspace failure compensates", async () => {
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const { coordinator: subject, tracker } = coordinator(new FakeTracker(), workspace);
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("ledger failure while entering compensation does not strand the tracker claim", async () => {
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(new FakeTracker(), workspace);
    item.ledger.recordStepErrorState = "compensating";
    item.ledger.recordStepError = new Error("ledger unavailable");

    const result = await failure(item.coordinator);

    expect(item.tracker.restoreCalls).toBe(1);
    expect(result.receipt.state).toBe("recovery_required");
    expect(item.ledger.recoveryRun?.status).toBe("recovery_required");
  });

  test("final compensated-step persistence failure is durably recovery-required", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wayfinder-test-"));
    const store = new FailingCompensatedStateStore(join(directory, "wayfinder.db"));
    const tracker = new FakeTracker();
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const subject = new PickupCoordinator({
      tracker,
      workspace,
      harness: new FakeHarness(),
      ledger: store,
      ids: {
        run: () => "wayfinder-run:test" as RunRef,
        claim: () => "wayfinder-claim:test" as ClaimRef,
      },
      clock: { now: () => new Date("2026-08-10T12:00:00Z") },
    });

    try {
      const result = await failure(subject);

      expect(tracker.restoreCalls).toBe(1);
      expect(result.receipt).toMatchObject({
        state: "recovery_required",
        recoveryCommand: `wayfinder recover wayfinder-run:test --evidence '{"tracker":"verify","session":"verify"}'`,
      });
      expect(result.cause).toBeInstanceOf(AggregateError);
      const error = result.cause as AggregateError;
      expect(error.message).toBe("Pickup compensation could not be fully verified");
      expect(error.errors).toEqual([workspace.prepareError, store.compensatedStepError]);
      expect(store.run("wayfinder-run:test" as RunRef).status).toBe("recovery_required");
      expect(store.claim("wayfinder-claim:test" as ClaimRef).status).toBe("active");
      expect(store.steps("wayfinder-run:test" as RunRef).at(-1)).toMatchObject({
        state: "recovery_required",
        error_text: "Pickup compensation could not be fully verified",
      });
      expect(store.recoveryEvidence("wayfinder-run:test" as RunRef)).toEqual([
        expect.objectContaining({
          outcome: "verification_required",
          evidence_json: JSON.stringify({
            command: `wayfinder recover wayfinder-run:test --evidence '{"tracker":"verify","session":"verify"}'`,
            tracker: "restored_verified",
            session: "not_started",
            ledger: "compensated_step_persistence_failed",
          }),
        }),
      ]);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("restoration verification failure requires recovery", async () => {
    const tracker = new FakeTracker();
    tracker.verifyRestoreError = new Error("cannot verify");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(tracker, workspace);
    const result = await failure(item.coordinator);
    expect(result.receipt.state).toBe("recovery_required");
    expect(result.receipt.recoveryCommand).toBe(
      `wayfinder recover wayfinder-run:test --evidence '{"tracker":"verify","session":"verify"}'`,
    );
    expect(item.ledger.recoveryRun?.status).toBe("recovery_required");
  });

  test("recovery ledger failure remains explicit after best-effort remote compensation", async () => {
    const tracker = new FakeTracker();
    tracker.verifyRestoreError = new Error("cannot verify restoration");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const item = coordinator(tracker, workspace);
    const ledgerError = new Error("recovery ledger unavailable");
    item.ledger.saveRecoveryRequiredError = ledgerError;

    const result = await failure(item.coordinator);

    expect(item.tracker.restoreCalls).toBe(1);
    expect(result.receipt.state).toBe("recovery_required");
    expect(result.cause).toBeInstanceOf(AggregateError);
    const outer = result.cause as AggregateError;
    expect(outer.message).toBe(
      "Pickup requires recovery and its recovery ledger could not be persisted",
    );
    expect(outer.errors).toHaveLength(2);
    expect(outer.errors[0]).toBeInstanceOf(AggregateError);
    expect((outer.errors[0] as AggregateError).message).toBe(
      "Pickup compensation could not be fully verified",
    );
    expect((outer.errors[0] as AggregateError).errors).toEqual([
      workspace.prepareError,
      tracker.verifyRestoreError,
    ]);
    expect(outer.errors[1]).toBe(ledgerError);
  });

  test("concurrent change during restoration requires recovery", async () => {
    const tracker = new FakeTracker();
    tracker.restoreError = new ClaimCollisionError("human changed the ticket");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    expect((await failure(coordinator(tracker, workspace).coordinator)).receipt.state).toBe(
      "recovery_required",
    );
  });

  test("launch failure restores the tracker claim", async () => {
    const harness = new FakeHarness();
    harness.launchError = new Error("launch failed");
    const { coordinator: subject, tracker } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    expect((await failure(subject)).receipt.state).toBe("compensated");
    expect(tracker.restoreCalls).toBe(1);
  });

  test("uncertain partial launch stop still restores tracker and requires recovery", async () => {
    const harness = new FakeHarness();
    harness.launchError = new HarnessLaunchError("launch response lost", {
      sessionId: "partial",
      tier: "launch",
    });
    harness.stopError = new Error("cannot verify stop");
    const { coordinator: subject, tracker } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    expect((await failure(subject)).receipt.state).toBe("recovery_required");
    expect(harness.stopped).toBeTrue();
    expect(tracker.restoreCalls).toBe(1);
  });
});
