import { readFileSync } from "node:fs";
import type { Input } from "../cli/schema.ts";
import { ticketRefSchema } from "../domain/identifiers.ts";
import { parseTickets } from "../domain/tickets.ts";
import { reconcileDependencyStatuses } from "../frontier/evaluate.ts";
import { parseScope } from "../persistence/command-store.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import type { statusesInput } from "./inputs.ts";
import { recoverStatusRepair } from "./recovery.ts";
import {
  evaluateStatusRepairBatch,
  type StatusRepairOutcome,
  StatusRepairPersistenceError,
  type StatusRepairRecoveryReceipt,
  statusRepairAdapterBinding,
  statusRepairAdapterMatches,
} from "./status-repair.ts";

function unavailableRuntime(command: string, requirement: string): Error {
  return new Error(
    `${command} is unavailable in this binary: no ${requirement} is composed; use a runtime that explicitly provides it`,
  );
}
export async function reconcileStatuses(
  input: Input<typeof statusesInput>,
  services: RuntimeServices,
) {
  const scopeReference = input.scope;
  const scope = parseScope(scopeReference);
  const recoveryRef = input.recover;
  if (input.recover !== undefined) {
    if (!recoveryRef) throw new Error("reconcile statuses --recover requires <receipt-ref>");
    return recoverStatusRepair(recoveryRef, scopeReference, services);
  }
  const file = input.input;
  if (!file) throw new Error("reconcile statuses currently requires --input <tickets.json>");
  const tickets = parseTickets(JSON.parse(readFileSync(file, "utf8")));
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
        ticket: request?.ticket ?? ticketRefSchema.parse("status-repair:adapter"),
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
