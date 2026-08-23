// PROTOTYPE — JWB-329. Throwaway shell. This half is deliberately NOT liftable:
// it is real docker/git I/O modelling the EnvironmentAdapter contract
// (preflight/plan/start/verifyReady/resume/stop) against a container isolation
// boundary. The liftable half is ./lane-machine.ts. See ./README.md.
//
// Fidelity notes (ADR 0001):
//   §6  the sandbox-private clone has NO writable host-repository access.
//   §7  the agent process runs INSIDE the sandbox; the host never `docker exec`s
//       agent work — it observes through one narrow channel (container stdout via
//       `docker logs`) plus the one published dev-server port.
//   §15 the workspace handle ("/workspace") is a path in the SANDBOX frame of
//       reference, materialized by the adapter, not a host path.

import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneEvent } from "./lane-machine.ts";

const IMAGE = "alpine:3"; // present locally; busybox `nc`, no host tooling needed inside.

export interface Exec {
  code: number;
  stdout: string;
  stderr: string;
}

/** argv-only spawn (AGENTS.md: never compose host shell strings). */
export async function exec(argv: readonly string[]): Promise<Exec> {
  const proc = Bun.spawn({ cmd: argv as string[], stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

/** Reserve a collision-free host loopback port from the OS, then release it. */
export function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("no port")));
      }
    });
  });
}

/**
 * The host-side control plane: an append-only JSONL log. This is the durable
 * coordination truth — NOT chat, NOT anything inside the sandbox. A fresh
 * process reads it back and folds (see project()) to re-derive lane state.
 */
export class ControlPlane {
  constructor(readonly logPath: string) {}
  async append(event: LaneEvent): Promise<void> {
    const prior = (await Bun.file(this.logPath).exists())
      ? await Bun.file(this.logPath).text()
      : "";
    await Bun.write(this.logPath, `${prior}${JSON.stringify(event)}\n`);
  }
  async read(): Promise<LaneEvent[]> {
    if (!(await Bun.file(this.logPath).exists())) return [];
    const text = await Bun.file(this.logPath).text();
    return text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LaneEvent);
  }
}

/** The agent program that runs INSIDE the sandbox (§7). Pure string; no host effects. */
function agentScript(laneId: string): string {
  // Emits structured JSONL to stdout (the narrow bridge), does real work in the
  // private clone, probes for host/global-credential leakage from the inside,
  // then blocks serving the dev server on :8080.
  return [
    "set -e",
    `LANE=${laneId}`,
    'emit() { printf "{\\"lane\\":\\"%s\\",\\"event\\":\\"%s\\",\\"detail\\":\\"%s\\"}\\n" "$LANE" "$1" "$2"; }',
    'emit agent_boot "cwd=$(pwd)"',
    "cd /workspace",
    // Prove we are operating on the sandbox-private clone.
    'emit clone_head "$(cat .git/HEAD 2>/dev/null || echo no-git)"',
    // Do real work in the private workspace + run a validation command.
    'echo "lane $LANE did work at $(date -u +%s)" > LANE_WORK.txt',
    'if [ -f package.json ]; then emit validation "package.json present -> VALIDATION_OK"; else emit validation "MISSING"; fi',
    'emit workdir_change "$(ls LANE_WORK.txt)"',
    // Isolation probes FROM INSIDE the sandbox. All host paths must be absent.
    'for p in "$HOST_SECRET_PATH" "$HOST_HOME_CRED" /root/.wayfinder/credentials "$HOST_UNRELATED"; do',
    '  if [ -n "$p" ] && [ -e "$p" ]; then emit leak "READABLE:$p"; else emit isolation "absent:$p"; fi',
    "done",
    // Announce the endpoint, then serve it (blocking) — the one narrow inbound port.
    'emit service_listening "port=8080"',
    "while true; do",
    '  BODY="{\\"lane\\":\\"$LANE\\",\\"status\\":\\"serving\\"}"',
    '  LEN=$(printf "%s" "$BODY" | wc -c)',
    '  printf "HTTP/1.1 200 OK\\r\\nContent-Type: application/json\\r\\nContent-Length: %s\\r\\nConnection: close\\r\\n\\r\\n%s" "$LEN" "$BODY" | nc -l -p 8080 || true',
    "done",
  ].join("\n");
}

export interface StagedClone {
  hostStagingDir: string;
  sourceRef: string;
}

