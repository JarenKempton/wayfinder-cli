import type {
  Clock,
  HarnessAdapter,
  IdFactory,
  LaunchReceipt,
  Ledger,
  PickupRequest,
  TrackerAdapter,
  WorkspaceAdapter,
} from "./contracts.ts";
import { ClaimCollisionError, HarnessLaunchError } from "./contracts.ts";
import { capabilities, type PreparedWorkspace, type Run, type RunRef } from "./domain.ts";

export type PickupState =
  | "planning"
  | "claiming"
  | "claimed"
  | "workspace_prepared"
  | "launched"
  | "committed"
  | "compensating"
  | "compensated"
  | "collision"
  | "recovery_required";

export interface PickupReceipt {
  ok: boolean;
  state: PickupState;
  run: RunRef;
  claim: ReturnType<IdFactory["claim"]>;
  ticket: PickupRequest["ticket"];
  workspace?: PreparedWorkspace;
  launch?: LaunchReceipt;
  recoveryCommand?: string;
}

export class PickupResultError extends Error {
  constructor(
    readonly receipt: PickupReceipt,
    readonly cause: unknown,
  ) {
    super(`Pickup ended in ${receipt.state}: ${message(cause)}`, { cause });
    this.name = "PickupResultError";
  }
}

export interface PickupCoordinatorOptions {
  tracker: TrackerAdapter;
  workspace: WorkspaceAdapter;
  harness: HarnessAdapter;
  ledger: Ledger;
  ids: IdFactory;
  clock: Clock;
  leaseDurationMs?: number;
}

export class PickupCoordinator {
  readonly #options: PickupCoordinatorOptions;

  constructor(options: PickupCoordinatorOptions) {
    this.#options = options;
  }

  async execute(request: PickupRequest): Promise<PickupReceipt> {
    if (!request.ticket || !request.owner || !request.harness) {
      throw new Error("Ticket, owner, and harness are required");
    }
    const runRef = this.#options.ids.run();
    const claimRef = this.#options.ids.claim();
    const now = this.#options.clock.now();
    const receipt: PickupReceipt = {
      ok: false,
      state: "planning",
      run: runRef,
      claim: claimRef,
      ticket: request.ticket,
    };
    const run: Run = {
      ref: runRef,
      ticket: request.ticket,
      harness: request.harness,
      workspace: { path: "" },
      capabilities: capabilities(),
      status: "planning",
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.#options.ledger.saveRun(run);
    await this.#options.ledger.recordStep(runRef, "planning", receipt);

    const ticket = await this.#options.tracker.getTicket(request.ticket);
    if (ticket.state !== "open" || ticket.assignee !== undefined) {
      throw new Error("Ticket is not claimable");
    }
    await this.#options.tracker.describe();
    await this.#options.tracker.preflight(request.ticket);
    await this.#options.workspace.preflight(ticket);
    const plan = await this.#options.workspace.plan(ticket);
    await this.#options.harness.describe();
    await this.#options.harness.preflight({
      run: runRef,
      ticket,
      workspace: { path: plan.path, branch: plan.branch },
      ...(request.model ? { model: request.model } : {}),
      ...(request.effort ? { effort: request.effort } : {}),
    });

    const snapshot = await this.#options.tracker.snapshotClaimState(request.ticket);
    const claimRequest = {
      claim: claimRef,
      run: runRef,
      ticket: request.ticket,
      owner: request.owner,
      leaseExpiresAt: new Date(
        now.getTime() + (this.#options.leaseDurationMs ?? 900_000),
      ).toISOString(),
      expectedVersion: snapshot.version,
    };
    receipt.state = "claiming";
    await this.#options.ledger.recordStep(runRef, "claiming", receipt);
    try {
      try {
        await this.#options.tracker.claim(claimRequest);
      } catch (error) {
        if (error instanceof ClaimCollisionError) {
          receipt.state = "collision";
          await this.#options.ledger.recordStep(runRef, "collision", receipt, error);
          throw new PickupResultError(receipt, error);
        }
        return this.#compensate(receipt, snapshot, error);
      }
      await this.#options.tracker.verifyClaim(claimRequest);
      receipt.state = "claimed";
      await this.#options.ledger.recordStep(runRef, "claimed", receipt);

      const prepared = await this.#options.workspace.prepare(plan);
      receipt.state = "workspace_prepared";
      receipt.workspace = prepared;
      await this.#options.ledger.recordStep(runRef, "workspace_prepared", receipt);

      const launchRequest = {
        run: runRef,
        ticket,
        workspace: prepared,
        ...(request.model ? { model: request.model } : {}),
        ...(request.effort ? { effort: request.effort } : {}),
      };
      const launch = await this.#options.harness.launch(launchRequest);
      receipt.state = "launched";
      receipt.launch = launch;
      await this.#options.ledger.recordStep(runRef, "launched", receipt);

      run.workspace = prepared;
      run.status = "active";
      run.updatedAt = this.#options.clock.now().toISOString();
      if (request.model) run.model = request.model;
      await this.#options.ledger.saveRun(run);
      receipt.ok = true;
      receipt.state = "committed";
      await this.#options.ledger.recordStep(runRef, "committed", receipt);
      return receipt;
    } catch (error) {
      if (error instanceof PickupResultError) throw error;
      if (error instanceof HarnessLaunchError && error.receipt) {
        receipt.launch = error.receipt;
      }
      return this.#compensate(receipt, snapshot, error);
    }
  }

  async #compensate(
    receipt: PickupReceipt,
    snapshot: Awaited<ReturnType<TrackerAdapter["snapshotClaimState"]>>,
    cause: unknown,
  ): Promise<never> {
    receipt.ok = false;
    receipt.state = "compensating";
    await this.#options.ledger.recordStep(receipt.run, "compensating", receipt, cause);
    const recoveryErrors: unknown[] = [];
    if (receipt.launch?.sessionId !== undefined || receipt.launch?.pid !== undefined) {
      try {
        await this.#options.harness.stop(receipt.launch);
      } catch (error) {
        recoveryErrors.push(error);
      }
    }
    const restoreRequest = {
      ticket: receipt.ticket,
      claim: receipt.claim,
      originalSnapshot: snapshot,
    };
    try {
      await this.#options.tracker.restoreClaimState(restoreRequest);
      await this.#options.tracker.verifyRestored(restoreRequest);
    } catch (error) {
      recoveryErrors.push(error);
    }
    if (recoveryErrors.length === 0) {
      receipt.state = "compensated";
      await this.#options.ledger.recordStep(receipt.run, "compensated", receipt, cause);
      throw new PickupResultError(receipt, cause);
    }
    receipt.state = "recovery_required";
    receipt.recoveryCommand = `wayfinder recover ${receipt.run}`;
    const combined = new AggregateError(
      [cause, ...recoveryErrors],
      "Pickup compensation could not be fully verified",
    );
    await this.#options.ledger.recordStep(receipt.run, "recovery_required", receipt, combined);
    throw new PickupResultError(receipt, combined);
  }
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
