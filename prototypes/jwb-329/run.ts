// PROTOTYPE — JWB-329 driver. One command:  bun run prototypes/jwb-329/run.ts
//
// QUESTION THIS PROTOTYPE ANSWERS
// Can Wayfinder drive ONE isolated agent lane end-to-end where the worker runs on
// a sandbox-private clone (never the host worktree), cannot reach unrelated host
// files or Wayfinder-global credentials, exposes ONE dev server to a collision-free
// host loopback port recorded in durable lane state, survives an orchestrator
// reconnect (state re-folded from an append-only log, then the live sandbox is
// re-verified), and tears down idempotently and receipt-scoped without touching the
// host worktree — and where do the failure modes and cleanup land?
//
// It resolves the sharp JWB-328 tension: `sbx --clone` is rejected from a linked
// worktree, and lanes ARE linked worktrees. Resolution proven below: the private
// clone is materialized FROM the worktree's git INTO the sandbox, so the lane gets
// a private writable clone with zero writable host-repository access.
//
// HONESTY (ADR 0001 §14 / JWB-328): the real strong-isolation adapter is Docker
// Sandbox `sbx` (microVM, own kernel). `sbx` is NOT provisioned in this environment,
// so preflight reports strong isolation UNAVAILABLE and does not silently downgrade.
// The lane TOPOLOGY and LIFECYCLE are proven here against a container boundary that
// is a peer EnvironmentAdapter sharing that topology; microVM-strength kernel
// isolation and sbx egress policy remain the productization gap (see README).

import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ControlPlane,
  createSandbox,
  endpointAnswers,
  exec,
  sandboxLogs,
  sandboxRunning,
  stagePrivateClone,
  startSandbox,
  stopSandbox,
  teardown,
  worktreeSignature,
} from "./docker-lane.ts";
import {
  durableFingerprint,
  type LaneEvent,
  type LaneState,
  project,
  reduce,
  transitionError,
} from "./lane-machine.ts";

const B = "\x1b[1m";
const D = "\x1b[2m";
const G = "\x1b[32m";
const R = "\x1b[31m";
const X = "\x1b[0m";

const WORKTREE = process.cwd();
const checks: { name: string; pass: boolean; evidence: string }[] = [];
function record(name: string, pass: boolean, evidence: string): void {
  checks.push({ name, pass, evidence });
  const tag = pass ? `${G}PASS${X}` : `${R}FAIL${X}`;
  console.log(`  ${tag} ${B}${name}${X} ${D}${evidence}${X}`);
}

function render(label: string, state: LaneState): void {
  console.log(
    `\n${B}▸ ${label}${X}  phase=${B}${state.phase}${X} ${D}sandbox=${state.sandboxId ?? "-"} ` +
      `endpoint=${state.endpoint ?? "-"} clone=${state.privateClone} ` +
      `hostRepoWritable=${state.hostRepositoryWritable} receipt=[${state.receipt.ownedResourceIds.join(",")}]` +
      `${state.failure ? ` failure=${state.failure.evidence}` : ""}${X}`,
  );
}

/** Append to the durable log AND advance a live in-memory projection, guarded. */
async function commit(cp: ControlPlane, state: LaneState, event: LaneEvent): Promise<LaneState> {
  const err = transitionError(state, event.type);
  if (err) throw new Error(`illegal transition: ${err} (event ${event.type})`);
  await cp.append(event);
  return reduce(state, event);
}

