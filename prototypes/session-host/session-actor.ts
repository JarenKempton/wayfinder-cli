#!/usr/bin/env bun
// PROTOTYPE (JWB-332) — throwaway CLI. Not the keeper.
//
// One invocation = one OS process = one guarded change to the durable session
// mapping. Every command prints exactly one JSON envelope (with this process's
// pid) as its last stdout line, so the evidence demo can prove that genuinely
// distinct processes share the same durable lane<->session mapping.
//
// Commands:
//   bind        create+identify a session on a host for an agent (genesis + bound)
//   observe     recover the mapping, observe lifecycle (no scraping), log it
//   steer       recover the mapping, deliver a steering instruction (capability-gated)
//   reattach    recover the mapping from a FRESH process and re-attach
//   run-native  launch a real native process and settle it from its real exit code
//   select      resolve which host to use (optionality / fallback / fail-closed)
//   status      print the recovered mapping + host-side session state

import {
  CAPABILITIES,
  type Capability,
  type CapabilitySet,
  UnsupportedCapabilityError,
} from "../../src/domain.ts";
import {
  type AgentInvocation,
  capabilitiesForNative,
  capabilitiesForSimulatedT3,
  type SessionEvent,
  type SessionHostCandidate,
  type SessionHostKind,
  selectSessionHost,
} from "./session-host-protocol.ts";
import {
  buildHosts,
  type NativeSessionHost,
  probeRealT3Surface,
  type T3SessionHost,
} from "./session-hosts.ts";
import { HostRegistry, SessionStore } from "./session-store.ts";

type Args = Map<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

function require(args: Args, key: string): string {
  const value = args.get(key);
  if (value === undefined) throw new Error(`missing --${key}`);
  return value;
}

