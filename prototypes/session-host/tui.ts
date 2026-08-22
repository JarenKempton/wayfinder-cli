#!/usr/bin/env bun
// PROTOTYPE (JWB-332) — throwaway interactive shell. Not the keeper.
//
// Pushes the session-host state model through cases that are awkward to reason
// about on paper: bind on either host, observe, steer (accepted on T3, rejected
// on native), re-attach, and — the important one — press "x" to SIMULATE a
// control-surface restart. That drops every in-memory handle, reopens the store,
// and re-projects the mapping purely from the durable log. The lane survives.

import { unlinkSync } from "node:fs";

import { UnsupportedCapabilityError } from "../../src/domain.ts";
import type { SessionRecord } from "./session-host-protocol.ts";
import { buildHosts } from "./session-hosts.ts";
import { HostRegistry, SessionStore } from "./session-store.ts";

const DB = `${import.meta.dir}/.tui.db`;
const LANE = "tui-lane";

function now(): string {
  return new Date().toISOString();
}

function cleanup(): void {
  for (const suffix of ["", "-shm", "-wal"]) {
    try {
      unlinkSync(`${DB}${suffix}`);
    } catch {
      // fine
    }
  }
}

interface World {
  store: SessionStore;
  registry: HostRegistry;
  hosts: ReturnType<typeof buildHosts>;
}

function open(): World {
  const store = new SessionStore(DB);
  const registry = new HostRegistry(DB);
  return { store, registry, hosts: buildHosts(registry) };
}

let world = open();
let banner = "ready";

function render(): void {
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  const record: SessionRecord | undefined = world.store.project(LANE);
  console.log("╭─ JWB-332 session-host prototype ───────────────────────────╮");
  console.log(`│ lane: ${LANE}`);
  console.log("╰────────────────────────────────────────────────────────────╯\n");

  if (!record) {
    console.log("  (no session bound yet)\n");
  } else {
    const host = world.registry.get(record.host, record.sessionId);
    console.log(`  host        ${record.host}`);
    console.log(`  sessionId   ${record.sessionId}`);
    console.log(
      `  agent       ${record.agent.agent}${record.agent.model ? ` (${record.agent.model})` : ""}`,
    );
    console.log(`  lifecycle   ${record.lifecycle}`);
    console.log(`  version     ${record.version}   last=${record.lastEventKind}`);
    console.log(`  steerings   ${record.steerings.length ? record.steerings.join(" | ") : "—"}`);
    console.log(`  detach/re   ${record.detachments} / ${record.reattachments}`);
    if (host) console.log(`  host inbox  ${host.inbox.length ? host.inbox.join(" | ") : "—"}`);
    console.log("");
  }

  console.log(`  » ${banner}\n`);
  console.log("  [t] bind T3   [n] bind native   [o] observe   [s] steer");
  console.log("  [r] reattach  [x] simulate restart              [q] quit");
}

async function bind(host: "native" | "t3", agent: string, model: string): Promise<void> {
  if (world.store.project(LANE)) {
    banner =
      "already bound — press x to restart with a fresh mapping is not possible; quit to reset";
    return;
  }
  const invocation = { agent, argv: ["sleep", "5"], cwd: process.cwd(), model };
  const requested = world.store.append({
    kind: "session.requested",
    lane: LANE,
    at: now(),
    actor: "tui",
    host,
    agent: invocation,
  });
  if (!requested.ok) {
    banner = `bind rejected: ${requested.reason}`;
    return;
  }
  const handle = await world.hosts[host].create(LANE, invocation);
  world.store.append({
    kind: "session.bound",
    lane: LANE,
    at: now(),
    actor: "tui",
    host,
    sessionId: handle.sessionId,
    agent: invocation,
  });
  banner = `bound on ${host}: ${handle.sessionId}`;
}

async function observe(): Promise<void> {
  const record = world.store.project(LANE);
  if (!record) {
    banner = "nothing to observe";
    return;
  }
  const lifecycle = await world.hosts[record.host].observe(record.sessionId);
  world.store.append({
    kind: "session.observed",
    lane: LANE,
    at: now(),
    actor: "tui",
    lifecycle,
    detail: "tui observe",
  });
  banner = `observed: ${lifecycle}`;
}

async function steer(): Promise<void> {
  const record = world.store.project(LANE);
  if (!record) {
    banner = "nothing to steer";
    return;
  }
  try {
    await world.hosts[record.host].steer(record.sessionId, "revise: tighten the boundary");
  } catch (error) {
    if (error instanceof UnsupportedCapabilityError) {
      banner = `steer rejected on ${record.host}: missing ${error.missing.join(", ")}`;
      return;
    }
    throw error;
  }
  world.store.append({
    kind: "session.steered",
    lane: LANE,
    at: now(),
    actor: "tui",
    instruction: "revise: tighten the boundary",
  });
  banner = "steering delivered to the same session";
}

async function reattach(): Promise<void> {
  const record = world.store.project(LANE);
  if (!record) {
    banner = "nothing to reattach";
    return;
  }
  const handle = await world.hosts[record.host].reattach(record.sessionId);
  if (!handle) {
    banner = "host could not re-attach";
    return;
  }
  world.store.append({ kind: "session.reattached", lane: LANE, at: now(), actor: "tui" });
  banner = `re-attached ${handle.sessionId}`;
}

function simulateRestart(): void {
  // Drop everything held in this process and rebuild from the durable log only.
  world.store.close();
  world.registry.close();
  world = open();
  const record = world.store.project(LANE);
  banner = record
    ? `restarted control surface — recovered ${record.host} session ${record.sessionId} from the log`
    : "restarted — no durable mapping found";
}

function quit(): never {
  cleanup();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  console.log("session left durable in the log; scratch db wiped. bye.\n");
  process.exit(0);
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY) {
    console.log(
      "tui.ts needs an interactive TTY. Run `bun run proto:session:demo` for the evidence harness.",
    );
    process.exit(0);
  }
  cleanup();
  world = open();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  render();

  for await (const chunk of process.stdin) {
    const key = String(chunk);
    if (key === "q" || key === "") quit();
    switch (key) {
      case "t":
        await bind("t3", "claude", "sonnet");
        break;
      case "n":
        await bind("native", "codex", "o3");
        break;
      case "o":
        await observe();
        break;
      case "s":
        await steer();
        break;
      case "r":
        await reattach();
        break;
      case "x":
        simulateRestart();
        break;
      default:
        banner = `unbound key: ${JSON.stringify(key)}`;
    }
    render();
  }
}

await main();
