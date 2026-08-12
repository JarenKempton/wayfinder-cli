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
  repair(transitions: readonly DependencyStatusTransition[]): Promise<StatusRepairBatchResult>;
}

export interface StatusRepairRecoveryReceipt {
  version: 1;
  action: "status_repair_recovery_required";
  requested: DependencyStatusTransition[];
  outcomes: StatusRepairOutcome[];
  recoveryCommand: string;
}

export interface StatusRepairReceiptStore {
  persist(receipt: StatusRepairRecoveryReceipt): void | Promise<void>;
}

export function evaluateStatusRepairBatch(
  requested: readonly DependencyStatusTransition[],
  result: StatusRepairBatchResult,
): { verified: boolean; outcomes: StatusRepairOutcome[] } {
  const requestedByTicket = new Map(requested.map((item) => [item.ticket, item]));
  const supplied = new Map<string, StatusRepairOutcome>();
  for (const outcome of result.outcomes) {
    if (!requestedByTicket.has(outcome.ticket) || supplied.has(outcome.ticket)) continue;
    supplied.set(outcome.ticket, outcome);
  }
  const outcomes = requested.map((request) => {
    const outcome = supplied.get(request.ticket) ?? {
      ticket: request.ticket,
      expectedVersion: request.expectedVersion,
      outcome: "untouched" as const,
      detail: "adapter omitted outcome",
    };
    return proofVerifies(request, outcome, result.adapter)
      ? outcome
      : outcome.outcome === "verified"
        ? { ...outcome, outcome: "unverifiable" as const, detail: "invalid verification proof" }
        : outcome;
  });
  return { verified: outcomes.every((item) => item.outcome === "verified"), outcomes };
}

function proofVerifies(
  request: DependencyStatusTransition,
  outcome: StatusRepairOutcome,
  adapter: StatusRepairAdapterIdentity,
): boolean {
  const proof = outcome.proof;
  if (outcome.outcome !== "verified" || !proof) return false;
  const versions = adapter.versionContract;
  return (
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
    proof.adapter.capabilities.conditional_update === true &&
    proof.adapter.capabilities.workflow_transition === true
  );
}

export const opaqueVersionContract: TrackerVersionContract = {
  name: "opaque-change-token-v1",
  equals: (left, right) => left === right,
  isSuccessor: (before, after) => before !== after && after.length > 0,
};

export class FakeStatusRepairService implements StatusRepairService {
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

  private failure(
    request: DependencyStatusTransition,
    outcome: Exclude<StatusRepairOutcomeKind, "verified">,
    detail?: unknown,
  ): StatusRepairOutcome {
    return { ticket: request.ticket, expectedVersion: request.expectedVersion, outcome, detail };
  }
}
