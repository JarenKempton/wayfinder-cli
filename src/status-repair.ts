import type { CapabilitySet, TicketRef } from "./domain.ts";
import type { DependencyStatusTransition } from "./frontier.ts";

export interface TrackerVersionContract {
  name: string;
  equals(left: string, right: string): boolean;
  isSuccessor(before: string, after: string): boolean;
}

export interface StatusRepairAdapterIdentity {
  adapter: string;
  instance: string;
  capabilities: CapabilitySet;
  versionContract: TrackerVersionContract;
}

export interface StatusRepairAdapterBinding {
  adapter: string;
  instance: string;
  capabilities: CapabilitySet;
  versionContract: string;
}

export interface VerifiedStatusRepairProof {
  conditionalGuard: { expectedVersion: string; applied: true };
  mutation: { acknowledged: true; version: string };
  observation: { readAfterWrite: true; version: string; status: string };
  adapter: Omit<StatusRepairAdapterIdentity, "versionContract"> & { versionContract: string };
}

export type StatusRepairOutcomeKind =
  | "verified"
  | "collision"
  | "mutation_failed"
  | "unverifiable"
  | "ambiguous"
  | "untouched";

export interface StatusRepairOutcome {
  ticket: TicketRef;
  expectedVersion: string;
  outcome: StatusRepairOutcomeKind;
  proof?: VerifiedStatusRepairProof;
  detail?: unknown;
}

export interface StatusRepairBatchResult {
  adapter: StatusRepairAdapterIdentity;
  outcomes: StatusRepairOutcome[];
}

export interface StatusRepairService {
  readonly adapter: StatusRepairAdapterIdentity;
  repair(transitions: readonly DependencyStatusTransition[]): Promise<StatusRepairBatchResult>;
  refresh(tickets: readonly TicketRef[]): Promise<StatusRefreshResult>;
}

export interface StatusRefreshObservation {
  ticket: TicketRef;
  outcome: "observed" | "missing" | "ambiguous";
  status?: string;
  version?: string;
  detail?: unknown;
}

export interface StatusRefreshResult {
  adapter: StatusRepairAdapterIdentity;
  observations: StatusRefreshObservation[];
}

export interface StatusRefreshEvidence {
  adapter: StatusRepairAdapterBinding;
  observations: StatusRefreshObservation[];
}

export interface StatusRepairDisposition extends StatusRepairOutcome {
  reconciled?: true;
}

export interface StatusRepairEvaluation {
  verified: boolean;
  adapter: StatusRepairAdapterBinding;
  rawOutcomes: StatusRepairOutcome[];
  dispositions: StatusRepairDisposition[];
  diagnostics: StatusRepairOutcome[];
}

export interface StatusRepairRecoveryReceipt {
  ref: string;
  version: 1;
  action: "status_repair_recovery_required" | "status_repair_recovered" | "attention_required";
  scope: string;
  adapter: StatusRepairAdapterBinding;
  requested: DependencyStatusTransition[];
  rawOutcomes: StatusRepairOutcome[];
  dispositions: StatusRepairDisposition[];
  diagnostics: StatusRepairOutcome[];
  refreshEvidence: StatusRefreshEvidence[];
  recoveryArgv: string[];
}

export interface StatusRepairReceiptStore {
  /** Allocates an identifier without creating a durable receipt row. */
  allocateRef(): string | Promise<string>;
  /** Atomically creates the complete receipt or leaves no row at `ref`. */
  create(ref: string, receipt: StatusRepairRecoveryReceipt): void | Promise<void>;
  load(ref: string): StatusRepairRecoveryReceipt | Promise<StatusRepairRecoveryReceipt | undefined>;
  update(ref: string, receipt: StatusRepairRecoveryReceipt): void | Promise<void>;
}

export class StatusRepairPersistenceError extends Error {
  readonly name = "StatusRepairPersistenceError";

