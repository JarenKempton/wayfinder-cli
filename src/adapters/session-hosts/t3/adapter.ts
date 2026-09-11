import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { LaunchReceipt, RunLifecycleAdapter } from "../../../domain/contracts.ts";
import {
  type CapabilitySet,
  capabilities,
  type Run,
  type RunObservation,
  UnsupportedCapabilityError,
} from "../../../domain/model.ts";
import {
  connectT3,
  nonempty,
  object,
  type T3Connection,
  T3Error,
  type T3Runtime,
} from "./connection.ts";

export interface T3ModelSelection {
  instanceId: string;
  model: string;
  options?: Array<{ id: string; value: string | boolean }>;
}

export interface T3SessionIdentity {
  environmentId: string;
  serverVersion: string;
  threadId: string;
  projectId: string;
  workspaceRoot: string;
  worktreePath: string;
  branch: string;
  modelSelection: T3ModelSelection;
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access";
  interactionMode: "default" | "plan";
}

/** Adapter-owned extension; the existing execution_json column retains it unchanged. */
export interface T3Receipt extends LaunchReceipt {
  sessionId: string;
  tier: "managed";
  t3: T3SessionIdentity;
}

export interface T3Observation extends RunObservation {
  recoveryRequired: boolean;
  serverVersion?: string;
  snapshotSequence?: number;
  turnId?: string;
  turnState?: string;
  sessionStatus?: string;
  modelSelection?: T3ModelSelection;
}

export interface T3AdapterOptions {
  connect?: (
    expected?: Pick<T3Runtime, "environmentId" | "serverVersion">,
  ) => Promise<T3Connection>;
  /** Must durably complete before dispatch. Bind to Ledger.recordStep(run, state, evidence). */
  journal: (state: string, evidence: unknown) => Promise<void>;
  attempts?: number;
  pause?: () => Promise<void>;
}

function model(value: unknown): T3ModelSelection {
  const input = object(value);
  const result: T3ModelSelection = {
    instanceId: nonempty(input.instanceId),
    model: nonempty(input.model),
  };
  if (input.options !== undefined) {
    if (!Array.isArray(input.options)) throw new T3Error("invalid_model");
    result.options = input.options.map((value) => {
      const option = object(value);
      const id = nonempty(option.id);
      if (
        typeof option.value !== "boolean" &&
        (typeof option.value !== "string" || !option.value.trim())
      )
        throw new T3Error("invalid_model");
      return { id, value: option.value };
    });
    if (new Set(result.options.map((option) => option.id)).size !== result.options.length)
      throw new T3Error("invalid_model");
  }
  return result;
}

function sameModel(left: T3ModelSelection, right: T3ModelSelection): boolean {
  const options = (selection: T3ModelSelection) =>
    JSON.stringify((selection.options ?? []).toSorted((a, b) => a.id.localeCompare(b.id)));
  return (
    left.instanceId === right.instanceId &&
    left.model === right.model &&
    options(left) === options(right)
  );
}

function identity(value: unknown): T3SessionIdentity {
  const input = object(value);
  const result = {
    environmentId: nonempty(input.environmentId),
    serverVersion: nonempty(input.serverVersion),
    threadId: nonempty(input.threadId),
    projectId: nonempty(input.projectId),
    workspaceRoot: nonempty(input.workspaceRoot),
    worktreePath: nonempty(input.worktreePath),
    branch: nonempty(input.branch),
    modelSelection: model(input.modelSelection),
    runtimeMode: input.runtimeMode,
    interactionMode: input.interactionMode,
  };
  if (
    typeof result.runtimeMode !== "string" ||
    typeof result.interactionMode !== "string" ||
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(
      result.runtimeMode,
    ) ||
    !["default", "plan"].includes(result.interactionMode)
  )
    throw new T3Error("invalid_identity");
  return {
    ...result,
    runtimeMode: z
      .enum(["approval-required", "auto-accept-edits", "auto", "full-access"])
      .parse(result.runtimeMode),
    interactionMode: z.enum(["default", "plan"]).parse(result.interactionMode),
  };
}

