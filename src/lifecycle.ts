import type { Clock, RunLifecycleAdapter, TrackerAdapter } from "./contracts.ts";
import { ClaimCollisionError } from "./contracts.ts";
import type { ActorRef, ClaimRef, Run, RunRef } from "./domain.ts";
import { stopRun } from "./domain.ts";
import type { StateStore } from "./state.ts";

export interface SupervisorOptions {
  store: StateStore;
  tracker: TrackerAdapter;
  lifecycle(run: Run): RunLifecycleAdapter;
  clock: Clock;
  leaseDurationMs?: number;
  supervisorId?: string;
  supervisorLockMs?: number;
}

/** One tick observes every active run and renews only verified, running claims. */
export class Supervisor {
  constructor(private readonly options: SupervisorOptions) {}

  async tick(): Promise<Array<{ run: RunRef; outcome: string }>> {
    const startedAt = this.options.clock.now();
    const owner = this.options.supervisorId ?? `process:${process.pid}`;
    const acquired = this.options.store.acquireSupervisor(
      owner,
      startedAt.toISOString(),
      new Date(startedAt.getTime() + (this.options.supervisorLockMs ?? 60_000)).toISOString(),
    );
    if (!acquired) throw new Error("Another per-user supervisor holds the active lease");
    const results: Array<{ run: RunRef; outcome: string }> = [];
    for (const run of this.options.store.activeRuns()) {
      const observation = await this.options.lifecycle(run).observe(run);
      run.observation = observation;
      run.updatedAt = this.options.clock.now().toISOString();
      if (observation.state !== "running") {
        run.status = "attention_required";
        this.options.store.saveRun(run);
        this.options.store.recordStep(run.ref, "attention_required", observation);
        results.push({ run: run.ref, outcome: "attention_required" });
        continue;
      }

      const claim = this.options.store.claimForRun(run.ref);
      const leaseExpiresAt = new Date(
        this.options.clock.now().getTime() + (this.options.leaseDurationMs ?? 900_000),
      ).toISOString();
      const request = {
        claim: claim.ref,
        ticket: claim.ticket,
        leaseExpiresAt,
        expectedVersion: claim.currentVersion ?? claim.previousState.version,
      };
      try {
        await this.options.tracker.renewLease(request);
        await this.options.tracker.verifyLease(request);
        const verified = await this.options.tracker.snapshotClaimState(claim.ticket);
        claim.leaseExpiresAt = leaseExpiresAt;
        claim.currentVersion = verified.version;
        this.options.store.saveClaim(claim);
        this.options.store.saveRun(run);
        this.options.store.recordStep(run.ref, "renewed", { leaseExpiresAt });
        results.push({ run: run.ref, outcome: "renewed" });
      } catch (error) {
        run.status = "attention_required";
        this.options.store.saveRun(run);
        this.options.store.recordStep(run.ref, "attention_required", observation, error);
        results.push({ run: run.ref, outcome: "attention_required" });
      }
    }
    return results;
  }
}

export class LifecycleCoordinator {
  constructor(
    private readonly store: StateStore,
    private readonly tracker: TrackerAdapter | undefined,
    private readonly lifecycle: (run: Run) => RunLifecycleAdapter,
    private readonly clock: Clock,
  ) {}

  async stop(ref: RunRef): Promise<Run> {
    const run = this.store.run(ref);
    if (run.status === "stopped") return run;
    try {
      await this.lifecycle(run).stop(run);
      const stopped = stopRun(run, this.clock.now());
      this.store.saveRun(stopped);
      this.store.recordStep(ref, "stopped", { execution: run.execution });
      return stopped;
    } catch (error) {
      run.status = "recovery_required";
      run.updatedAt = this.clock.now().toISOString();
      this.store.saveRun(run);
      this.store.recordStep(ref, "recovery_required", { operation: "stop" }, error);
      throw error;
    }
  }

  async release(ref: ClaimRef, authorizedBy: ActorRef): Promise<void> {
    if (!this.tracker) throw new Error("Claim release requires a configured tracker adapter");
    const claim = this.store.claim(ref);
    const request = {
      claim: claim.ref,
      ticket: claim.ticket,
      originalSnapshot: claim.previousState,
      expectedVersion: claim.currentVersion ?? claim.previousState.version,
      authorizedBy,
    };
    try {
      await this.tracker.releaseClaim(request);
      await this.tracker.verifyReleased(request);
      claim.status = "released";
      this.store.saveClaim(claim);
      this.store.recordStep(claim.run, "released", { claim: claim.ref });
    } catch (error) {
      const run = this.store.run(claim.run);
      run.status = "recovery_required";
      run.updatedAt = this.clock.now().toISOString();
      this.store.saveRun(run);
      this.store.recordStep(claim.run, "recovery_required", { operation: "release" }, error);
      throw error;
    }
  }

  /** Recovery never guesses: a caller supplies human-guided verification evidence. */
  recover(ref: RunRef, recovered: boolean, evidence: unknown): Run {
    const run = this.store.run(ref);
    if (run.status !== "recovery_required") {
      throw new Error(`Run is not awaiting recovery: ${ref}`);
    }
    this.store.recordRecovery(ref, recovered ? "recovered" : "still_required", evidence);
    if (recovered) {
      run.status = "stopped";
      run.updatedAt = this.clock.now().toISOString();
      this.store.saveRun(run);
      this.store.recordStep(ref, "recovered", evidence);
    } else {
      this.store.recordStep(ref, "recovery_required", evidence);
    }
    return run;
  }
}

export function isClaimCollision(error: unknown): boolean {
  return error instanceof ClaimCollisionError;
}
