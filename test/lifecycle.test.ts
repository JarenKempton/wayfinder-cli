import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
  TrackerAdapter,
} from "../src/contracts.ts";
import type {
  Claim,
  Run,
  RunObservation,
  Ticket,
  TicketRef,
  TrackerSnapshot,
} from "../src/domain.ts";
import { capabilities } from "../src/domain.ts";
import { LifecycleCoordinator, Supervisor } from "../src/lifecycle.ts";
import { StateStore } from "../src/state.ts";

class Tracker implements TrackerAdapter {
  renewError?: Error;
  releaseError?: Error;
  renewed?: RenewLeaseRequest;
  released?: ReleaseClaimRequest;
  async describe() {
    return capabilities("lease_metadata");
  }
  async preflight() {}
  async getTicket(): Promise<Ticket> {
    throw new Error("unused");
  }
  async snapshotClaimState(_ticket: TicketRef): Promise<TrackerSnapshot> {
    return { version: "3", payload: {} };
  }
  async claim(_request: ClaimRequest) {}
  async verifyClaim(_request: ClaimRequest) {}
  async restoreClaimState(_request: RestoreClaimRequest) {}
  async verifyRestored(_request: RestoreClaimRequest) {}
  async renewLease(request: RenewLeaseRequest) {
    this.renewed = request;
    if (this.renewError) throw this.renewError;
  }
  async verifyLease(_request: RenewLeaseRequest) {}
  async releaseClaim(request: ReleaseClaimRequest) {
    this.released = request;
    if (this.releaseError) throw this.releaseError;
  }
  async verifyReleased(_request: ReleaseClaimRequest) {}
  async reclaim(_request: ReclaimRequest) {}
  async verifyReclaimed(_request: ReclaimRequest) {}
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-lifecycle-"));
  const store = new StateStore(join(directory, "state.db"));
  const run: Run = {
    ref: "wayfinder-run:test",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "fake" as Run["harness"],
    workspace: { path: "/kept" },
    capabilities: capabilities("session_status", "session_interrupt"),
    status: "active",
    createdAt: "2026-08-10T12:00:00.000Z",
    updatedAt: "2026-08-10T12:00:00.000Z",
    execution: { sessionId: "session", tier: "managed" },
  };
  const claim: Claim = {
    ref: "wayfinder-claim:test",
    ticket: run.ticket,
    humanOwner: "human" as Claim["humanOwner"],
    run: run.ref,
    previousState: { version: "1", payload: { status: "To Do" } },
    claimedAt: run.createdAt,
    leaseExpiresAt: "2026-08-10T12:15:00.000Z",
    status: "active",
    currentVersion: "2",
  };
  store.saveRun(run);
  store.saveClaim(claim);
  const cleanup = () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { store, run, claim, cleanup };
}

describe("run lifecycle", () => {
  test("supervisor observes a running session and renews a verified lease", async () => {
    const item = fixture();
    const tracker = new Tracker();
    try {
      const supervisor = new Supervisor({
        store: item.store,
        tracker,
        lifecycle: () => ({
          observe: async (): Promise<RunObservation> => ({
            state: "running",
            observedAt: "2026-08-10T12:05:00.000Z",
          }),
          stop: async () => {},
        }),
        clock: { now: () => new Date("2026-08-10T12:05:00.000Z") },
      });
      expect(await supervisor.tick()).toEqual([{ run: item.run.ref, outcome: "renewed" }]);
      expect(tracker.renewed?.expectedVersion).toBe("2");
      expect(item.store.claim(item.claim.ref)).toMatchObject({
        leaseExpiresAt: "2026-08-10T12:20:00.000Z",
        currentVersion: "3",
      });
    } finally {
      item.cleanup();
    }
  });

  test("missing session requires attention and never renews or releases", async () => {
    const item = fixture();
    const tracker = new Tracker();
    try {
      const supervisor = new Supervisor({
        store: item.store,
        tracker,
        lifecycle: () => ({
          observe: async () => ({ state: "missing", observedAt: "2026-08-10T12:05:00.000Z" }),
          stop: async () => {},
        }),
        clock: { now: () => new Date("2026-08-10T12:05:00.000Z") },
      });
      await supervisor.tick();
      expect(item.store.run(item.run.ref).status).toBe("attention_required");
      expect(tracker.renewed).toBeUndefined();
      expect(item.store.claim(item.claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("a live per-user supervisor lease rejects a competing supervisor", async () => {
    const item = fixture();
    const tracker = new Tracker();
    try {
      expect(
        item.store.acquireSupervisor(
          "other-process",
          "2026-08-10T12:05:00.000Z",
          "2026-08-10T12:06:00.000Z",
        ),
      ).toBeTrue();
      const supervisor = new Supervisor({
        store: item.store,
        tracker,
        lifecycle: () => ({
          observe: async () => ({ state: "running", observedAt: "2026-08-10T12:05:30.000Z" }),
          stop: async () => {},
        }),
        clock: { now: () => new Date("2026-08-10T12:05:30.000Z") },
        supervisorId: "this-process",
      });
      await expect(supervisor.tick()).rejects.toThrow("Another per-user supervisor");
      expect(tracker.renewed).toBeUndefined();
    } finally {
      item.cleanup();
    }
  });

  test("stop preserves workspace and claim while a failed stop requires recovery", async () => {
    const item = fixture();
    const tracker = new Tracker();
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        tracker,
        () => ({
          observe: async () => ({ state: "running", observedAt: "" }),
          stop: async () => {},
        }),
        { now: () => new Date("2026-08-10T12:06:00.000Z") },
      );
      const stopped = await coordinator.stop(item.run.ref);
      expect(stopped).toMatchObject({ status: "stopped", workspace: { path: "/kept" } });
      expect(item.store.claim(item.claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("release is explicit, guarded, and verified", async () => {
    const item = fixture();
    const tracker = new Tracker();
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        tracker,
        () => ({
          observe: async () => ({ state: "unknown", observedAt: "" }),
          stop: async () => {},
        }),
        { now: () => new Date("2026-08-10T12:06:00.000Z") },
      );
      await coordinator.release(item.claim.ref, "human" as Claim["humanOwner"]);
      expect(tracker.released?.expectedVersion).toBe("2");
      expect(item.store.claim(item.claim.ref).status).toBe("released");
    } finally {
      item.cleanup();
    }
  });

  test("recovery remains required until supplied evidence is explicitly verified", () => {
    const item = fixture();
    try {
      const failed = item.store.run(item.run.ref);
      failed.status = "recovery_required";
      item.store.saveRun(failed);
      const coordinator = new LifecycleCoordinator(
        item.store,
        new Tracker(),
        () => ({
          observe: async () => ({ state: "unknown", observedAt: "" }),
          stop: async () => {},
        }),
        { now: () => new Date("2026-08-10T12:07:00.000Z") },
      );
      expect(coordinator.recover(item.run.ref, false, { checked: "tracker" }).status).toBe(
        "recovery_required",
      );
      expect(
        coordinator.recover(item.run.ref, true, { checked: "tracker and session" }).status,
      ).toBe("stopped");
      expect(item.store.recoveryEvidence(item.run.ref)).toHaveLength(2);
    } finally {
      item.cleanup();
    }
  });
});
