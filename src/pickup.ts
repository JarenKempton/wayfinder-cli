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
import { capabilities, type PreparedWorkspace, type Run, type RunRef } from "./domain.ts";

export type PickupState =
  | "planning"
  | "claimed"
  | "workspace_prepared"
  | "launched"
  | "committed"
  | "compensating"
  | "compensated"
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
    await this.#options.tracker.claim(claimRequest);
    try {
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
    if (receipt.launch?.sessionId !== undefined || receipt.launch?.pid !== undefined) {
      try {
        await this.#options.harness.stop(receipt.launch);
      } catch {
        // Tracker restoration remains mandatory even if stopping a partial session fails.
      }
    }
    try {
      await this.#options.tracker.restoreClaimState(receipt.ticket, snapshot);
      await this.#options.tracker.verifyRestored(receipt.ticket, snapshot);
      receipt.state = "compensated";
      await this.#options.ledger.recordStep(receipt.run, "compensated", receipt, cause);
      throw new PickupResultError(receipt, cause);
    } catch (restorationError) {
      if (restorationError instanceof PickupResultError) throw restorationError;
      receipt.state = "recovery_required";
      receipt.recoveryCommand = `nav recover ${receipt.run}`;
      const combined = new AggregateError(
        [cause, restorationError],
        "Pickup and restoration failed",
      );
      await this.#options.ledger.recordStep(receipt.run, "recovery_required", receipt, combined);
      throw new PickupResultError(receipt, combined);
    }
  }
}

function message(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
