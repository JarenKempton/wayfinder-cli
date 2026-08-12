#!/usr/bin/env bun

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { builtInAdapters, findAdapter } from "./adapters.ts";
import { runAdapterConformance } from "./conformance.ts";
import type { RecoveryVerification, RunLifecycleAdapter, TrackerAdapter } from "./contracts.ts";
import type {
  Claim,
  GroupRef,
  MapRef,
  Run,
  RunObservation,
  Ticket,
  TicketRef,
  WorkspaceRef,
} from "./domain.ts";
import { evaluateFrontier, type FrontierScope, reconcileDependencyStatuses } from "./frontier.ts";
import { LifecycleCoordinator, Supervisor } from "./lifecycle.ts";
import { databasePath } from "./paths.ts";
import { ProcessLifecycleAdapter } from "./platform/process-lifecycle.ts";
import { AdapterClient, PROTOCOL_VERSION } from "./protocol.ts";
import { parseRef } from "./reference.ts";
import { StateStore } from "./state.ts";
import {
  evaluateStatusRepairBatch,
  type StatusRepairOutcome,
  type StatusRepairReceiptStore,
  type StatusRepairRecoveryReceipt,
  type StatusRepairService,
} from "./status-repair.ts";

export const VERSION = "0.1.0-dev";

export interface RuntimeServices {
  tracker?: TrackerAdapter;
  lifecycle?(run: Run): RunLifecycleAdapter;
  statePath?: string;
  now?: () => Date;
  verifyRecovery?(run: Run, evidence: unknown): Promise<RecoveryVerification>;
  verifyAttention?(
    run: Run,
    evidence: unknown,
  ): Promise<{ observation: RunObservation; claim: Claim }>;
  statusRepair?: StatusRepairService;
  statusRepairReceipts?: StatusRepairReceiptStore;
}

export async function run(
  args: string[],
  write: (text: string) => void = console.log,
  services: RuntimeServices = {},
): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      write(usage(services));
      return;
    case "version":
    case "--version":
      write(VERSION);
      return;
    case "doctor":
      return doctor(write);
    case "resolve":
      return resolve(rest, write);
    case "frontier":
      return frontier(rest, write);
    case "reconcile":
      return reconcile(rest, write, services);
    case "adapter":
      return adapter(rest, write);
    case "runs":
      return runs(rest, write, services);
    case "stop":
      return stop(rest, write, services);
    case "recover":
      return recover(rest, write, services);
    case "claim":
      return claim(rest, write, services);
    case "supervisor":
      return supervisor(rest, write, services);
    case "pickup":
    case "resume":
    case "workspace":
    case "init":
    case "config":
      throw new Error(
        `${command} is reserved by the stable contract but is not implemented safely in this pre-release`,
      );
    default:
      throw new Error(`Unknown command: ${JSON.stringify(command)}`);
  }
}

function usage(services: RuntimeServices): string {
  const commands = [
    "wayfinder doctor",
    "wayfinder resolve <qualified-reference>",
    'wayfinder frontier --input <tickets.json> [--scope <ref>] [--available "To Do,Open"] [--json]',
    'wayfinder reconcile statuses <scope> --input <workspace-tickets.json> [--available "To Do"] [--blocked "Blocked"] [--repair [--dry-run]] [--json]',
    "wayfinder adapter list",
    "wayfinder adapter describe <name>",
    "wayfinder adapter test <executable>",
    "wayfinder adapter conformance <fixture>",
    "wayfinder runs list",
    "wayfinder runs show <run-id>",
    "wayfinder runs export <run-id>",
    "wayfinder claim show <claim-id>",
    "wayfinder supervisor status",
  ];
  if (services.tracker) commands.push("wayfinder claim release <claim-id> --authorized-by <actor>");
  if (services.lifecycle) commands.push("wayfinder stop <run-id>");
  if (services.verifyRecovery) commands.push("wayfinder recover <run-id> --evidence <json>");
  if (services.tracker && services.lifecycle) commands.push("wayfinder supervisor tick");
  if (services.verifyAttention) {
    commands.push("wayfinder supervisor reconcile <run-id> --evidence <json>");
  }
  commands.push("wayfinder version");
  return `Wayfinder CLI — portable work orchestration for agents

Usage:
  ${commands.join("\n  ")}`;
}