function print(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...envelope })}\n`);
}

function now(): string {
  return new Date().toISOString();
}

function agentInvocation(name: string, argv: string[], model: string | undefined): AgentInvocation {
  return { agent: name, argv, cwd: process.cwd(), ...(model ? { model } : {}) };
}

function parseCaps(csv: string): CapabilitySet {
  const set: CapabilitySet = {};
  for (const raw of csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (!(CAPABILITIES as readonly string[]).includes(raw)) {
      throw new Error(`unknown capability: ${raw}`);
    }
    set[raw as Capability] = true;
  }
  return set;
}

function hostAdapter(
  kind: SessionHostKind,
  hosts: { native: NativeSessionHost; t3: T3SessionHost },
): NativeSessionHost | T3SessionHost {
  return kind === "native" ? hosts.native : hosts.t3;
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);

  if (!command) {
    print({ ok: false, error: "usage: session-actor <command> [--flags]" });
    return 2;
  }

  // select is pure — it needs no durable store.
  if (command === "select") {
    const preferred = require(args, "host") as SessionHostKind;
    const required = args.get("required") === "true";
    const requiredCapabilities = parseCaps(args.get("need") ?? "");
    const t3Mode = args.get("t3-mode") ?? "real";
    const t3Candidate: SessionHostCandidate =
      t3Mode === "simulated"
        ? {
            kind: "t3",
            provisioned: true,
            capabilities: capabilitiesForSimulatedT3(),
            simulated: true,
          }
        : probeRealT3Surface();
    const catalog: SessionHostCandidate[] = [
      { kind: "native", provisioned: true, capabilities: capabilitiesForNative() },
      t3Candidate,
    ];
    const selection = selectSessionHost({ preferred, required, requiredCapabilities }, catalog);
    print({
      ok: selection.ok,
      command,
      request: { preferred, required, need: Object.keys(requiredCapabilities) },
      catalog: catalog.map((c) => ({
        kind: c.kind,
        provisioned: c.provisioned,
        capabilities: Object.keys(c.capabilities),
        ...(c.simulated ? { simulated: true } : {}),
        ...(c.note ? { note: c.note } : {}),
      })),
      selection,
    });
    return selection.ok ? 0 : 3;
  }

  const dbPath = require(args, "db");
  const store = new SessionStore(dbPath);
  const registry = new HostRegistry(dbPath);
  const hosts = buildHosts(registry);

  try {
    switch (command) {
      case "bind": {
        const lane = require(args, "lane");
        const host = require(args, "host") as SessionHostKind;
        const agentName = require(args, "agent");
        const model = args.get("model");
        const linger = args.get("linger") ?? "2";
        const agent = agentInvocation(agentName, ["sleep", linger], model);

        const genesis: SessionEvent = {
          kind: "session.requested",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          host,
          agent,
        };
        const requested = store.append(genesis);
        if (!requested.ok) {
          print({ ok: false, command, lane, code: requested.code, reason: requested.reason });
          return 3;
        }

        const handle = await hostAdapter(host, hosts).create(lane, agent);
        const bound = store.append({
          kind: "session.bound",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          host,
          sessionId: handle.sessionId,
          agent,
        });
        if (!bound.ok) {
          print({ ok: false, command, lane, code: bound.code, reason: bound.reason });
          return 3;
        }
        print({
          ok: true,
          command,
          lane,
          host,
          sessionId: handle.sessionId,
          agent,
          record: bound.record,
        });
        return 0;
      }

      case "observe": {
        const lane = require(args, "lane");
        const record = store.project(lane);
        if (!record) {
          print({ ok: false, command, lane, reason: "no session mapping recovered" });
          return 3;
        }
        const lifecycle = await hostAdapter(record.host, hosts).observe(record.sessionId);
        const hostSession = registry.get(record.host, record.sessionId);
        const detail = hostSession?.detail ?? "observed";
        const observed = store.append({
          kind: "session.observed",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          lifecycle,
          detail,
        });
        if (!observed.ok) {
          print({ ok: false, command, lane, code: observed.code, reason: observed.reason });
          return 3;
        }
        print({
          ok: true,
          command,
          lane,
          host: record.host,
          sessionId: record.sessionId,
          lifecycle,
          detail,
          record: observed.record,
        });
        return 0;
      }

      case "steer": {
        const lane = require(args, "lane");
        const instruction = require(args, "instruction");
        const record = store.project(lane);
        if (!record) {
          print({ ok: false, command, lane, reason: "no session mapping recovered" });
          return 3;
        }
        try {
          await hostAdapter(record.host, hosts).steer(record.sessionId, instruction);
        } catch (error) {
          if (error instanceof UnsupportedCapabilityError) {
            print({
              ok: false,
              command,
              lane,
              host: record.host,
              accepted: false,
              code: error.code,
              missing: error.missing,
              reason: `${record.host} cannot verify steering`,
            });
            return 3;
          }
          throw error;
        }
        const steered = store.append({
          kind: "session.steered",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          instruction,
        });
        if (!steered.ok) {
          print({ ok: false, command, lane, code: steered.code, reason: steered.reason });
          return 3;
        }
        print({
          ok: true,
          command,
          lane,
          host: record.host,
          sessionId: record.sessionId,
          accepted: true,
          instruction,
          steerings: steered.record.steerings,
        });
        return 0;
      }

      case "reattach": {
        const lane = require(args, "lane");
        const record = store.project(lane);
        if (!record) {
          print({ ok: false, command, lane, reason: "no session mapping recovered" });
          return 3;
        }
        const handle = await hostAdapter(record.host, hosts).reattach(record.sessionId);
        if (!handle) {
          print({ ok: false, command, lane, reason: "host could not re-attach session" });
          return 3;
        }
        const reattached = store.append({
          kind: "session.reattached",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
        });
        if (!reattached.ok) {
          print({ ok: false, command, lane, code: reattached.code, reason: reattached.reason });
          return 3;
        }
        print({
          ok: true,
          command,
          lane,
          host: record.host,
          sessionId: handle.sessionId,
          agent: handle.agent,
          reattachments: reattached.record.reattachments,
        });
        return 0;
      }

      case "run-native": {
        const lane = require(args, "lane");
        const agentName = require(args, "agent");
        const model = args.get("model");
        const outcome = args.get("outcome") ?? "ok";
        const argv = outcome === "ok" ? ["true"] : ["false"];
        const agent = agentInvocation(agentName, argv, model);

        const requested = store.append({
          kind: "session.requested",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          host: "native",
          agent,
        });
        if (!requested.ok) {
          print({ ok: false, command, lane, code: requested.code, reason: requested.reason });
          return 3;
        }
        const handle = await hosts.native.create(lane, agent);
        store.append({
          kind: "session.bound",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          host: "native",
          sessionId: handle.sessionId,
          agent,
        });
        // Real exit code -> lifecycle. No terminal scraping.
        const lifecycle = await hosts.native.settle(handle.sessionId);
        const hostSession = registry.get("native", handle.sessionId);
        const observed = store.append({
          kind: "session.observed",
          lane,
          at: now(),
          actor: `pid:${process.pid}`,
          lifecycle,
          detail: hostSession?.detail ?? "settled",
        });
        if (!observed.ok) {
          print({ ok: false, command, lane, code: observed.code, reason: observed.reason });
          return 3;
        }
        print({
          ok: true,
          command,
          lane,
          host: "native",
          sessionId: handle.sessionId,
          outcome,
          lifecycle,
          detail: hostSession?.detail,
          record: observed.record,
        });
        return 0;
      }

      case "status": {
        const lane = require(args, "lane");
        const record = store.project(lane);
        if (!record) {
          print({ ok: false, command, lane, reason: "no session mapping recovered" });
          return 3;
        }
        const hostSession = registry.get(record.host, record.sessionId);
        print({
          ok: true,
          command,
          lane,
          record,
          hostSession: hostSession
            ? {
                lifecycle: hostSession.lifecycle,
                detail: hostSession.detail,
                inbox: hostSession.inbox,
                pid: hostSession.pid,
              }
            : null,
        });
        return 0;
      }

      default:
        print({ ok: false, error: `unknown command: ${command}` });
        return 2;
    }
  } finally {
    store.close();
    registry.close();
  }
}

process.exit(await main());
