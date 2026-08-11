#!/usr/bin/env bun

import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { builtInAdapters, findAdapter } from "./adapters.ts";
import { runAdapterConformance } from "./conformance.ts";
import type { GroupRef, MapRef, Ticket, TicketRef, WorkspaceRef } from "./domain.ts";
import { evaluateFrontier, type FrontierScope } from "./frontier.ts";
import { databasePath } from "./paths.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import { parseRef } from "./reference.ts";
import { StateStore } from "./state.ts";

export const VERSION = "0.1.0-dev";

export async function run(
  args: string[],
  write: (text: string) => void = console.log,
): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      write(usage());
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
    case "adapter":
      return adapter(rest, write);
    case "runs":
      return runs(rest, write);
    case "pickup":
    case "claim":
    case "recover":
    case "resume":
    case "stop":
    case "workspace":
    case "supervisor":
    case "init":
    case "config":
      throw new Error(
        `${command} is reserved by the stable contract but is not implemented safely in this pre-release`,
      );
    default:
      throw new Error(`Unknown command: ${JSON.stringify(command)}`);
  }
}

function usage(): string {
  return `Wayfinder — portable work orchestration for agents

Usage:
  wayfinder doctor
  wayfinder resolve <qualified-reference>
  wayfinder frontier --input <tickets.json> [--scope <ref>] [--available "To Do,Open"] [--json]
  wayfinder adapter list
  wayfinder adapter describe <name>
  wayfinder adapter test <executable>
  wayfinder runs list
  wayfinder runs show <run-id>
  wayfinder runs export <run-id>
  wayfinder version`;
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
    return writeJson(write, await runAdapterConformance(target));
  }
  throw new Error("adapter requires list, describe <name>, or test <executable>");
}

function runs(args: string[], write: (text: string) => void): void {
  const [subcommand, target] = args;
  const path = databasePath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const store = new StateStore(path);
  try {
    if (subcommand === "list") {
      writeJson(write, store.listRuns());
      return;
    }
    if ((subcommand === "show" || subcommand === "export") && target) {
      const ref = (
        target.startsWith("wayfinder-run:") ? target : `wayfinder-run:${target}`
      ) as `wayfinder-run:${string}`;
      writeJson(write, store.run(ref));
      return;
    }
    throw new Error("runs requires list, show <run>, or export <run>");
  } finally {
    store.close();
  }
}

function parseScope(raw: string | undefined): FrontierScope {
  if (!raw) return {};
  const parsed = parseRef(raw);
  if (parsed.kind === "workspace") return { workspace: raw as WorkspaceRef };
  if (parsed.kind === "group") return { group: raw as GroupRef };
  if (parsed.kind === "map") return { map: raw as MapRef };
  if (parsed.kind === "ticket") return { ticket: raw as TicketRef };
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
