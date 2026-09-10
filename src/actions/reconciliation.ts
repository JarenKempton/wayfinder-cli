import { readFileSync } from "node:fs";
import type { Ticket, TicketRef } from "../domain.ts";
import { reconcileDependencyStatuses } from "../frontier.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import {
  evaluateStatusRepairBatch,
  type StatusRepairDisposition,
  type StatusRepairOutcome,
  StatusRepairPersistenceError,
  type StatusRepairRecoveryReceipt,
  statusRepairAdapterBinding,
  statusRepairAdapterMatches,
} from "../status-repair.ts";
import { defineAction } from "./definition.ts";
import { flag, type Input, optional, positional, text } from "./input.ts";
import { parseScope } from "./store.ts";

const statusesInput = {
  scope: positional(text("Qualified tracker scope.", "scope")),
  input: optional(text("Normalized ticket input (required unless recovering).", "FILE")),
  available: optional(text("Ready status (default: To Do).", "STATUS")),
  blocked: optional(text("Blocked status (default: Blocked).", "STATUS")),
  repair: flag(
    "Plan or apply status repair; applying requires composed repair and receipt services.",
  ),
  "dry-run": flag("Plan repairs without mutation; requires --repair."),
  recover: optional(
    text(
      "Recover a durable repair receipt; requires composed repair and receipt services.",
      "receipt-ref",
    ),
  ),
};
export function reconciliationActions(services: RuntimeServices) {
  return {
    reconcile: {
      statuses: defineAction({
        description:
          "Audit dependency-derived statuses; optionally plan repairs or use composed repair services.",
        input: statusesInput,
        dependencies: {},
        handler: (_, input) => reconcile(input, services),
        render(result, json) {
          if (json || !("transitions" in result)) return [JSON.stringify(result, null, 2)];
          return [
            ...result.transitions.map((item) => `${item.ticket}\t${item.from} -> ${item.to}`),
            ...result.drift.map((item) => `${item.ticket}\tattention: ${item.from} -> ${item.to}`),
          ];
        },
      }),
    },
  };
}
function unavailableRuntime(command: string, requirement: string): Error {
  return new Error(
    `${command} is unavailable in this binary: no ${requirement} is composed; use a runtime that explicitly provides it`,
  );
}
async function reconcile(input: Input<typeof statusesInput>, services: RuntimeServices) {
  const scopeReference = input.scope;
  const scope = parseScope(scopeReference);
  const recoveryRef = input.recover;
  if (input.recover !== undefined) {
    if (!recoveryRef) throw new Error("reconcile statuses --recover requires <receipt-ref>");
    return recoverStatusRepair(recoveryRef, scopeReference, services);
  }
  const file = input.input;
  if (!file) throw new Error("reconcile statuses currently requires --input <tickets.json>");
  const tickets = JSON.parse(readFileSync(file, "utf8")) as Ticket[];
  const ready = input.available ?? "To Do";
  const blocked = input.blocked ?? "Blocked";
  const result = reconcileDependencyStatuses(tickets, scope, {
    ready,
    blocked,
    managedStatuses: new Set([ready, blocked]),
    protectedStatuses: new Set(["In Progress", "In Review"]),
  });
  const repair = input.repair ?? false;
  const dryRun = input["dry-run"] ?? false;
  let repairOutcomes: StatusRepairOutcome[] | undefined;
  if (dryRun && !repair) throw new Error("reconcile statuses --dry-run requires --repair");
  if (repair && !dryRun) {
    if (!services.statusRepair) {
      throw unavailableRuntime(
        "reconcile statuses --repair",
        "conditional status mutation and verification service",
      );
    }
    let evaluated = evaluateStatusRepairBatch(
      result.transitions,
      await services.statusRepair.repair(result.transitions),
    );
    const advertisedAdapter = statusRepairAdapterBinding(services.statusRepair.adapter);
    if (!statusRepairAdapterMatches(advertisedAdapter, evaluated.adapter)) {
      const request = result.transitions[0];
      const diagnostic: StatusRepairOutcome = {
        ticket: request?.ticket ?? ("status-repair:adapter" as TicketRef),
        expectedVersion: request?.expectedVersion ?? "",
        outcome: "ambiguous",
        detail: {
          reason: "status repair adapter binding mismatch",
          expected: advertisedAdapter,
          observed: evaluated.adapter,
        },
      };
      evaluated = {
        ...evaluated,
        verified: false,
        adapter: advertisedAdapter,
        diagnostics: [...evaluated.diagnostics, diagnostic],
      };
    }
    repairOutcomes = evaluated.dispositions;
    if (!evaluated.verified) {
      if (!services.statusRepairReceipts) {
        throw new Error("Status repair requires a durable recovery receipt store");
      }
      let ref: string;
      try {
        ref = await services.statusRepairReceipts.allocateRef();
      } catch (cause) {
        throw new StatusRepairPersistenceError(
          "Failed to allocate status repair recovery receipt",
          evaluated,
          { cause },
        );
      }
      const recovery: StatusRepairRecoveryReceipt = {
        ref,
        version: 1,
        action: "status_repair_recovery_required",
        scope: scopeReference,
        adapter: evaluated.adapter,
        requested: result.transitions,
        rawOutcomes: evaluated.rawOutcomes,
        dispositions: evaluated.dispositions,
        diagnostics: evaluated.diagnostics,
        refreshEvidence: [],
        recoveryArgv: ["reconcile", "statuses", scopeReference, "--recover", ref, "--json"],
      };
      try {
        await services.statusRepairReceipts.create(ref, recovery);
      } catch (cause) {
        throw new StatusRepairPersistenceError(
          "Failed to persist status repair recovery receipt",
          evaluated,
          { cause },
        );
      }
      return recovery;
    }
  }
  const receipt = {
    version: 1,
    action: repair ? (dryRun ? "status_repair_planned" : "statuses_repaired") : "statuses_audited",
    scope,
    dryRun,
    transitions: result.transitions,
    drift: result.drift,
    ...(repairOutcomes ? { repairOutcomes } : {}),
    counts: { transitions: result.transitions.length, drift: result.drift.length },
  };
  return receipt;
}
async function recoverStatusRepair(ref: string, scopeReference: string, services: RuntimeServices) {
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
      ticket: prior.requested[0]?.ticket ?? ("status-repair:adapter" as TicketRef),
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
  const retry: import("../frontier.ts").DependencyStatusTransition[] = [];
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
        ticket: request?.ticket ?? ("status-repair:adapter" as TicketRef),
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
