// PROTOTYPE (JWB-325) — throwaway CLI. One invocation = one real OS process
// acting as one role, making one guarded change to the shared durable store.
//
// The evidence harness spawns this file as genuinely separate `bun` processes so
// that "orchestrator restart" and "supervisor restart" mean what they say: a new
// PID re-attaching to the same SQLite file, with no in-memory state carried over.
//
// Usage (all commands print exactly one JSON envelope line to stdout):
//   bun lane-actor.ts create   --db P --lane L --ticket T --as orchestrator:alice
//   bun lane-actor.ts report   --db P --lane L --event running --as worker:w1:L
//   bun lane-actor.ts service  --db P --lane L --name web --port 3000 --as worker:w1:L
//   bun lane-actor.ts artifact --db P --lane L --ref pr/12 --as worker:w1:L
//   bun lane-actor.ts drive    --db P --lane L --event revision_requested --as orchestrator:alice
//   bun lane-actor.ts policy   --db P --key merge --value blocked --as worker:w1:L
//   bun lane-actor.ts status   --db P --lane L
//   bun lane-actor.ts reconcile --db P --lane L --as supervisor:s1

import type { LaneAuthority, LaneEvent, LaneEventKind, LaneRole } from "./lane-protocol.ts";
import { LaneStore } from "./lane-store.ts";

type Args = Record<string, string>;

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token?.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[i + 1];
      if (value !== undefined && !value.startsWith("--")) {
        args[key] = value;
        i += 1;
      } else {
        args[key] = "true";
      }
    }
  }
  return args;
}

/**
 * Parse `role:principal[:laneScope]` into a credential. Only the first two
 * colons are separators, because a laneScope (e.g. `wf-lane:JWB-325-demo`) may
 * itself contain colons.
 */
function parseAuthority(spec: string | undefined): LaneAuthority {
  if (!spec) throw new Error("missing --as credential");
  const firstColon = spec.indexOf(":");
  if (firstColon === -1) throw new Error(`malformed credential: ${spec}`);
  const role = spec.slice(0, firstColon);
  const remainder = spec.slice(firstColon + 1);
  if (role !== "worker" && role !== "orchestrator" && role !== "supervisor") {
    throw new Error(`unknown role: ${role}`);
  }
  const secondColon = remainder.indexOf(":");
  const principal = secondColon === -1 ? remainder : remainder.slice(0, secondColon);
  const laneScope = secondColon === -1 ? undefined : remainder.slice(secondColon + 1);
  if (!principal) throw new Error("credential requires a principal");
  const authority: LaneAuthority = { principal, role: role as LaneRole };
  if (laneScope) return { ...authority, laneScope };
  return authority;
}

function print(envelope: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ pid: process.pid, ...envelope })}\n`);
}

const EVENT_KIND: Record<string, LaneEventKind> = {
  running: "lane.running",
  blocked: "lane.blocked",
  ready_for_validation: "lane.ready_for_validation",
  stopped: "lane.stopped",
  preparing: "lane.preparing",
  validating: "lane.validating",
  ready_for_review: "lane.ready_for_review",
  revision_requested: "lane.revision_requested",
  reviewing: "lane.reviewing",
  approved: "lane.approved",
  human_ready: "lane.human_ready",
  completed: "lane.completed",
  failed: "lane.failed",
};

function now(): string {
  return new Date().toISOString();
}

function main(): number {
  const [command, ...rest] = Bun.argv.slice(2);
  const args = parseArgs(rest);
  const dbPath = args.db;
  if (!command || !dbPath) {
    print({ ok: false, reason: "usage: lane-actor <command> --db <path> ..." });
    return 1;
  }
  const store = new LaneStore(dbPath);
  try {
    switch (command) {
      case "create": {
        const authority = parseAuthority(args.as);
        const event: LaneEvent = {
          kind: "lane.created",
          lane: required(args.lane, "--lane"),
          at: now(),
          actor: authority.principal,
          role: authority.role,
          ticket: required(args.ticket, "--ticket"),
        };
        return emit(store.append(event, authority), command);
      }
      case "report":
      case "drive": {
        const authority = parseAuthority(args.as);
        const kind = EVENT_KIND[required(args.event, "--event")];
        if (!kind) throw new Error(`unknown --event ${args.event}`);
        const event: LaneEvent = {
          kind,
          lane: required(args.lane, "--lane"),
          at: now(),
          actor: authority.principal,
          role: authority.role,
          ...(args.reason ? { reason: args.reason } : {}),
        };
        return emit(store.append(event, authority), command);
      }
      case "service": {
        const authority = parseAuthority(args.as);
        const event: LaneEvent = {
          kind: "lane.service_announced",
          lane: required(args.lane, "--lane"),
          at: now(),
          actor: authority.principal,
          role: authority.role,
          service: {
            name: required(args.name, "--name"),
            port: Number(required(args.port, "--port")),
          },
        };
        return emit(store.append(event, authority), command);
      }
      case "artifact": {
        const authority = parseAuthority(args.as);
        const event: LaneEvent = {
          kind: "lane.artifact_added",
          lane: required(args.lane, "--lane"),
          at: now(),
          actor: authority.principal,
          role: authority.role,
          artifact: { ref: required(args.ref, "--ref"), ...(args.kind ? { kind: args.kind } : {}) },
        };
        return emit(store.append(event, authority), command);
      }
      case "policy": {
        const authority = parseAuthority(args.as);
        const result = store.setPolicy(
          required(args.key, "--key"),
          args.value ?? "true",
          authority,
          now(),
        );
        print({ command, ...result });
        return result.ok ? 0 : 3;
      }
      case "status": {
        const record = store.project(required(args.lane, "--lane"));
        if (!record) {
          print({ ok: false, command, reason: `no lane ${args.lane}` });
          return 4;
        }
        print({ ok: true, command, record, events: store.events(record.lane).length });
        return 0;
      }
      case "reconcile": {
        // A supervisor re-attaches to the durable store and verifies the same
        // active lane. It only mutates when the lane needs recovery; a healthy
        // lane is verified without a transition, proving safe re-attachment.
        const authority = parseAuthority(args.as);
        const lane = required(args.lane, "--lane");
        const record = store.project(lane);
        if (!record) {
          print({ ok: false, command, reason: `no lane ${lane}` });
          return 4;
        }
        if (record.state === "attention_required" || record.state === "recovery_required") {
          const event: LaneEvent = {
            kind: "lane.reconciled",
            lane,
            at: now(),
            actor: authority.principal,
            role: authority.role,
          };
          const result = store.append(event, authority);
          print({ command, outcome: "recovered", supervisor: authority.principal, ...result });
          return result.ok ? 0 : 3;
        }
        print({
          ok: true,
          command,
          outcome: "verified_healthy",
          supervisor: authority.principal,
          lane: record.lane,
          state: record.state,
          version: record.version,
        });
        return 0;
      }
      default:
        print({ ok: false, reason: `unknown command ${command}` });
        return 1;
    }
  } catch (error) {
    print({ ok: false, command, reason: error instanceof Error ? error.message : String(error) });
    return 1;
  } finally {
    store.close();
  }
}

function required(value: string | undefined, flag: string): string {
  if (value === undefined) throw new Error(`missing ${flag}`);
  return value;
}

function emit(
  result: { ok: boolean; record?: unknown; code?: string; reason?: string },
  command: string,
): number {
  print({ command, ...result });
  return result.ok ? 0 : 3;
}

process.exit(main());
