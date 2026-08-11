import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run as runCli } from "../src/cli.ts";
import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
  RunLifecycleAdapter,
  TrackerAdapter,
} from "../src/contracts.ts";
import type { Claim, Run, Ticket, TicketRef, TrackerSnapshot } from "../src/domain.ts";
import { capabilities } from "../src/domain.ts";
import { LifecycleCoordinator, Supervisor } from "../src/lifecycle.ts";
import { ProcessLifecycleAdapter } from "../src/platform/process-lifecycle.ts";
import { StateStore } from "../src/state.ts";

class Tracker implements TrackerAdapter {
  renewError?: Error;
  verifyRenewError?: Error;
  releaseError?: Error;
  verifyReleaseError?: Error;
  renewed: RenewLeaseRequest[] = [];
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
    this.renewed.push(request);
    if (this.renewError) throw this.renewError;
  }
  async verifyLease(_request: RenewLeaseRequest) {
    if (this.verifyRenewError) throw this.verifyRenewError;
  }
  async releaseClaim(request: ReleaseClaimRequest) {
    this.released = request;
    if (this.releaseError) throw this.releaseError;
  }
  async verifyReleased(_request: ReleaseClaimRequest) {
    if (this.verifyReleaseError) throw this.verifyReleaseError;
  }
  async reclaim(_request: ReclaimRequest) {}
  async verifyReclaimed(_request: ReclaimRequest) {}
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-lifecycle-"));
  const store = new StateStore(join(directory, "state.db"));
  const makeRun = (id: string): Run => ({
    ref: `wayfinder-run:${id}`,
    ticket: `jira:x:W:ticket:${id}` as Run["ticket"],
    harness: "fake" as Run["harness"],
    workspace: { path: `/kept/${id}` },
    capabilities: capabilities("session_status", "session_interrupt"),
    status: "active",
    createdAt: `2026-08-10T12:00:0${id === "a" ? "0" : "1"}.000Z`,
    updatedAt: "2026-08-10T12:00:00.000Z",
    execution: { sessionId: `session-${id}`, tier: "managed" },
  });
  const add = (id: string, claimStatus: Claim["status"] = "active") => {
    const run = makeRun(id);
    const claim: Claim = {
      ref: `wayfinder-claim:${id}`,
      ticket: run.ticket,
      humanOwner: "human" as Claim["humanOwner"],
      run: run.ref,
      previousState: { version: "1", payload: { status: "To Do" } },
      claimedAt: run.createdAt,
      leaseExpiresAt: "2026-08-10T12:15:00.000Z",
      status: claimStatus,
      currentVersion: "2",
    };
    store.saveRun(run);
    store.saveClaim(claim);
    return { run, claim };
  };
  const addRunOnly = (id: string) => {
    const run = makeRun(id);
    store.saveRun(run);
    return { run };
  };
  const cleanup = () => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return { store, add, addRunOnly, cleanup };
}

function lifecycle(overrides: Partial<RunLifecycleAdapter> = {}): RunLifecycleAdapter {
  return {
    capabilities: capabilities("session_status", "session_interrupt"),
    observe: async () => ({ state: "running", observedAt: "2026-08-10T12:05:00.000Z" }),
    stop: async () => {},
    ...overrides,
  };
}

function supervisor(
  store: StateStore,
  tracker: Tracker,
  select: (run: Run) => RunLifecycleAdapter = () => lifecycle(),
  extra = {},
) {
  return new Supervisor({
    store,
    tracker,
    lifecycle: select,
    clock: { now: () => new Date("2026-08-10T12:05:00.000Z") },
    supervisorId: "test-supervisor",
    ...extra,
  });
}

