import { describe, expect, test } from "bun:test";
import type {
  ClaimRequest,
  HarnessAdapter,
  LaunchReceipt,
  Ledger,
  TrackerAdapter,
  WorkspaceAdapter,
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

class FakeLedger implements Ledger {
  readonly steps: string[] = [];
  saveRun(_run: Run): void {}
  recordStep(_run: RunRef, state: string): void {
    this.steps.push(state);
  }
}

class FakeTracker implements TrackerAdapter {
  restored = false;
  verifyRestoreError?: Error;
  async describe() {
    return capabilities("conditional_update");
  }
  async preflight(_ticket: TicketRef) {}
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
    return { version: "1", payload: {} };
  }
  async claim(_request: ClaimRequest) {}
  async verifyClaim(_request: ClaimRequest) {}
  async restoreClaimState(_ticket: TicketRef, _snapshot: TrackerSnapshot) {
    this.restored = true;
  }
  async verifyRestored(_ticket: TicketRef, _snapshot: TrackerSnapshot) {
    if (this.verifyRestoreError) throw this.verifyRestoreError;
  }
  async renewLease(_claim: ClaimRef, _expiresAt: string) {}
  async releaseClaim(_claim: ClaimRef) {}
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
  stopped = false;
  async describe() {
    return capabilities("process_launch");
  }
  async preflight() {}
  async launch(): Promise<LaunchReceipt> {
    if (this.launchError) throw this.launchError;
    return { sessionId: "s", tier: "launch" };
  }
  async stop() {
    this.stopped = true;
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
  return {
    tracker,
    workspace,
    harness,
    coordinator: new PickupCoordinator({
      tracker,
      workspace,
      harness,
      ledger: new FakeLedger(),
      ids: { run: () => "nav-run:test" as RunRef, claim: () => "nav-claim:test" as ClaimRef },
      clock: { now: () => new Date("2026-08-10T12:00:00Z") },
    }),
  };
}

describe("pickup coordinator", () => {
  test("commits a verified pickup", async () => {
    const { coordinator: subject } = coordinator();
    expect(await subject.execute(request)).toMatchObject({ ok: true, state: "committed" });
  });

  test("workspace failure compensates", async () => {
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const { coordinator: subject, tracker } = coordinator(new FakeTracker(), workspace);
    try {
      await subject.execute(request);
      throw new Error("Expected pickup to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PickupResultError);
      expect((error as PickupResultError).receipt.state).toBe("compensated");
      expect(tracker.restored).toBeTrue();
    }
  });

  test("ambiguous restoration requires recovery", async () => {
    const tracker = new FakeTracker();
    tracker.verifyRestoreError = new Error("cannot verify");
    const workspace = new FakeWorkspace();
    workspace.prepareError = new Error("prepare failed");
    const { coordinator: subject } = coordinator(tracker, workspace);
    try {
      await subject.execute(request);
      throw new Error("Expected pickup to fail");
    } catch (error) {
      const result = error as PickupResultError;
      expect(result.receipt.state).toBe("recovery_required");
      expect(result.receipt.recoveryCommand).toBe("nav recover nav-run:test");
    }
  });

  test("launch failure restores the tracker claim", async () => {
    const harness = new FakeHarness();
    harness.launchError = new Error("launch failed");
    const { coordinator: subject, tracker } = coordinator(
      new FakeTracker(),
      new FakeWorkspace(),
      harness,
    );
    await expect(subject.execute(request)).rejects.toBeInstanceOf(PickupResultError);
    expect(tracker.restored).toBeTrue();
  });
});