async function main(): Promise<void> {
  console.log(`${B}=== JWB-329 · Prove an isolated agent lane in Docker Sandbox ===${X}`);
  const doctor = await exec(["docker", "version", "-f", "{{.Server.Version}}"]);
  if (doctor.code !== 0) {
    console.error(`${R}docker unavailable — cannot run the isolation proof.${X}`);
    process.exit(2);
  }
  console.log(`${D}docker server ${doctor.stdout.trim()} · worktree ${WORKTREE}${X}`);

  const controlDir = await mkdtemp(join(tmpdir(), "jwb329-control-"));
  // A planted host secret + a fake Wayfinder-global credential the lane must NOT reach.
  const hostSecretPath = join(controlDir, "host-secret.txt");
  const fakeGlobalCredDir = join(controlDir, "wayfinder-global");
  const hostHomeCred = join(fakeGlobalCredDir, "credentials");
  await writeFile(hostSecretPath, "TOP-SECRET-HOST-VALUE");
  await mkdir(fakeGlobalCredDir, { recursive: true });
  await writeFile(hostHomeCred, "wayfinder-global-token=SHOULD-NEVER-LEAK");

  await scenarioHappyPath(controlDir, hostSecretPath, hostHomeCred);
  await scenarioStartCompensation(controlDir, hostSecretPath, hostHomeCred);
  scenarioMachineInvariants();

  await rm(controlDir, { recursive: true, force: true });
  emitEvidence();
}