async function reconcile(
  args: string[],
  write: (text: string) => void,
  services: RuntimeServices,
): Promise<void> {
  const [subcommand, scopeReference, ...rest] = args;
  if (subcommand !== "statuses") throw new Error("reconcile requires statuses <scope>");
  if (!scopeReference || scopeReference.startsWith("--")) {
    throw new Error("reconcile statuses requires a qualified <scope>");
  }
  const scope = parseScope(scopeReference);
  const flags = parseFlags(rest);
  const input = value(flags, "input");
  if (!input) throw new Error("reconcile statuses currently requires --input <tickets.json>");
  const tickets = JSON.parse(readFileSync(input, "utf8")) as Ticket[];
  const ready = value(flags, "available") ?? "To Do";
  const blocked = value(flags, "blocked") ?? "Blocked";
  const result = reconcileDependencyStatuses(tickets, scope, {
    ready,
    blocked,
    managedStatuses: new Set([ready, blocked]),
    protectedStatuses: new Set(["In Progress", "In Review"]),
  });
  const repair = flags.has("repair");
  const dryRun = flags.has("dry-run");
  let repairOutcomes: StatusRepairOutcome[] | undefined;
  if (dryRun && !repair) throw new Error("reconcile statuses --dry-run requires --repair");
  if (repair && !dryRun) {
    if (!services.statusRepair) {
      throw unavailableRuntime(
        "reconcile statuses --repair",
        "conditional status mutation and verification service",
      );
    }
    const evaluated = evaluateStatusRepairBatch(
      result.transitions,
      await services.statusRepair.repair(result.transitions),
    );
    repairOutcomes = evaluated.outcomes;
    if (!evaluated.verified) {
      const recovery: StatusRepairRecoveryReceipt = {
        version: 1,
        action: "status_repair_recovery_required",
        requested: result.transitions,
        outcomes: evaluated.outcomes,
        recoveryCommand: `wayfinder reconcile statuses ${scopeReference} --repair --json`,
      };
      if (!services.statusRepairReceipts) {
        throw new Error("Status repair requires a durable recovery receipt store");
      }
      await services.statusRepairReceipts.persist(recovery);
      writeJson(write, recovery);
      return;
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
  if (flags.has("json")) return writeJson(write, receipt);
  for (const transition of result.transitions) {
    write(`${transition.ticket}\t${transition.from} -> ${transition.to}`);
  }
  for (const drift of result.drift)
    write(`${drift.ticket}\tattention: ${drift.from} -> ${drift.to}`);
}

function doctor(write: (text: string) => void): void {
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new StateStore(path);
  store.close();
  writeJson(write, {
    ok: true,
    version: VERSION,
    protocolVersion: PROTOCOL_VERSION,
    database: path,
    adapters: builtInAdapters().length,
  });
}

function resolve(args: string[], write: (text: string) => void): void {
  if (args.length !== 1 || !args[0]) throw new Error("resolve requires exactly one reference");
  writeJson(write, parseRef(args[0]));
}

function frontier(args: string[], write: (text: string) => void): void {
  const flags = parseFlags(args);
  const input = flags.get("input");
  if (typeof input !== "string") {
    throw new Error("frontier currently requires --input with normalized ticket JSON");
  }
  const tickets = JSON.parse(readFileSync(input, "utf8")) as Ticket[];
  const scope = parseScope(value(flags, "scope"));
  const statuses = new Set(
    (value(flags, "available") ?? "To Do,Open").split(",").map((item) => item.trim()),
  );
  const result = evaluateFrontier(tickets, scope, { availableStatuses: statuses });
  if (flags.has("json")) {
    writeJson(write, { tickets: result, count: result.length });
    return;
  }
  for (const ticket of result) write(`${ticket.ref}\t${ticket.kind}\t${ticket.status}`);
}

async function adapter(args: string[], write: (text: string) => void): Promise<void> {
  const [subcommand, target] = args;
  if (subcommand === "list") return writeJson(write, builtInAdapters());
  if (subcommand === "describe" && target) return writeJson(write, findAdapter(target));
  if (subcommand === "test" && target) {
    const description = await new AdapterClient(adapterCommand(target)).initialize(
      "tracker",
      "conformance:test",
      VERSION,
    );
    return writeJson(write, { ok: true, adapter: description });
  }
  if (subcommand === "conformance" && target) {
    return writeJson(write, await runAdapterConformance(target, VERSION));
  }
  throw new Error(
    "adapter requires list, describe <name>, test <executable>, or conformance <fixture>",
  );
}

function adapterCommand(executable: string): string | string[] {
  return executable.endsWith(".ts") ? [process.execPath, executable] : executable;
}

function runs(args: string[], write: (text: string) => void, services: RuntimeServices): void {
  const [subcommand, target] = args;
  const store = openStore(services);
  try {
    if (subcommand === "list") {
      writeJson(write, store.listRuns());
      return;
    }
    if ((subcommand === "show" || subcommand === "export") && target) {
      const ref = runRef(target);
      const run = store.run(ref);
      writeJson(
        write,
        subcommand === "export"
          ? {
              run,
              claim: optional(() => store.claimForRun(ref)),
              steps: store.steps(ref),
              recovery: store.recoveryEvidence(ref),
            }
          : run,
      );
      return;
    }
    throw new Error("runs requires list, show <run>, or export <run>");
  } finally {
    store.close();
  }
}

async function stop(
  args: string[],
  write: (text: string) => void,
  services: RuntimeServices,
): Promise<void> {
  if (args.length !== 1 || !args[0]) throw new Error("stop requires exactly one run");
  if (!services.lifecycle) throw unavailableRuntime("stop", "managed lifecycle adapter");
  const store = openStore(services);
  try {
    const result = await new LifecycleCoordinator(store, undefined, services.lifecycle, {
      now: services.now ?? (() => new Date()),
    }).stop(runRef(args[0]));
    writeJson(write, result);
  } finally {
    store.close();
  }
}

async function recover(
  args: string[],
  write: (text: string) => void,
  services: RuntimeServices,
): Promise<void> {
  const [target, ...rest] = args;
  if (!target) throw new Error("recover requires a run");
  const flags = parseFlags(rest);
  const evidence = value(flags, "evidence");
  if (!evidence) throw new Error("recover requires --evidence <json>");
  if (!services.verifyRecovery) throw unavailableRuntime("recover", "recovery verifier");
  const store = openStore(services);
  try {
    const coordinator = new LifecycleCoordinator(
      store,
      undefined,
      services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
      {
        now: services.now ?? (() => new Date()),
      },
    );
    const parsed = JSON.parse(evidence);
    const result = await coordinator.recover(runRef(target), parsed, services.verifyRecovery);
    writeJson(write, result);
  } finally {
    store.close();
  }
}

async function claim(
  args: string[],
  write: (text: string) => void,
  services: RuntimeServices,
): Promise<void> {
  const [subcommand, target, ...rest] = args;
  if (!target || (subcommand !== "show" && subcommand !== "release")) {
    throw new Error("claim requires show <claim> or release <claim> --authorized-by <actor>");
  }
  const ref = (
    target.startsWith("wayfinder-claim:") ? target : `wayfinder-claim:${target}`
  ) as `wayfinder-claim:${string}`;
  if (subcommand === "release" && !services.tracker) {
    throw unavailableRuntime("claim release", "mutating tracker adapter");
  }
  const store = openStore(services);
  try {
    if (subcommand === "show") return writeJson(write, store.claim(ref));
    const authorizedBy = value(parseFlags(rest), "authorized-by");
    if (!authorizedBy) throw new Error("claim release requires --authorized-by <actor>");
    await new LifecycleCoordinator(
      store,
      services.tracker,
      services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
      { now: services.now ?? (() => new Date()) },
    ).release(ref, authorizedBy as import("./domain.ts").ActorRef);
    writeJson(write, store.claim(ref));
  } finally {
    store.close();
  }
}

async function supervisor(
  args: string[],
  write: (text: string) => void,
  services: RuntimeServices,
): Promise<void> {
  const [subcommand, target, ...rest] = args;
  if (!subcommand || !["status", "tick", "reconcile"].includes(subcommand)) {
    throw new Error("supervisor requires status, tick, or reconcile <run> --evidence <json>");
  }
  const tracker = services.tracker;
  const lifecycle = services.lifecycle;
  const verifyAttention = services.verifyAttention;
  if (subcommand === "tick" && (!tracker || !lifecycle)) {
    throw unavailableRuntime("supervisor tick", "tracker and managed lifecycle adapters");
  }
  if (subcommand === "reconcile" && !verifyAttention) {
    throw unavailableRuntime("supervisor reconcile", "attention verifier");
  }
  const store = openStore(services);
  try {
    if (subcommand === "tick") {
      if (!tracker || !lifecycle) throw new Error("Supervisor services were not composed");
      return writeJson(
        write,
        await new Supervisor({
          store,
          tracker,
          lifecycle,
          clock: { now: services.now ?? (() => new Date()) },
        }).tick(),
      );
    }
    if (subcommand === "reconcile") {
      if (!verifyAttention) throw new Error("Attention verifier was not composed");
      if (!target) {
        throw unavailableRuntime("supervisor reconcile", "attention verifier");
      }
      const evidence = value(parseFlags(rest), "evidence");
      if (!evidence) throw new Error("supervisor reconcile requires --evidence <json>");
      const ref = runRef(target);
      const verified = await verifyAttention(store.run(ref), JSON.parse(evidence));
      return writeJson(
        write,
        new LifecycleCoordinator(
          store,
          services.tracker,
          services.lifecycle ?? (() => new ProcessLifecycleAdapter()),
          { now: services.now ?? (() => new Date()) },
        ).reconcileAttention(ref, verified.observation, verified.claim),
      );
    }
    writeJson(write, {
      supervisor: store.supervisorStatus(),
      active: store.activeRuns(),
      attentionRequired: store.listRuns().filter((run) => run.status === "attention_required"),
    });
  } finally {
    store.close();
  }
}

function openStore(services: RuntimeServices): StateStore {
  const path = services.statePath ?? databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return new StateStore(path);
}

function runRef(value: string): `wayfinder-run:${string}` {
  return (
    value.startsWith("wayfinder-run:") ? value : `wayfinder-run:${value}`
  ) as `wayfinder-run:${string}`;
}

function optional<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function unavailableRuntime(command: string, requirement: string): Error {
  return new Error(
    `${command} is unavailable in this binary: no ${requirement} is composed; use a runtime that explicitly provides it`,
  );
}

function parseScope(raw: string | undefined): FrontierScope {
  if (!raw) return {};
  const parsed = parseRef(raw);
  if (parsed.kind === "workspace") return { workspace: parsed.raw as WorkspaceRef };
  if (parsed.kind === "group") return { group: parsed.raw as GroupRef };
  if (parsed.kind === "map") return { map: parsed.raw as MapRef };
  if (parsed.kind === "ticket") return { ticket: parsed.raw as TicketRef };
  throw new Error(`${raw} is not a frontier scope`);
}

function parseFlags(args: string[]): Map<string, string | true> {
  const result = new Map<string, string | true>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!argument?.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith("--")) {
      result.set(name, next);
      index += 1;
    } else {
      result.set(name, true);
    }
  }
  return result;
}

function value(flags: Map<string, string | true>, key: string): string | undefined {
  const item = flags.get(key);
  return typeof item === "string" ? item : undefined;
}

function writeJson(write: (text: string) => void, data: unknown): void {
  write(JSON.stringify(data, null, 2));
}

if (import.meta.main) {
  run(Bun.argv.slice(2)).catch((error: unknown) => {
    console.error(`wayfinder: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