describe("supervisor", () => {
  test("renews only an active run with an active claim", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    try {
      expect(await supervisor(item.store, tracker).tick()).toEqual([
        { run: run.ref, outcome: "renewed" },
      ]);
      expect(item.store.claim(claim.ref)).toMatchObject({ currentVersion: "3" });
    } finally {
      item.cleanup();
    }
  });

  test("released or superseded claims are never renewed", async () => {
    const item = fixture();
    const released = item.add("a", "released");
    const superseded = item.add("b", "superseded");
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker).tick();
      expect(tracker.renewed).toEqual([]);
      expect(item.store.run(released.run.ref).status).toBe("attention_required");
      expect(item.store.run(superseded.run.ref).status).toBe("attention_required");
    } finally {
      item.cleanup();
    }
  });

  test("observe failure for run A is isolated while run B renews", async () => {
    const item = fixture();
    const a = item.add("a");
    const b = item.add("b");
    const tracker = new Tracker();
    try {
      const result = await supervisor(item.store, tracker, (run) =>
        run.ref === a.run.ref
          ? lifecycle({
              observe: async () => {
                throw new Error("observe failed");
              },
            })
          : lifecycle(),
      ).tick();
      expect(result).toEqual([
        { run: a.run.ref, outcome: "attention_required" },
        { run: b.run.ref, outcome: "renewed" },
      ]);
      expect(tracker.renewed.map((request) => request.claim)).toEqual([b.claim.ref]);
    } finally {
      item.cleanup();
    }
  });

  test("active run without a claim is isolated and marked for attention", async () => {
    const item = fixture();
    const a = item.addRunOnly("a");
    const b = item.add("b");
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker).tick();
      expect(item.store.run(a.run.ref).status).toBe("attention_required");
      expect(tracker.renewed.map((request) => request.claim)).toEqual([b.claim.ref]);
    } finally {
      item.cleanup();
    }
  });

  test("PID-only identity mismatch never renews an unrelated process", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.execution = { pid: process.pid, processIdentity: "different-process", tier: "launch" };
    item.store.saveRun(run);
    const tracker = new Tracker();
    try {
      await supervisor(item.store, tracker, () => new ProcessLifecycleAdapter()).tick();
      expect(tracker.renewed).toEqual([]);
      expect(item.store.run(run.ref).status).toBe("attention_required");
    } finally {
      item.cleanup();
    }
  });

  test("lock releases after success and isolated failure", async () => {
    const item = fixture();
    item.add("a");
    try {
      await supervisor(item.store, new Tracker()).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
      const run = item.store.run("wayfinder-run:a");
      run.status = "active";
      item.store.saveRun(run);
      await supervisor(item.store, new Tracker(), () =>
        lifecycle({
          observe: async () => {
            throw new Error("bad");
          },
        }),
      ).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
    } finally {
      item.cleanup();
    }
  });

  test("heartbeat prevents a long tick from overlapping", async () => {
    const item = fixture();
    item.add("a");
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const first = supervisor(
        item.store,
        new Tracker(),
        () =>
          lifecycle({
            observe: async () => {
              await blocked;
              return { state: "running", observedAt: new Date().toISOString() };
            },
          }),
        { supervisorId: "first", supervisorLockMs: 30 },
      ).tick();
      await Bun.sleep(55);
      await expect(
        supervisor(item.store, new Tracker(), () => lifecycle(), {
          supervisorId: "second",
          supervisorLockMs: 30,
        }).tick(),
      ).rejects.toThrow("Another per-user supervisor");
      finish();
      await first;
      expect(item.store.supervisorStatus()).toBeUndefined();
    } finally {
      finish?.();
      item.cleanup();
    }
  });

  test("renew failure is isolated and an ambiguous crash window reconciles on restart", async () => {
    const item = fixture();
    const a = item.add("a");
    const failing = new Tracker();
    failing.renewError = new Error("renew failed");
    failing.verifyRenewError = new Error("not applied");
    try {
      await supervisor(item.store, failing).tick();
      expect(item.store.run(a.run.ref).status).toBe("attention_required");

      const reset = item.store.run(a.run.ref);
      reset.status = "active";
      item.store.saveRun(reset);
      const applied = new Tracker();
      await supervisor(item.store, applied, () => lifecycle(), {
        afterRenewVerified: () => {
          throw new Error("simulated process crash");
        },
      }).tick();
      expect(item.store.supervisorStatus()).toBeUndefined();
      expect(item.store.pendingRenewals()).toHaveLength(1);
      expect((await supervisor(item.store, new Tracker()).tick())[0]?.outcome).toBe(
        "renewal_reconciled",
      );
      expect(item.store.pendingRenewals()).toHaveLength(0);
      expect(item.store.run(a.run.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });
});

describe("lifecycle coordinator", () => {
  test("missing managed adapter fails before mutation", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        new Tracker(),
        () => {
          throw new Error("adapter missing");
        },
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("adapter missing");
      expect(item.store.run(run.ref)).toEqual(run);
    } finally {
      item.cleanup();
    }
  });

  test("bare PID identity never observes, signals, or mutates a run", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.execution = { pid: process.pid, tier: "launch" };
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        undefined,
        () => new ProcessLifecycleAdapter(),
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("Unsupported capabilities");
      expect(item.store.run(run.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("stop is recorded only after observed termination", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const good = new LifecycleCoordinator(
        item.store,
        undefined,
        () => lifecycle({ observe: async () => ({ state: "stopped", observedAt: "now" }) }),
        { now: () => new Date("2026-08-10T12:06:00Z") },
      );
      expect((await good.stop(run.ref)).status).toBe("stopped");
    } finally {
      item.cleanup();
    }
  });

  test("failed stop remains non-stopped and requires recovery", async () => {
    const item = fixture();
    const { run } = item.add("a");
    try {
      const coordinator = new LifecycleCoordinator(
        item.store,
        undefined,
        () => lifecycle({ observe: async () => ({ state: "running", observedAt: "now" }) }),
        { now: () => new Date() },
      );
      await expect(coordinator.stop(run.ref)).rejects.toThrow("Stop could not be verified");
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.run(run.ref).status).not.toBe("stopped");
    } finally {
      item.cleanup();
    }
  });

  test("failed release is persisted as recovery required", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    tracker.releaseError = new Error("release failed");
    try {
      const coordinator = new LifecycleCoordinator(item.store, tracker, () => lifecycle(), {
        now: () => new Date(),
      });
      await expect(coordinator.release(claim.ref, claim.humanOwner)).rejects.toThrow(
        "release failed",
      );
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.claim(claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("failed release verification preserves the active claim", async () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    const tracker = new Tracker();
    tracker.verifyReleaseError = new Error("release verification failed");
    try {
      const coordinator = new LifecycleCoordinator(item.store, tracker, () => lifecycle(), {
        now: () => new Date(),
      });
      await expect(coordinator.release(claim.ref, claim.humanOwner)).rejects.toThrow(
        "release verification failed",
      );
      expect(item.store.run(run.ref).status).toBe("recovery_required");
      expect(item.store.claim(claim.ref).status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("attention has an explicit verified reconciliation path", () => {
    const item = fixture();
    const { run, claim } = item.add("a");
    run.status = "attention_required";
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(item.store, new Tracker(), () => lifecycle(), {
        now: () => new Date(),
      });
      const result = coordinator.reconcileAttention(
        run.ref,
        { state: "running", observedAt: "verified" },
        claim,
      );
      expect(result.status).toBe("active");
    } finally {
      item.cleanup();
    }
  });

  test("failed recovery verification is recorded and never resolves the run", async () => {
    const item = fixture();
    const { run } = item.add("a");
    run.status = "recovery_required";
    item.store.saveRun(run);
    try {
      const coordinator = new LifecycleCoordinator(item.store, new Tracker(), () => lifecycle(), {
        now: () => new Date(),
      });
      const result = await coordinator.recover(run.ref, { checked: "tracker" }, async () => ({
        verified: false,
        evidence: { mismatch: true },
      }));
      expect(result.status).toBe("recovery_required");
      expect(item.store.recoveryEvidence(run.ref)).toHaveLength(1);
    } finally {
      item.cleanup();
    }
  });

  test("CLI does not treat a bare verified flag as recovery proof", async () => {
    const directory = mkdtempSync(join(tmpdir(), "wayfinder-cli-recovery-"));
    const statePath = join(directory, "state.db");
    const store = new StateStore(statePath);
    const run: Run = {
      ref: "wayfinder-run:cli",
      ticket: "jira:x:W:ticket:CLI" as Run["ticket"],
      harness: "fake" as Run["harness"],
      workspace: { path: "/kept" },
      capabilities: capabilities(),
      status: "recovery_required",
      createdAt: "2026-08-10T12:00:00.000Z",
      updatedAt: "2026-08-10T12:00:00.000Z",
    };
    store.saveRun(run);
    store.close();
    try {
      await runCli(["recover", run.ref, "--verified", "--evidence", "{}"], () => {}, { statePath });
      const reopened = new StateStore(statePath);
      expect(reopened.run(run.ref).status).toBe("recovery_required");
      expect(reopened.recoveryEvidence(run.ref)).toHaveLength(1);
      reopened.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