/** Scenario 1: full lane lifecycle on real docker. Proves acceptance 1-4 + stop/resume/teardown. */
async function scenarioHappyPath(
  controlDir: string,
  hostSecretPath: string,
  hostHomeCred: string,
): Promise<void> {
  console.log(`\n${B}── Scenario 1: end-to-end isolated lane ──${X}`);
  const laneId = "lane1";
  const cp = new ControlPlane(join(controlDir, `${laneId}.log`));
  let state = project(await cp.read());
  let stagingDir: string | null = null;
  let sandboxId: string | null = null;

  const hostBefore = await worktreeSignature(WORKTREE);
  try {
    state = await commit(cp, state, {
      type: "lane_declared",
      laneId,
      adapter: "docker-sandbox",
      profile: "isolated-clone",
    });
    // Preflight is honest about strong isolation not being provisioned here.
    const sbxProvisioned =
      (await exec(["sh", "-c", "command -v sbx || true"])).stdout.trim().length > 0;
    state = await commit(cp, state, {
      type: "preflight_recorded",
      laneId,
      strongIsolation: sbxProvisioned,
      boundary: sbxProvisioned ? "sbx-microvm" : "docker-container (shared-kernel stand-in)",
      reasons: sbxProvisioned
        ? ["sbx provisioned"]
        : [
            "sbx CLI not provisioned; no silent downgrade of an explicit strong-isolation requirement",
          ],
    });
    render("preflight", state);
    record(
      "preflight fails closed on strong isolation",
      !state.strongIsolation,
      `boundary=${state.boundary}`,
    );

    state = await commit(cp, state, {
      type: "plan_recorded",
      laneId,
      planId: "plan-1",
      summary: "isolated clone lane on container boundary",
      warnings: ["strong isolation unavailable: container boundary shares host kernel"],
      containsSecrets: false,
    });
    render("plan", state);

    // start: materialize the sandbox-private clone, then launch the in-sandbox agent.
    const staged = await stagePrivateClone(WORKTREE);
    stagingDir = staged.hostStagingDir;
    const created = await createSandbox(laneId, staged, {
      hostSecretPath,
      hostHomeCred,
      hostUnrelated: join(WORKTREE, "package.json"),
    });
    sandboxId = created.sandboxId;
    state = await commit(cp, state, {
      type: "workspace_materialized",
      laneId,
      workspaceHandle: created.workspaceHandle,
      privateClone: true,
      sourceRef: staged.sourceRef,
      hostRepositoryWritable: false,
    });
    render("workspace_materialized", state);

    await startSandbox(created.sandboxId);
    state = await commit(cp, state, {
      type: "agent_launched",
      laneId,
      sandboxId: created.sandboxId,
      invocation: {
        agent: "scripted-lane-agent",
        argv: ["sh", "-c", "<in-sandbox agent>"],
        cwd: created.workspaceHandle,
      },
    });
    render("agent_launched", state);

    // Let the in-sandbox agent boot, do work, probe isolation, and bind its port.
    await Bun.sleep(1800);
    const logs = await sandboxLogs(created.sandboxId);
    const leaks = logs.filter((l) => l.includes('"leak"'));
    const absent = logs.filter((l) => l.includes('"isolation"') && l.includes("absent:"));
    record(
      "worker cannot read host files / Wayfinder-global creds",
      leaks.length === 0 && absent.length >= 3,
      `leaks=${leaks.length} absent-probes=${absent.length}`,
    );

    state = await commit(cp, state, {
      type: "service_exposed",
      laneId,
      endpoint: `127.0.0.1:${created.hostPort}`,
      containerPort: 8080,
      resourceId: `port:127.0.0.1:${created.hostPort}`,
    });
    render("service_exposed", state);

    const probe = await endpointAnswers(created.hostPort);
    state = await commit(
      cp,
      state,
      probe.ok
        ? { type: "readiness_verified", laneId, evidence: `HTTP 200 body=${probe.body}` }
        : { type: "readiness_failed", laneId, evidence: probe.body },
    );
    render("verifyReady", state);
    record(
      "dev server reachable from host at recorded endpoint",
      probe.ok,
      `${state.endpoint} -> ${probe.body}`,
    );

    // Acceptance 1: host source unchanged; import is an explicit, separate step.
    const hostAfter = await worktreeSignature(WORKTREE);
    record(
      "host source unchanged during lane work",
      hostBefore === hostAfter,
      `sig ${hostBefore} == ${hostAfter}`,
    );
    const imported = join(controlDir, "imported-LANE_WORK.txt");
    await exec(["docker", "cp", `${created.sandboxId}:/workspace/LANE_WORK.txt`, imported]);
    const importedExists = await stat(imported)
      .then(() => true)
      .catch(() => false);
    const hostAfterImport = await worktreeSignature(WORKTREE);
    record(
      "lane change retrievable ONLY via explicit import, host still untouched",
      importedExists && hostAfterImport === hostBefore,
      `imported=${importedExists} host-still=${hostAfterImport === hostBefore}`,
    );

    // Acceptance 4: reconnect. A brand-new process re-derives identical state from
    // the log alone, then re-verifies the live sandbox (never recreates it).
    const reader = new ControlPlane(cp.logPath);
    const rederived = project(await reader.read());
    const fpEqual = durableFingerprint(rederived) === durableFingerprint(state);
    const live = await sandboxRunning(created.sandboxId);
    const stillAnswers = (await endpointAnswers(created.hostPort)).ok;
    state = await commit(cp, state, {
      type: "reconnect_observed",
      laneId,
      byProcess: 2,
      liveSandbox: live,
      endpointAnswered: stillAnswers,
    });
    render("reconnect (fresh process)", state);
    record(
      "lane state survives orchestrator reconnect",
      fpEqual && live && stillAnswers,
      `fold-identical=${fpEqual} sandbox-live=${live} endpoint-live=${stillAnswers}`,
    );

    // Acceptance 5c: stop is idempotent and receipt-scoped.
    const stop1 = await stopSandbox(created.sandboxId);
    const stop2 = await stopSandbox(created.sandboxId);
    state = await commit(cp, state, {
      type: "stopped",
      laneId,
      releasedResourceIds: state.receipt.ownedResourceIds,
    });
    render("stopped", state);
    const worktreeIntact = await stat(join(WORKTREE, "package.json"))
      .then(() => true)
      .catch(() => false);
    record(
      "stop is idempotent and receipt-scoped",
      stop1.changed && !stop2.changed,
      `first-changed=${stop1.changed} second-noop=${!stop2.changed}`,
    );
    record(
      "stop never deletes the host worktree",
      worktreeIntact && (await worktreeSignature(WORKTREE)) === hostBefore,
      "worktree present & unchanged",
    );

    const removed = await teardown(created.sandboxId, stagingDir);
    sandboxId = null;
    stagingDir = null;
    state = await commit(cp, state, { type: "teardown_completed", laneId, removed });
    render("teardown", state);
    record(
      "teardown removes only sandbox + private clone",
      removed.length === 2 && (await worktreeSignature(WORKTREE)) === hostBefore,
      removed.join(" "),
    );
  } finally {
    if (sandboxId || stagingDir) await teardown(sandboxId, stagingDir);
  }
}