/** Host clones the lane's worktree into private staging (offline, local). */
export async function stagePrivateClone(worktreePath: string): Promise<StagedClone> {
  const staging = await mkdtemp(join(tmpdir(), "jwb329-clone-"));
  const dest = join(staging, "clone");
  const head = (await exec(["git", "-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  const clone = await exec(["git", "clone", "--quiet", `file://${worktreePath}/.git`, dest]);
  if (clone.code !== 0) throw new Error(`clone failed: ${clone.stderr}`);
  return { hostStagingDir: staging, sourceRef: head };
}

export interface CreatedSandbox {
  sandboxId: string;
  hostPort: number;
  workspaceHandle: string;
}

/**
 * Materialize the sandbox: create the agent container (agent script baked as its
 * command so it runs *inside* on start), then copy the private clone into
 * /workspace. No host bind-mount is used, so the container has no host FS access.
 */
export async function createSandbox(
  laneId: string,
  staging: StagedClone,
  probes: { hostSecretPath: string; hostHomeCred: string; hostUnrelated: string },
): Promise<CreatedSandbox> {
  const hostPort = await freeLoopbackPort();
  const name = `jwb329-${laneId}`;
  const create = await exec([
    "docker",
    "create",
    "--name",
    name,
    "-p",
    `127.0.0.1:${hostPort}:8080`,
    // Deliberately pass NO secrets; only path *names* to probe, never values.
    "-e",
    `HOST_SECRET_PATH=${probes.hostSecretPath}`,
    "-e",
    `HOST_HOME_CRED=${probes.hostHomeCred}`,
    "-e",
    `HOST_UNRELATED=${probes.hostUnrelated}`,
    IMAGE,
    "sh",
    "-c",
    agentScript(laneId),
  ]);
  if (create.code !== 0) throw new Error(`docker create failed: ${create.stderr}`);
  const sandboxId = create.stdout.trim().slice(0, 12);
  // Materialize the private clone INTO the sandbox (§15). `.` copies contents.
  const cp = await exec([
    "docker",
    "cp",
    `${join(staging.hostStagingDir, "clone")}/.`,
    `${sandboxId}:/workspace`,
  ]);
  if (cp.code !== 0) throw new Error(`docker cp failed: ${cp.stderr}`);
  return { sandboxId, hostPort, workspaceHandle: "/workspace" };
}

export async function startSandbox(sandboxId: string): Promise<Exec> {
  return exec(["docker", "start", sandboxId]);
}

/** Read the agent's structured lines from the narrow stdio bridge (§7). */
export async function sandboxLogs(sandboxId: string): Promise<string[]> {
  const logs = await exec(["docker", "logs", sandboxId]);
  return `${logs.stdout}\n${logs.stderr}`
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"));
}

export async function sandboxRunning(sandboxId: string): Promise<boolean> {
  const r = await exec(["docker", "inspect", "-f", "{{.State.Running}}", sandboxId]);
  return r.code === 0 && r.stdout.trim() === "true";
}

/** verifyReady / endpoint probe from the host side. */
export async function endpointAnswers(hostPort: number): Promise<{ ok: boolean; body: string }> {
  try {
    const res = await fetch(`http://127.0.0.1:${hostPort}/`, {
      signal: AbortSignal.timeout(3000),
    });
    const body = await res.text();
    return { ok: res.ok, body };
  } catch (err) {
    return { ok: false, body: String(err) };
  }
}

/** Idempotent, receipt-scoped stop: only stop the exact owned container id. */
export async function stopSandbox(sandboxId: string): Promise<{ changed: boolean }> {
  const running = await sandboxRunning(sandboxId);
  if (!running) return { changed: false };
  await exec(["docker", "stop", "-t", "1", sandboxId]);
  return { changed: true };
}

/** Teardown removes the sandbox + private staging only. Never the host worktree. */
export async function teardown(
  sandboxId: string | null,
  stagingDir: string | null,
): Promise<string[]> {
  const removed: string[] = [];
  if (sandboxId) {
    const r = await exec(["docker", "rm", "-f", sandboxId]);
    if (r.code === 0) removed.push(`container:${sandboxId}`);
  }
  if (stagingDir) {
    await rm(stagingDir, { recursive: true, force: true });
    removed.push(`staging:${stagingDir}`);
  }
  return removed;
}

/** A content signature of the host worktree, to prove it is byte-for-byte unchanged. */
export async function worktreeSignature(worktreePath: string): Promise<string> {
  const head = (await exec(["git", "-C", worktreePath, "rev-parse", "HEAD"])).stdout.trim();
  const status = (await exec(["git", "-C", worktreePath, "status", "--porcelain"])).stdout.trim();
  const tracked = (await exec(["git", "-C", worktreePath, "ls-files", "-s"])).stdout;
  const hash = new Bun.CryptoHasher("sha256")
    .update(`${head}\n${status}\n${tracked}`)
    .digest("hex");
  return `${head}:${hash.slice(0, 16)}`;
}