function makeReceipt(value: T3SessionIdentity): T3Receipt {
  const t3 = identity(value);
  return {
    sessionId: `t3:${encodeURIComponent(t3.environmentId)}:${encodeURIComponent(t3.threadId)}`,
    tier: "managed",
    t3,
  };
}

export function t3Receipt(value: unknown): T3Receipt {
  const input = object(value);
  const receipt = makeReceipt(identity(input.t3));
  if (input.sessionId !== receipt.sessionId || input.tier !== receipt.tier)
    throw new T3Error("invalid_identity");
  return receipt;
}

interface Snapshot {
  sequence: number;
  projects: Record<string, unknown>[];
  threads: Record<string, unknown>[];
}
function snapshot(value: unknown): Snapshot {
  const input = object(value);
  if (
    !Number.isSafeInteger(input.snapshotSequence) ||
    z.number().parse(input.snapshotSequence) < 0 ||
    !Array.isArray(input.projects) ||
    !Array.isArray(input.threads) ||
    typeof input.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(input.updatedAt))
  )
    throw new T3Error("invalid_snapshot");
  const projects = input.projects.map(object);
  const threads = input.threads.map(object);
  for (const item of [...projects, ...threads]) {
    if (
      item.deletedAt !== null &&
      (typeof item.deletedAt !== "string" || !Number.isFinite(Date.parse(item.deletedAt)))
    )
      throw new T3Error("invalid_snapshot");
  }
  for (const project of projects) nonempty(project.workspaceRoot);
  for (const thread of threads) {
    nonempty(thread.projectId);
    for (const field of [thread.branch, thread.worktreePath]) {
      if (field !== null && (typeof field !== "string" || !field.trim()))
        throw new T3Error("invalid_snapshot");
    }
  }
  for (const items of [projects, threads]) {
    const ids = items.map((item) => nonempty(item.id));
    if (new Set(ids).size !== ids.length) throw new T3Error("identity_collision");
  }
  return { sequence: z.number().parse(input.snapshotSequence), projects, threads };
}

function hasProject(data: Snapshot, target: T3SessionIdentity): boolean {
  const projects = data.projects.filter(
    (p) => p.id === target.projectId || p.workspaceRoot === target.workspaceRoot,
  );
  if (!projects.length) return false;
  if (
    projects.length !== 1 ||
    projects[0]?.id !== target.projectId ||
    projects[0]?.workspaceRoot !== target.workspaceRoot ||
    projects[0]?.deletedAt !== null
  )
    throw new T3Error("identity_collision");
  return true;
}

function findThread(
  data: Snapshot,
  target: T3SessionIdentity,
): Record<string, unknown> | undefined {
  if (!hasProject(data, target)) throw new T3Error("project_missing");
  const matches = data.threads.filter(
    (t) =>
      t.id === target.threadId ||
      (t.deletedAt === null &&
        (t.worktreePath === target.worktreePath ||
          (t.projectId === target.projectId && t.branch === target.branch))),
  );
  if (!matches.length) return undefined;
  const thread = matches[0];
  if (
    matches.length !== 1 ||
    !thread ||
    thread.id !== target.threadId ||
    thread.projectId !== target.projectId ||
    thread.worktreePath !== target.worktreePath ||
    thread.branch !== target.branch
  )
    throw new T3Error("identity_collision");
  if (thread.deletedAt !== null) throw new T3Error("session_deleted");
  return thread;
}

