import { ticketRefSchema } from "../domain/identifiers.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import {
  evaluateStatusRepairBatch,
  type StatusRepairDisposition,
  type StatusRepairOutcome,
  type StatusRepairRecoveryReceipt,
  statusRepairAdapterBinding,
  statusRepairAdapterMatches,
} from "./status-repair.ts";

function unavailableRuntime(command: string, requirement: string): Error {
  return new Error(
    `${command} is unavailable in this binary: no ${requirement} is composed; use a runtime that explicitly provides it`,
  );
}
export async function recoverStatusRepair(
  ref: string,
  scopeReference: string,
  services: RuntimeServices,
) {
  if (!services.statusRepair || !services.statusRepairReceipts) {
    throw unavailableRuntime(
      "reconcile statuses --recover",
      "status repair and durable receipt services",
    );
  }
  const statusRepair = services.statusRepair;
  const receiptStore = services.statusRepairReceipts;
  const prior = await receiptStore.load(ref);
  if (!prior) throw new Error(`Status repair recovery receipt not found: ${ref}`);
  if (prior.scope !== scopeReference) throw new Error("Status repair recovery scope mismatch");
  const persistAdapterMismatch = async (
    stage: "service" | "refresh" | "retry",
    observed: ReturnType<typeof statusRepairAdapterBinding>,
    refreshEvidence: StatusRepairRecoveryReceipt["refreshEvidence"],
  ) => {
    const diagnostic: StatusRepairOutcome = {
      ticket: prior.requested[0]?.ticket ?? ticketRefSchema.parse("status-repair:adapter"),
      expectedVersion: prior.requested[0]?.expectedVersion ?? "",
      outcome: "ambiguous",
      detail: {
        reason: "status repair adapter binding mismatch",
        stage,
        expected: prior.adapter,
        observed,
      },
    };
    const receipt: StatusRepairRecoveryReceipt = {
      ...prior,
      action: "attention_required",
      dispositions: prior.requested.map((request) => ({
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "ambiguous",
        detail: diagnostic.detail,
      })),
      diagnostics: [...prior.diagnostics, diagnostic],
      refreshEvidence,
      recoveryArgv: ["reconcile", "statuses", scopeReference, "--recover", ref, "--json"],
    };
    await receiptStore.update(ref, receipt);
    return receipt;
  };
  const advertisedAdapter = statusRepairAdapterBinding(statusRepair.adapter);
  if (!statusRepairAdapterMatches(prior.adapter, advertisedAdapter)) {
    return persistAdapterMismatch("service", advertisedAdapter, prior.refreshEvidence);
  }
  const refresh = await statusRepair.refresh(prior.requested.map((item) => item.ticket));
  const refreshEvidence = [
    ...prior.refreshEvidence,
    {
      adapter: {
        adapter: refresh.adapter.adapter,
        instance: refresh.adapter.instance,
        capabilities: { ...refresh.adapter.capabilities },
        versionContract: refresh.adapter.versionContract.name,
      },
      observations: refresh.observations.map((item) => structuredClone(item)),
    },
  ];
  if (!statusRepairAdapterMatches(prior.adapter, refresh.adapter)) {
    return persistAdapterMismatch(
      "refresh",
      statusRepairAdapterBinding(refresh.adapter),
      refreshEvidence,
    );
  }
  const observations = new Map<string, (typeof refresh.observations)[number][]>();
  const requestedTickets = new Set(prior.requested.map((item) => item.ticket));
  let diagnostics = [...prior.diagnostics];
  let attention = false;
  for (const observation of refresh.observations) {
    if (!requestedTickets.has(observation.ticket)) {
      attention = true;
      diagnostics.push({
        ticket: observation.ticket,
        expectedVersion: "",
        outcome: "ambiguous",
        detail: { reason: "unexpected refresh observation", observation },
      });
      continue;
    }
    const entries = observations.get(observation.ticket) ?? [];
    entries.push(observation);
    observations.set(observation.ticket, entries);
  }
  const dispositions: StatusRepairDisposition[] = [];
  const retry: import("../frontier/evaluate.ts").DependencyStatusTransition[] = [];
  for (const request of prior.requested) {
    const entries = observations.get(request.ticket) ?? [];
    const observed = entries[0];
    if (entries.length !== 1 || !observed || observed.outcome !== "observed") {
      attention = true;
      const diagnostic: StatusRepairDisposition = {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "ambiguous",
        detail: { reason: "refresh was not exact and observable", observations: entries },
      };
      dispositions.push(diagnostic);
      diagnostics.push(diagnostic);
      continue;
    }
    if (!observed.version || !observed.status) {
      attention = true;
      const diagnostic: StatusRepairDisposition = {
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "unverifiable",
        detail: "refresh omitted status or version",
      };
      dispositions.push(diagnostic);
      diagnostics.push(diagnostic);
      continue;
    }
    if (observed.status === request.to) {
      dispositions.push({
        ticket: request.ticket,
        expectedVersion: request.expectedVersion,
        outcome: "verified",
        reconciled: true,
        detail: { observedStatus: observed.status, observedVersion: observed.version },
      });
      continue;
    }
    retry.push({
      ...request,
      from: observed.status,
      expectedVersion: observed.version,
    });
  }
  let rawOutcomes = [...prior.rawOutcomes];
  if (retry.length > 0) {
    const retryAdapter = statusRepairAdapterBinding(statusRepair.adapter);
    if (!statusRepairAdapterMatches(prior.adapter, retryAdapter)) {
      return persistAdapterMismatch("retry", retryAdapter, refreshEvidence);
    }
    const evaluated = evaluateStatusRepairBatch(retry, await statusRepair.repair(retry));
    rawOutcomes = [...rawOutcomes, ...evaluated.rawOutcomes];
    diagnostics = [...diagnostics, ...evaluated.diagnostics];
    const adapterMatches = statusRepairAdapterMatches(prior.adapter, evaluated.adapter);
    const retryDispositions = adapterMatches
      ? evaluated.dispositions
      : retry.map(
          (request): StatusRepairDisposition => ({
            ticket: request.ticket,
            expectedVersion: request.expectedVersion,
            outcome: "ambiguous",
            detail: {
              reason: "status repair adapter binding mismatch",
              stage: "retry",
              expected: prior.adapter,
              observed: evaluated.adapter,
            },
          }),
        );
    const retryByTicket = new Map(retryDispositions.map((item) => [item.ticket, item]));
    for (const request of retry) {
      const disposition = retryByTicket.get(request.ticket);
      if (disposition) dispositions.push(disposition);
    }
    if (!adapterMatches) {
      attention = true;
      const request = retry[0];
      diagnostics.push({
        ticket: request?.ticket ?? ticketRefSchema.parse("status-repair:adapter"),
        expectedVersion: request?.expectedVersion ?? "",
        outcome: "ambiguous",
        detail: {
          reason: "status repair adapter binding mismatch",
          stage: "retry",
          expected: prior.adapter,
          observed: evaluated.adapter,
        },
      });
    }
    if (!evaluated.verified) attention = true;
  }
  // Preserve requested ordering in the durable result.
  const byTicket = new Map(dispositions.map((item) => [item.ticket, item]));
  const ordered = prior.requested.map((request) => {
    const disposition = byTicket.get(request.ticket);
    if (disposition) return disposition;
    attention = true;
    return {
      ticket: request.ticket,
      expectedVersion: request.expectedVersion,
      outcome: "untouched" as const,
      detail: "recovery omitted disposition",
    };
  });
  const recovered = !attention && ordered.every((item) => item?.outcome === "verified");
  const receipt: StatusRepairRecoveryReceipt = {
    ...prior,
    action: recovered ? "status_repair_recovered" : "attention_required",
    rawOutcomes,
    dispositions: ordered,
    diagnostics,
    refreshEvidence,
    recoveryArgv: ["reconcile", "statuses", scopeReference, "--recover", ref, "--json"],
  };
  await receiptStore.update(ref, receipt);
  return receipt;
}
