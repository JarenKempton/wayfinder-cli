import type { DependencyStatusTransition } from "./frontier.ts";

export type StatusRepairOutcomeKind =
  | "verified"
  | "collision"
  | "mutation_failed"
  | "unverifiable"
  | "ambiguous";

export interface StatusRepairOutcome {
  ticket: DependencyStatusTransition["ticket"];
  expectedVersion: string;
  outcome: StatusRepairOutcomeKind;
  observedStatus?: string;
  observedVersion?: string;
  evidence?: unknown;
}

export interface StatusRepairService {
  repair(transitions: readonly DependencyStatusTransition[]): Promise<StatusRepairOutcome[]>;
}

export class StatusRepairVerificationError extends Error {
  readonly code = "status_repair_unverified";
  constructor(
    readonly outcomes: readonly StatusRepairOutcome[],
    message: string,
  ) {
    super(message);
    this.name = "StatusRepairVerificationError";
  }
}

export function verifyStatusRepairOutcomes(
  requested: readonly DependencyStatusTransition[],
  outcomes: readonly StatusRepairOutcome[],
): StatusRepairOutcome[] {
  const requestedByTicket = new Map(requested.map((item) => [item.ticket, item]));
  const seen = new Set<string>();
  for (const outcome of outcomes) {
    const request = requestedByTicket.get(outcome.ticket);
    if (
      !request ||
      seen.has(outcome.ticket) ||
      outcome.expectedVersion !== request.expectedVersion
    ) {
      throw new StatusRepairVerificationError(
        outcomes,
        "Status repair returned mismatched outcomes",
      );
    }
    seen.add(outcome.ticket);
    if (
      outcome.outcome !== "verified" ||
      outcome.observedStatus !== request.to ||
      !outcome.observedVersion ||
      outcome.evidence === undefined
    ) {
      throw new StatusRepairVerificationError(
        outcomes,
        `Status repair was not verified for ${outcome.ticket}: ${outcome.outcome}`,
      );
    }
  }
  if (seen.size !== requested.length) {
    throw new StatusRepairVerificationError(outcomes, "Status repair omitted requested outcomes");
  }
  return outcomes.map((item) => ({ ...item }));
}

/** Deterministic conformance fake proving guarded mutation and read-after-write verification. */
export class FakeStatusRepairService implements StatusRepairService {
  constructor(
    readonly records: Map<string, { status: string; version: string; verifiable?: boolean }>,
  ) {}

  async repair(transitions: readonly DependencyStatusTransition[]): Promise<StatusRepairOutcome[]> {
    return transitions.map((request) => {
      const record = this.records.get(request.ticket);
      if (!record || record.version !== request.expectedVersion) {
        return {
          ticket: request.ticket,
          expectedVersion: request.expectedVersion,
          outcome: "collision" as const,
          evidence: { actualVersion: record?.version },
        };
      }
      record.status = request.to;
      record.version = `${record.version}:repaired`;
      if (record.verifiable === false) {
        return {
          ticket: request.ticket,
          expectedVersion: request.expectedVersion,
          outcome: "unverifiable" as const,
          evidence: { mutation: "accepted", readAfterWrite: "unavailable" },
        };
      }
      return {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "verified" as const,
        observedStatus: record.status,
        observedVersion: record.version,
        evidence: { readAfterWrite: true },
      };
    });
  }
}