  constructor(
    message: string,
    readonly evidence: StatusRepairEvaluation,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function evaluateStatusRepairBatch(
  requested: readonly DependencyStatusTransition[],
  result: StatusRepairBatchResult,
): StatusRepairEvaluation {
  const requestedByTicket = new Map(requested.map((item) => [item.ticket, item]));
  const grouped = new Map<string, StatusRepairOutcome[]>();
  const diagnostics: StatusRepairOutcome[] = [];
  for (const raw of result.outcomes) {
    if (!requestedByTicket.has(raw.ticket)) {
      diagnostics.push({ ...raw, outcome: "ambiguous", detail: "unexpected adapter outcome" });
      continue;
    }
    const entries = grouped.get(raw.ticket) ?? [];
    entries.push(raw);
    grouped.set(raw.ticket, entries);
  }
  const dispositions = requested.map((request): StatusRepairDisposition => {
    const entries = grouped.get(request.ticket) ?? [];
    if (entries.length === 0) {
      const diagnostic: StatusRepairDisposition = {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "untouched" as const,
        detail: "adapter omitted outcome",
      };
      diagnostics.push(diagnostic);
      return diagnostic;
    }
    if (entries.length !== 1) {
      const diagnostic: StatusRepairDisposition = {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "ambiguous",
        detail: { reason: "duplicate adapter outcomes", count: entries.length },
      };
      diagnostics.push(diagnostic);
      return diagnostic;
    }
    const outcome = entries[0] as StatusRepairOutcome;
    if (outcome.expectedVersion !== request.expectedVersion) {
      const diagnostic: StatusRepairDisposition = {
        ...outcome,
        outcome: "ambiguous",
        detail: {
          reason: "mismatched expected version",
          requested: request.expectedVersion,
          received: outcome.expectedVersion,
        },
      };
      diagnostics.push(diagnostic);
      return diagnostic;
    }
    if (proofVerifies(request, outcome, result.adapter)) return outcome;
    if (outcome.outcome !== "verified") return outcome;
    const diagnostic: StatusRepairDisposition = {
      ...outcome,
      outcome: "unverifiable",
      detail: "invalid verification proof",
    };
    diagnostics.push(diagnostic);
    return diagnostic;
  });
  const adapterCapable =
    result.adapter.capabilities.conditional_update === true &&
    result.adapter.capabilities.workflow_transition === true;
  return {
    verified:
      adapterCapable &&
      diagnostics.length === 0 &&
      result.outcomes.length === requested.length &&
      dispositions.every((item) => item.outcome === "verified"),
    adapter: statusRepairAdapterBinding(result.adapter),
    rawOutcomes: result.outcomes.map((item) => structuredClone(item)),
    dispositions,
    diagnostics,
  };
}

export function statusRepairAdapterBinding(
  adapter: StatusRepairAdapterIdentity,
): StatusRepairAdapterBinding {
  return {
    adapter: adapter.adapter,
    instance: adapter.instance,
    capabilities: { ...adapter.capabilities },
    versionContract: adapter.versionContract.name,
  };
}

export function statusRepairAdapterMatches(
  expected: StatusRepairAdapterBinding,
  actual: StatusRepairAdapterIdentity | StatusRepairAdapterBinding,
): boolean {
  const binding: StatusRepairAdapterBinding =
    typeof actual.versionContract === "string"
      ? {
          adapter: actual.adapter,
          instance: actual.instance,
          capabilities: actual.capabilities,
          versionContract: actual.versionContract,
        }
      : statusRepairAdapterBinding(actual as StatusRepairAdapterIdentity);
  return (
    expected.adapter === binding.adapter &&
    expected.instance === binding.instance &&
    expected.versionContract === binding.versionContract &&
    canonicalCapabilities(expected.capabilities) === canonicalCapabilities(binding.capabilities)
  );
}

function proofVerifies(
  request: DependencyStatusTransition,
  outcome: StatusRepairOutcome,
  adapter: StatusRepairAdapterIdentity,
): boolean {
  const proof = outcome.proof;
  if (outcome.outcome !== "verified" || !proof) return false;
  const versions = adapter.versionContract;
  const batchCapabilities = canonicalCapabilities(adapter.capabilities);
  const proofCapabilities = canonicalCapabilities(proof.adapter.capabilities);
  return (
    adapter.capabilities.conditional_update === true &&
    adapter.capabilities.workflow_transition === true &&
    outcome.expectedVersion === request.expectedVersion &&
    proof.conditionalGuard.applied === true &&
    versions.equals(proof.conditionalGuard.expectedVersion, request.expectedVersion) &&
    proof.mutation.acknowledged === true &&
    versions.isSuccessor(request.expectedVersion, proof.mutation.version) &&
    proof.observation.readAfterWrite === true &&
    versions.equals(proof.mutation.version, proof.observation.version) &&
    proof.observation.status === request.to &&
    proof.adapter.adapter === adapter.adapter &&
    proof.adapter.instance === adapter.instance &&
    proof.adapter.versionContract === versions.name &&
    batchCapabilities === proofCapabilities
  );
}

function canonicalCapabilities(capabilities: CapabilitySet): string {
  return JSON.stringify(
    Object.entries(capabilities)
      .filter(([, value]) => value === true)
      .map(([key]) => key)
      .toSorted(),
  );
}

export const opaqueVersionContract: TrackerVersionContract = {
  name: "opaque-change-token-v1",
  equals: (left, right) => left === right,
  isSuccessor: (before, after) => before !== after && after.length > 0,
};

export class FakeStatusRepairService implements StatusRepairService {
  readonly repairCalls: TicketRef[][] = [];
  readonly refreshCalls: TicketRef[][] = [];
  readonly adapter: StatusRepairAdapterIdentity = {
    adapter: "fake",
    instance: "test",
    capabilities: { conditional_update: true, workflow_transition: true },
    versionContract: opaqueVersionContract,
  };

  constructor(
    readonly records: Map<
      string,
      { status: string; version: string; outcome?: Exclude<StatusRepairOutcomeKind, "verified"> }
    >,
  ) {}

  async repair(
    transitions: readonly DependencyStatusTransition[],
  ): Promise<StatusRepairBatchResult> {
    this.repairCalls.push(transitions.map((item) => item.ticket));
    const outcomes = transitions.map((request) => {
      const record = this.records.get(request.ticket);
      if (!record || record.version !== request.expectedVersion) {
        return this.failure(request, "collision", { actualVersion: record?.version });
      }
      if (record.outcome) return this.failure(request, record.outcome);
      const postVersion = `${record.version}:next`;
      record.status = request.to;
      record.version = postVersion;
      return {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "verified" as const,
        proof: {
          conditionalGuard: { expectedVersion: request.expectedVersion, applied: true as const },
          mutation: { acknowledged: true as const, version: postVersion },
          observation: {
            readAfterWrite: true as const,
            version: postVersion,
            status: record.status,
          },
          adapter: {
            adapter: this.adapter.adapter,
            instance: this.adapter.instance,
            capabilities: this.adapter.capabilities,
            versionContract: this.adapter.versionContract.name,
          },
        },
      };
    });
    return { adapter: this.adapter, outcomes };
  }

  async refresh(tickets: readonly TicketRef[]): Promise<StatusRefreshResult> {
    this.refreshCalls.push([...tickets]);
    return {
      adapter: this.adapter,
      observations: tickets.map((ticket) => {
        const record = this.records.get(ticket);
        if (!record) return { ticket, outcome: "missing" as const };
        if (record.outcome === "ambiguous") {
          return { ticket, outcome: "ambiguous" as const, detail: "fake ambiguous refresh" };
        }
        return {
          ticket,
          outcome: "observed" as const,
          status: record.status,
          version: record.version,
        };
      }),
    };
  }

  private failure(
    request: DependencyStatusTransition,
    outcome: Exclude<StatusRepairOutcomeKind, "verified">,
    detail?: unknown,
  ): StatusRepairOutcome {
    return { ticket: request.ticket, expectedVersion: request.expectedVersion, outcome, detail };
  }
}