/** A narrow T3 host, deliberately not wired into PickupCoordinator's destructive compensation. */
export class T3Adapter {
  readonly capabilities = capabilities("process_launch", "session_create", "session_status");
  readonly #connect: NonNullable<T3AdapterOptions["connect"]>;
  readonly #attempts: number;
  constructor(private readonly options: T3AdapterOptions) {
    this.#connect = options.connect ?? ((expected) => connectT3(expected ? { expected } : {}));
    this.#attempts = options.attempts ?? 50;
    if (!Number.isSafeInteger(this.#attempts) || this.#attempts < 1 || this.#attempts > 50)
      throw new T3Error("invalid_poll_limit");
  }

  async #using<T>(
    expected: Pick<T3Runtime, "environmentId" | "serverVersion"> | undefined,
    operation: (connection: T3Connection) => Promise<T>,
  ): Promise<T> {
    let connection: T3Connection;
    try {
      connection = await this.#connect(expected);
    } catch (error) {
      throw error instanceof T3Error ? error : new T3Error("server_unavailable");
    }
    try {
      nonempty(connection.runtime.serverVersion);
      nonempty(connection.runtime.environmentId);
      if (expected && connection.runtime.environmentId !== expected.environmentId)
        throw new T3Error("identity_collision");
      return await operation(connection);
    } finally {
      await connection.close();
    }
  }

  async describe(): Promise<{ runtime: T3Runtime; capabilities: CapabilitySet }> {
    return this.#using(undefined, async (c) => {
      snapshot(await c.request("GET", "/api/orchestration/snapshot"));
      return { runtime: c.runtime, capabilities: this.capabilities };
    });
  }

  async inspect(receipt: T3Receipt): Promise<T3Observation> {
    try {
      const checked = t3Receipt(receipt);
      return await this.#using(checked.t3, (c) => this.#observe(c, checked));
    } catch (error) {
      return this.#unknown(error);
    }
  }

  /** Opens the recorded thread in the read model; never sends a prompt or starts a turn. */
  async reconnect(receipt: T3Receipt): Promise<T3Observation> {
    const checked = t3Receipt(receipt);
    const observation = await this.inspect(checked);
    await this.options.journal("t3_reconnected", { receipt: checked, observation });
    return observation;
  }

  #unknown(error: unknown): T3Observation {
    return {
      state: "unknown",
      observedAt: new Date().toISOString(),
      recoveryRequired: true,
      detail: error instanceof T3Error ? error.code : "observation_unavailable",
    };
  }

  async #observe(c: T3Connection, receipt: T3Receipt, minimumSequence = 0): Promise<T3Observation> {
    const data = snapshot(await c.request("GET", "/api/orchestration/snapshot"));
    if (data.sequence < minimumSequence) throw new T3Error("stale_snapshot");
    const thread = findThread(data, receipt.t3);
    const base = {
      observedAt: new Date().toISOString(),
      snapshotSequence: data.sequence,
      serverVersion: c.runtime.serverVersion,
      recoveryRequired: true,
    };
    if (!thread) return { ...base, state: "missing", detail: "session_missing" };
    const selection = model(thread.modelSelection);
    if (
      !sameModel(selection, receipt.t3.modelSelection) ||
      thread.runtimeMode !== receipt.t3.runtimeMode ||
      thread.interactionMode !== receipt.t3.interactionMode
    )
      throw new T3Error("selection_unverified");
    if (!thread.latestTurn || !thread.session)
      return { ...base, state: "unknown", detail: "session_unsettled", modelSelection: selection };
    const turn = object(thread.latestTurn);
    const session = object(thread.session);
    const turnId = nonempty(turn.turnId);
    const turnState = nonempty(turn.state);
    const sessionStatus = nonempty(session.status);
    const observation = { ...base, turnId, turnState, sessionStatus, modelSelection: selection };
    if (
      !["running", "completed", "error", "interrupted"].includes(turnState) ||
      !["idle", "starting", "running", "ready", "interrupted", "stopped", "error"].includes(
        sessionStatus,
      ) ||
      session.threadId !== receipt.t3.threadId ||
      session.providerInstanceId !== selection.instanceId ||
      session.runtimeMode !== receipt.t3.runtimeMode ||
      session.lastError !== null
    )
      return { ...observation, state: "unknown", detail: "session_unverified" };
    // The inspected T3 build emits session/closed before provider cleanup and ignores
    // cleanup errors. Its stopped projection is not a termination barrier, even
    // with a cleared active turn, interrupted latest turn, and no reported error.
    if (sessionStatus === "stopped")
      return { ...observation, state: "unknown", detail: "termination_unverified" };
    if (sessionStatus === "running" && turnState === "running" && session.activeTurnId === turnId)
      return { ...observation, state: "running", recoveryRequired: false };
    // The portable lifecycle has no idle/turn-finished state. Never translate it into stopped/Done.
    if (
      ["ready", "idle", "interrupted"].includes(sessionStatus) &&
      session.activeTurnId === null &&
      turnState !== "running"
    )
      return {
        ...observation,
        state: "unknown",
        detail: "turn_finished",
        recoveryRequired: turnState === "error",
      };
    return { ...observation, state: "unknown", detail: "session_unverified" };
  }

  async #dispatch(
    c: T3Connection,
    receipt: T3Receipt,
    command: Record<string, unknown>,
  ): Promise<number | undefined> {
    const evidence = {
      receipt,
      serverVersion: c.runtime.serverVersion,
      command: {
        type: command.type,
        commandId: command.commandId,
        threadId: command.threadId,
        projectId: command.projectId,
        intentDigest: createHash("sha256").update(JSON.stringify(command)).digest("hex"),
      },
    };
    await this.options.journal("t3_dispatch_prepared", evidence);
    let sequence: number;
    try {
      const result = object(await c.request("POST", "/api/orchestration/dispatch", command));
      if (!Number.isSafeInteger(result.sequence) || z.number().parse(result.sequence) < 0)
        throw new T3Error("invalid_acknowledgement");
      sequence = z.number().parse(result.sequence);
    } catch {
      await this.options.journal("t3_dispatch_unknown", evidence);
      return undefined;
    }
    await this.options.journal("t3_dispatch_acknowledged", { ...evidence, sequence });
    return sequence;
  }

  async #wait(
    c: T3Connection,
    receipt: T3Receipt,
    minimumSequence: number,
    accept: (observation: T3Observation) => boolean,
  ): Promise<T3Observation> {
    let last = this.#unknown(new T3Error("session_unsettled"));
    const deadline = Date.now() + 5_000;
    for (let attempt = 0; attempt < this.#attempts && Date.now() < deadline; attempt++) {
      try {
        last = await this.#observe(c, receipt, minimumSequence);
      } catch (error) {
        last = this.#unknown(error);
      }
      if (accept(last)) return last;
      if (attempt + 1 < this.#attempts)
        await (this.options.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 100)));
    }
    return last;
  }

  async bootstrap(
    input: T3SessionIdentity & { title: string; prompt: string },
  ): Promise<{ receipt: T3Receipt; observation: T3Observation }> {
    const receipt = makeReceipt(input);
    const title = nonempty(input.title);
    const prompt = nonempty(input.prompt);
    return this.#using(receipt.t3, async (c) => {
      receipt.t3.serverVersion = c.runtime.serverVersion;
      let data = snapshot(await c.request("GET", "/api/orchestration/snapshot"));
      if (!hasProject(data, receipt.t3)) {
        // Detect thread/workspace collisions before registering even the project.
        if (
          data.threads.some(
            (t) =>
              t.id === receipt.t3.threadId ||
              (t.deletedAt === null && t.worktreePath === receipt.t3.worktreePath),
          )
        )
          throw new T3Error("identity_collision");
        const sequence = await this.#dispatch(c, receipt, {
          type: "project.create",
          commandId: randomUUID(),
          projectId: receipt.t3.projectId,
          title,
          workspaceRoot: receipt.t3.workspaceRoot,
          createWorkspaceRootIfMissing: false,
          createdAt: new Date().toISOString(),
        });
        if (sequence === undefined) throw new T3Error("dispatch_unknown");
        const deadline = Date.now() + 5_000;
        for (let attempt = 0; attempt < this.#attempts && Date.now() < deadline; attempt++) {
          data = snapshot(await c.request("GET", "/api/orchestration/snapshot"));
          if (data.sequence >= sequence && hasProject(data, receipt.t3)) break;
          if (attempt + 1 < this.#attempts)
            await (this.options.pause?.() ?? new Promise((resolve) => setTimeout(resolve, 100)));
        }
        if (data.sequence < sequence || !hasProject(data, receipt.t3))
          throw new T3Error("project_unverified");
      }
      if (findThread(data, receipt.t3)) throw new T3Error("session_exists_reconnect_required");
      const createdAt = new Date().toISOString();
      const { projectId, modelSelection, runtimeMode, interactionMode, branch, worktreePath } =
        receipt.t3;
      const sequence = await this.#dispatch(c, receipt, {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId: receipt.t3.threadId,
        message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode,
        titleSeed: title,
        createdAt,
        bootstrap: {
          createThread: {
            projectId,
            title,
            modelSelection,
            runtimeMode,
            interactionMode,
            branch,
            worktreePath,
            createdAt,
          },
          runSetupScript: false,
        },
      });
      // No broad Nightly fallback, redispatch, thread deletion, or claim compensation.
      if (sequence === undefined) throw new T3Error("dispatch_unknown");
      const observation = await this.#wait(
        c,
        receipt,
        sequence,
        (o) => !o.recoveryRequired && o.turnId !== undefined,
      );
      await this.options.journal("t3_bootstrap_observed", { receipt, observation });
      if (observation.recoveryRequired || !observation.turnId)
        throw new T3Error("launch_unverified");
      return { receipt, observation };
    });
  }

  async followUp(receipt: T3Receipt, prompt: string): Promise<void> {
    const checked = t3Receipt(receipt);
    nonempty(prompt);
    return this.#using(checked.t3, async (c) => {
      const before = await this.#observe(c, checked);
      if (before.recoveryRequired || before.state === "running" || before.sessionStatus !== "ready")
        throw new T3Error("session_not_ready");
      const { modelSelection, runtimeMode, interactionMode } = checked.t3;
      const sequence = await this.#dispatch(c, checked, {
        type: "thread.turn.start",
        commandId: randomUUID(),
        threadId: checked.t3.threadId,
        message: { messageId: randomUUID(), role: "user", text: prompt, attachments: [] },
        modelSelection,
        runtimeMode,
        interactionMode,
        createdAt: new Date().toISOString(),
      });
      if (sequence === undefined) throw new T3Error("dispatch_unknown");
      const after = await this.#wait(
        c,
        checked,
        sequence,
        (o) => !o.recoveryRequired && o.turnId !== undefined && o.turnId !== before.turnId,
      );
      await this.options.journal("t3_follow_up_observed", { receipt: checked, observation: after });
      if (after.recoveryRequired || !after.turnId || after.turnId === before.turnId)
        throw new T3Error("follow_up_unverified");
    });
  }

  /** Explicit low-level stop request only; this build cannot verify termination. */
  async stopSession(receipt: T3Receipt): Promise<never> {
    const checked = t3Receipt(receipt);
    return this.#using(checked.t3, async (c) => {
      const before = await this.#observe(c, checked);
      if (before.detail === "termination_unverified") {
        await this.options.journal("t3_stop_unknown", { receipt: checked, observation: before });
        throw new T3Error("stop_unverified");
      }
      if (before.recoveryRequired) throw new T3Error("stop_target_unverified");
      const sequence = await this.#dispatch(c, checked, {
        type: "thread.session.stop",
        commandId: randomUUID(),
        threadId: checked.t3.threadId,
        createdAt: new Date().toISOString(),
      });
      const after = await this.#wait(
        c,
        checked,
        sequence ?? before.snapshotSequence ?? 0,
        (o) => o.sessionStatus === "stopped",
      );
      await this.options.journal("t3_stop_unknown", { receipt: checked, observation: after });
      throw new T3Error("stop_unverified");
    });
  }

  lifecycle(): RunLifecycleAdapter {
    const receiptFor = (run: Run) => {
      const receipt = t3Receipt(run.execution);
      if (
        run.workspace.path !== receipt.t3.worktreePath ||
        run.workspace.branch !== receipt.t3.branch
      )
        throw new T3Error("identity_collision");
      return receipt;
    };
    return {
      capabilities: capabilities("session_status"),
      observe: async (run) => {
        try {
          const observation = await this.inspect(receiptFor(run));
          // The generic coordinator treats missing as stopped; T3 absence proves neither.
          return observation.state === "missing"
            ? { ...observation, state: "unknown" }
            : observation;
        } catch (error) {
          return this.#unknown(error);
        }
      },
      stop: async (_run) => {
        // Fail before dispatch even if a caller bypasses coordinator preflight.
        throw new UnsupportedCapabilityError(["session_interrupt"]);
      },
    };
  }
}