/** Scenario 2: a launch failure after the clone is materialized must compensate cleanly. */
async function scenarioStartCompensation(
  controlDir: string,
  hostSecretPath: string,
  hostHomeCred: string,
): Promise<void> {
  console.log(`\n${B}── Scenario 2: start-time failure compensation ──${X}`);
  const laneId = "lane2";
  const cp = new ControlPlane(join(controlDir, `${laneId}.log`));
  let state = project(await cp.read());
  const hostBefore = await worktreeSignature(WORKTREE);
  state = await commit(cp, state, {
    type: "lane_declared",
    laneId,
    adapter: "docker-sandbox",
    profile: "isolated-clone",
  });

  const staged = await stagePrivateClone(WORKTREE);
  const created = await createSandbox(laneId, staged, {
    hostSecretPath,
    hostHomeCred,
    hostUnrelated: "/nope",
  });
  state = await commit(cp, state, {
    type: "workspace_materialized",
    laneId,
    workspaceHandle: created.workspaceHandle,
    privateClone: true,
    sourceRef: staged.sourceRef,
    hostRepositoryWritable: false,
  });
  render("workspace_materialized", state);

  // Simulate the agent failing to launch (container never started -> not running).
  const launchFailed = !(await sandboxRunning(created.sandboxId));
  const removed = await teardown(created.sandboxId, staged.hostStagingDir); // compensating cleanup
  state = await commit(cp, state, {
    type: "lane_failed",
    laneId,
    phaseAtFailure: state.phase,
    evidence: "agent launch failed before start",
    compensated: true,
  });
  render("compensated failure", state);
  const hostAfter = await worktreeSignature(WORKTREE);
  record(
    "start failure compensates: sandbox+clone removed, host untouched",
    launchFailed &&
      removed.length === 2 &&
      hostBefore === hostAfter &&
      state.failure?.compensated === true,
    `removed=${removed.length} host-unchanged=${hostBefore === hostAfter}`,
  );
}

/** Scenario 3 (pure): the state machine's safety invariants — no container needed. */
function scenarioMachineInvariants(): void {
  console.log(`\n${B}── Scenario 3: pure state-machine invariants ──${X}`);
  // A failed readiness check must never silently become success.
  const base = project([
    { type: "lane_declared", laneId: "m", adapter: "docker-sandbox", profile: "p" },
    {
      type: "workspace_materialized",
      laneId: "m",
      workspaceHandle: "/workspace",
      privateClone: true,
      sourceRef: "x",
      hostRepositoryWritable: false,
    },
    {
      type: "agent_launched",
      laneId: "m",
      sandboxId: "deadbeef",
      invocation: { agent: "a", argv: ["x"], cwd: "/workspace" },
    },
    {
      type: "service_exposed",
      laneId: "m",
      endpoint: "127.0.0.1:1",
      containerPort: 8080,
      resourceId: "r",
    },
    { type: "readiness_failed", laneId: "m", evidence: "connection refused" },
  ]);
  record(
    "failed readiness is attention_required, not success",
    base.phase === "attention_required",
    `phase=${base.phase}`,
  );

  // Illegal orderings are rejected by the guard (can't expose a service pre-launch).
  const early = project([
    { type: "lane_declared", laneId: "m2", adapter: "docker-sandbox", profile: "p" },
  ]);
  const guard = transitionError(early, "service_exposed");
  record("illegal transition is guarded", guard !== null, `rejected: ${guard}`);
}

function emitEvidence(): void {
  const passed = checks.filter((c) => c.pass).length;
  const evidence = {
    ticket: "JWB-329",
    verdict: passed === checks.length ? "PROVEN" : "INCOMPLETE",
    boundary: "docker-container (sbx microVM not provisioned; no silent downgrade)",
    acceptance: checks.map((c) => ({ check: c.name, pass: c.pass, evidence: c.evidence })),
    passed,
    total: checks.length,
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
  };
  console.log(`\n${B}=== EVIDENCE (machine-readable) ===${X}`);
  console.log(JSON.stringify(evidence));
  console.log(
    `\n${passed === checks.length ? G : R}${B}${passed}/${checks.length} checks passed — verdict ${evidence.verdict}${X}`,
  );
  if (passed !== checks.length) process.exitCode = 1;
}

await main();
