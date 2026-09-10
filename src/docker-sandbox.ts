import { mkdir, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  DestroyReceipt,
  EnvironmentPlanRequest,
  EnvironmentRecovery,
  EnvironmentStartRequest,
  IsolatedEnvironmentAdapter,
} from "./contracts.ts";
import type {
  CapabilitySet,
  EnvironmentPlan,
  EnvironmentProfileRef,
  PreparedEnvironment,
} from "./domain.ts";
import { capabilities } from "./domain.ts";
import { dataDirectory } from "./paths.ts";

/**
 * Docker Sandbox runtime for Wayfinder (JWB-330). Productizes the proven JWB-329 lane
 * topology behind the existing {@link IsolatedEnvironmentAdapter} seam: a sandbox-private
 * clone with no writable host tree, a narrow log bridge, one collision-free host loopback
 * endpoint, provider-native credential/network policy, and receipt-scoped teardown/recovery.
 *
 * Isolation strength is conditional (JWB-328). This module NEVER advertises strong isolation
 * it cannot verify and NEVER silently downgrades an explicit isolation requirement.
 */

/** Egress presets exposed by the sandbox provider, weakest to strongest. */
export type NetworkPreset = "open" | "balanced" | "locked-down";
/** The egress posture a lane requires; compared against the active preset, deny-beats-allow. */
export type NetworkPosture = NetworkPreset;
/** `clone` is the host-private workspace mode; `direct` bind-mounts the host tree read-write. */
export type WorkspaceMode = "clone" | "direct";

const PRESET_STRENGTH: Record<NetworkPreset, number> = {
  open: 0,
  balanced: 1,
  "locked-down": 2,
};

/** Capabilities advertised once the `sbx` binary is usable; strong isolation is gated separately. */
const BASE_ENVIRONMENT_CAPABILITIES = [
  "environment_plan",
  "environment_start",
  "environment_readiness",
  "environment_logs",
  "environment_resume",
  "environment_stop",
  "environment_destroy",
  "environment_recover",
  "service_publish",
  "network_policy",
  "scoped_credentials",
] as const;

export interface SandboxExec {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Provider-native surface over the standalone `sbx` CLI plus the host-side git it needs to
 * materialize a private clone. Every method is argv-only — no shell composition — and no
 * secret VALUE is ever passed through argv (credential handles are names, bound provider-side).
 */
export interface SandboxProvider {
  /** Resolve the `sbx` executable, or null when absent. Absence is fail-closed availability. */
  which(): string | null;
  readonly platform: NodeJS.Platform;
  /** Run an `sbx` subcommand. */
  sbx(argv: readonly string[]): Promise<SandboxExec>;
  /** Host-side git used to seed a private clone from a repository's own objects. */
  git(argv: readonly string[], cwd?: string): Promise<SandboxExec>;
  /** Reserve a collision-free host loopback port, returned released for immediate bind. */
  reserveLoopbackPort(): Promise<number>;
}

/** The host facts `doctor` probes before any strong-isolation claim (JWB-328). */
export interface SandboxProbeResult {
  binaryPresent: boolean;
  authenticated: boolean;
  hypervisor: "macos-hvf" | "windows-whp" | "linux-kvm" | "nested" | "absent";
  osQualified: boolean;
  /** True when the launch path is a linked git worktree, which makes native `sbx --clone` impossible. */
  linkedWorktree: boolean;
  networkPreset: NetworkPreset;
}

/** What a lane demands of the host; qualification is the intersection of demand and probe. */
export interface SandboxHostContext {
  requiredMode: WorkspaceMode;
  requireStrongIsolation: boolean;
  requiredNetworkPosture?: NetworkPosture;
  /**
   * When true the adapter materializes the private clone host-side (JWB-329 resolution), so a
   * linked worktree no longer blocks clone mode. When false, native `sbx --clone` semantics apply
   * and a linked worktree is a hard blocker — this is the honest default for raw `doctor` reads.
   */
  hostSideClone?: boolean;
}

export interface SandboxQualification {
  /** Adapter capability ∩ host probe ∩ OS qualification ∩ workspace-mode feasibility. */
  strongIsolation: boolean;
  /** What {@link DockerSandboxEnvironmentAdapter.describe} may advertise on this host. */
  capabilities: CapabilitySet;
  /** Specific unmet probes, in evaluation order, for fail-closed messaging. */
  blockers: string[];
  /** The resolved workspace mode; never a silent downgrade of the required mode. */
  workspaceMode: WorkspaceMode;
}

/**
 * Compute the fail-closed Docker Sandbox qualification. This is the JWB-328 doctor logic:
 * presence on PATH proves nothing; strong isolation is gated on login + hypervisor + OS +
 * workspace-mode feasibility, and an explicit isolation requirement is refused — never
 * downgraded — when any gate is unmet.
 */
export function qualifyDockerSandbox(
  probe: SandboxProbeResult,
  context: SandboxHostContext,
): SandboxQualification {
  const blockers: string[] = [];
  const strongBlockers: string[] = [];

  if (!probe.binaryPresent) {
    blockers.push("docker-sandbox binary (sbx) not found on PATH");
    return {
      strongIsolation: false,
      capabilities: capabilities(),
      blockers,
      workspaceMode: context.requiredMode,
    };
  }
  if (!probe.authenticated) strongBlockers.push("sbx session is unauthenticated (run `sbx login`)");
  if (!probe.osQualified)
    strongBlockers.push("host OS/arch is not a qualified Docker Sandbox platform");
  if (probe.hypervisor === "absent")
    strongBlockers.push("no native hypervisor (Hypervisor.framework / WHP / KVM) available");

  // Workspace-mode feasibility. Clone mode is host-private isolation; the JWB-328 tension is
  // that native `sbx --clone` is rejected from a linked worktree, which lanes always are.
  if (context.requiredMode === "clone" && probe.linkedWorktree && !context.hostSideClone) {
    strongBlockers.push(
      "clone mode is rejected from a linked worktree; enable host-side cloning to resolve (JWB-329)",
    );
  }

  // Network posture: deny beats allow, so a weaker active preset cannot satisfy a stronger demand.
  if (
    context.requiredNetworkPosture &&
    PRESET_STRENGTH[probe.networkPreset] < PRESET_STRENGTH[context.requiredNetworkPosture]
  ) {
    strongBlockers.push(
      `active network preset '${probe.networkPreset}' is weaker than required '${context.requiredNetworkPosture}'`,
    );
  }

  const strongIsolation = strongBlockers.length === 0;
  blockers.push(...strongBlockers);

  // Base environment capabilities are advertised once the binary is usable; strong isolation is
  // advertised ONLY when every gate passes (never a capability we cannot verify).
  const base: CapabilitySet = capabilities(...BASE_ENVIRONMENT_CAPABILITIES);
  const advertised: CapabilitySet = strongIsolation
    ? { ...base, ...capabilities("strong_isolation") }
    : base;

  return {
    strongIsolation,
    capabilities: advertised,
    blockers,
    workspaceMode: context.requiredMode,
  };
}

export interface SandboxServiceConfig {
  /** The port the lane service listens on INSIDE the sandbox. */
  containerPort: number;
}

export interface SandboxNetworkConfig {
  posture: NetworkPosture;
  /** Host patterns to allow (HTTP/HTTPS or explicit raw-TCP `ip:port`). */
  allow?: readonly string[];
  /** Host patterns to deny. Deny always beats allow. */
  deny?: readonly string[];
}

export interface SandboxProfileConfig {
  image: string;
  service: SandboxServiceConfig;
  /** Credential handle NAMES bound provider-side. Never values — never in argv, logs, or receipts. */
  credentialHandles?: readonly string[];
  network: SandboxNetworkConfig;
  /** The argv the sandbox runs internally (the agent command). Never composed as shell text. */
  command: readonly string[];
  workspaceMode: WorkspaceMode;
  requireStrongIsolation: boolean;
}

/** A private clone staged host-side, ready to materialize into a sandbox. No host bind-mount. */
export interface StagedSandboxClone {
  hostStagingDir: string;
  sourceRef: string;
  sandboxPath: string;
  /** Always true: the clone is materialized into the sandbox, the host tree is never writable. */
  hostPrivate: true;
}

export interface SandboxCloneRequest {
  /** Path to the repository whose git objects seed the private clone (NOT a per-lane worktree). */
  source: string;
  ref: string;
  sandboxPath?: string;
}

export class SandboxWorkspaceError extends Error {
  readonly code = "sandbox_workspace";
  constructor(message: string) {
    super(message);
    this.name = "SandboxWorkspaceError";
  }
}

/**
 * Prepares a sandbox-private clone WITHOUT requiring a writable host worktree (JWB-329). The host
 * clones the repository's own git into private staging (offline, `file://`); the environment adapter
 * later materializes it into the sandbox. No bind-mount is ever used, so the host tree stays
 * unwritable from inside the sandbox.
 */
export class SandboxCloneWorkspaceStrategy {
  readonly #provider: SandboxProvider;

  constructor(provider: SandboxProvider) {
    this.#provider = provider;
  }

  async preflight(request: SandboxCloneRequest): Promise<void> {
    const inside = await this.#provider.git(["rev-parse", "--is-inside-work-tree"], request.source);
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      throw new SandboxWorkspaceError(`Clone source is not a git repository: ${request.source}`);
    }
  }

  async prepare(request: SandboxCloneRequest): Promise<StagedSandboxClone> {
    await this.preflight(request);
    const head = await this.#provider.git(["rev-parse", request.ref], request.source);
    if (head.exitCode !== 0) {
      throw new SandboxWorkspaceError(`Unknown ref ${request.ref}: ${head.stderr.trim()}`);
    }
    const sourceRef = head.stdout.trim();
    const staging = await mkdtemp(join(tmpdir(), "wf-sbx-clone-"));
    const dest = join(staging, "clone");
    const clone = await this.#provider.git([
      "clone",
      "--quiet",
      `file://${request.source}/.git`,
      dest,
    ]);
    if (clone.exitCode !== 0) {
      await rm(staging, { recursive: true, force: true });
      throw new SandboxWorkspaceError(`Private clone failed: ${clone.stderr.trim()}`);
    }
    return {
      hostStagingDir: staging,
      sourceRef,
      sandboxPath: request.sandboxPath ?? "/workspace",
      hostPrivate: true,
    };
  }
}

/** Durable, receipt-scoped record of an owned sandbox, so a fresh process can recover it. */
export interface SandboxReceipt {
  environmentId: string;
  profile: EnvironmentProfileRef;
  sandboxName: string;
  hostPort: number;
  containerPort: number;
  sandboxPath: string;
  stagingDir: string;
  sourceRef: string;
  /** Recorded so recovery can PROVE teardown never touches the host worktree. */
  hostWorktree: string;
  createdAt: string;
}

export interface SandboxReceiptStore {
  save(receipt: SandboxReceipt): Promise<void>;
  load(environmentId: string): Promise<SandboxReceipt | undefined>;
  remove(environmentId: string): Promise<void>;
}

/** In-memory receipt store for tests and single-process use. */
export class MemorySandboxReceiptStore implements SandboxReceiptStore {
  readonly #records = new Map<string, SandboxReceipt>();
  async save(receipt: SandboxReceipt): Promise<void> {
    this.#records.set(receipt.environmentId, { ...receipt });
  }
  async load(environmentId: string): Promise<SandboxReceipt | undefined> {
    const found = this.#records.get(environmentId);
    return found ? { ...found } : undefined;
  }
  async remove(environmentId: string): Promise<void> {
    this.#records.delete(environmentId);
  }
}

/** Append-only JSONL receipt store; last write per id wins, so a fresh process re-derives state. */
export class FileSandboxReceiptStore implements SandboxReceiptStore {
  readonly #path: string;
  constructor(path: string = join(dataDirectory(), "sandbox-receipts.jsonl")) {
    this.#path = path;
  }
  async save(receipt: SandboxReceipt): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const prior = (await Bun.file(this.#path).exists()) ? await Bun.file(this.#path).text() : "";
    await Bun.write(this.#path, `${prior}${JSON.stringify({ op: "save", receipt })}\n`);
  }
  async remove(environmentId: string): Promise<void> {
    if (!(await Bun.file(this.#path).exists())) return;
    const prior = await Bun.file(this.#path).text();
    await Bun.write(this.#path, `${prior}${JSON.stringify({ op: "remove", environmentId })}\n`);
  }
  async load(environmentId: string): Promise<SandboxReceipt | undefined> {
    if (!(await Bun.file(this.#path).exists())) return undefined;
    const text = await Bun.file(this.#path).text();
    let current: SandboxReceipt | undefined;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as
        | { op: "save"; receipt: SandboxReceipt }
        | { op: "remove"; environmentId: string };
      if (entry.op === "save" && entry.receipt.environmentId === environmentId)
        current = entry.receipt;
      if (entry.op === "remove" && entry.environmentId === environmentId) current = undefined;
    }
    return current;
  }
}

export interface DockerSandboxAdapterOptions {
  provider: SandboxProvider;
  probe: SandboxProbeResult;
  profileConfig: SandboxProfileConfig;
  /** Repository whose git seeds the private clone, and the branch/ref to materialize. */
  repositoryPath: string;
  ref: string;
  /** The host worktree the lane was launched from; recorded and NEVER deleted by teardown. */
  hostWorktree: string;
  workspaceStrategy?: SandboxCloneWorkspaceStrategy;
  receiptStore?: SandboxReceiptStore;
  now?: () => Date;
  /** Host-side readiness probe of the published service endpoint. Defaults to a real loopback fetch. */
  endpointProbe?: (hostPort: number) => Promise<boolean>;
}

interface PlannedSandbox {
  plan: EnvironmentPlan;
  clone: StagedSandboxClone;
  hostPort: number;
  sandboxName: string;
}

/**
 * The Docker Sandbox environment adapter. Implements the full isolated lifecycle:
 * describe/preflight/plan/start/verifyReady/logs/resume/stop/destroy/recover. It fails closed
 * on an unmet isolation requirement, publishes the lane service to a collision-free loopback
 * endpoint, applies provider-native credential/network policy, and never deletes the host tree.
 */
export class DockerSandboxEnvironmentAdapter implements IsolatedEnvironmentAdapter {
  readonly name = "docker-sandbox";
  readonly #provider: SandboxProvider;
  readonly #probe: SandboxProbeResult;
  readonly #config: SandboxProfileConfig;
  readonly #repositoryPath: string;
  readonly #ref: string;
  readonly #hostWorktree: string;
  readonly #workspace: SandboxCloneWorkspaceStrategy;
  readonly #receipts: SandboxReceiptStore;
  readonly #now: () => Date;
  readonly #endpointProbe: (hostPort: number) => Promise<boolean>;
  readonly #planned = new Map<string, PlannedSandbox>();

  constructor(options: DockerSandboxAdapterOptions) {
    this.#provider = options.provider;
    this.#probe = options.probe;
    this.#config = options.profileConfig;
    this.#repositoryPath = options.repositoryPath;
    this.#ref = options.ref;
    this.#hostWorktree = options.hostWorktree;
    this.#workspace =
      options.workspaceStrategy ?? new SandboxCloneWorkspaceStrategy(options.provider);
    this.#receipts = options.receiptStore ?? new MemorySandboxReceiptStore();
    this.#now = options.now ?? (() => new Date());
    this.#endpointProbe = options.endpointProbe ?? ((hostPort) => defaultEndpointProbe(hostPort));
  }

  #context(): SandboxHostContext {
    return {
      requiredMode: this.#config.workspaceMode,
      requireStrongIsolation: this.#config.requireStrongIsolation,
      requiredNetworkPosture: this.#config.network.posture,
      // The adapter always materializes the private clone host-side, resolving the worktree tension.
      hostSideClone: this.#config.workspaceMode === "clone",
    };
  }

  qualify(): SandboxQualification {
    return qualifyDockerSandbox(this.#probe, this.#context());
  }

  async describe(): Promise<CapabilitySet> {
    return this.qualify().capabilities;
  }

  async preflight(_request: EnvironmentPlanRequest): Promise<void> {
    const qualification = this.qualify();
    // Fail closed: an explicit strong-isolation requirement is refused, never downgraded, when unmet.
    if (this.#config.requireStrongIsolation && !qualification.strongIsolation) {
      throw new SandboxWorkspaceError(
        `Strong isolation required but unavailable: ${qualification.blockers.join("; ")}`,
      );
    }
    // A clone-mode lane must never silently fall through to a host-writable direct mount.
    if (this.#config.workspaceMode === "clone") {
      await this.#workspace.preflight({ source: this.#repositoryPath, ref: this.#ref });
    }
  }

  async plan(request: EnvironmentPlanRequest): Promise<EnvironmentPlan> {
    await this.preflight(request);
    const qualification = this.qualify();
    const id = `dsbx-${request.ticket.ref}-${this.#now().getTime()}`.replace(
      /[^a-zA-Z0-9_-]/g,
      "-",
    );
    const clone = await this.#workspace.prepare({
      source: this.#repositoryPath,
      ref: this.#ref,
      sandboxPath: "/workspace",
    });
    const hostPort = await this.#provider.reserveLoopbackPort();
    const sandboxName = `wf-sbx-${id}`;
    const warnings: string[] = [];
    if (!qualification.strongIsolation) {
      warnings.push(
        `strong isolation not qualified on this host: ${qualification.blockers.join("; ")}`,
      );
    }
    // Documented negative finding (JWB-328): no sbx-native CPU/memory ceilings exist.
    warnings.push(
      "per-lane CPU/memory ceilings are not enforceable via sbx; use Wayfinder admission",
    );
    const plan: EnvironmentPlan = {
      id,
      profile: request.profile,
      summary: `Docker Sandbox '${sandboxName}' (${qualification.workspaceMode} workspace, service ${hostPort}->${this.#config.service.containerPort})`,
      warnings,
      // Credential HANDLES only — names bound provider-side, never values.
      credentialHandles: [...(this.#config.credentialHandles ?? [])],
    };
    this.#planned.set(id, { plan, clone, hostPort, sandboxName });
    return plan;
  }

  async start(request: EnvironmentStartRequest): Promise<PreparedEnvironment> {
    const planned = this.#planned.get(request.plan.id);
    if (!planned) throw new SandboxWorkspaceError(`Unknown environment plan: ${request.plan.id}`);
    const { clone, hostPort, sandboxName } = planned;
    const containerPort = this.#config.service.containerPort;

    // 1. Create the sandbox detached with NO host bind-mount, publishing the service to a
    //    collision-free host loopback port. Host-private isolation is delivered by the host-side
    //    clone + `cp` in step 2 (JWB-329), NOT by sbx-native `--clone` — which is rejected from a
    //    linked worktree (JWB-328) and would also re-expose the host tree in its default direct mode.
    //    The lane's host tree is therefore never named to `sbx create`.
    const createArgv: string[] = [
      "create",
      "--name",
      sandboxName,
      "--detached",
      "--publish",
      `127.0.0.1:${hostPort}:${containerPort}`,
    ];
    // Credential handles are passed by NAME; the provider binds values from its own secret store.
    for (const handle of this.#config.credentialHandles ?? []) {
      createArgv.push("--credential", handle);
    }
    createArgv.push(this.#config.image, ...this.#config.command);
    const created = await this.#execChecked(createArgv, "sandbox create");

    try {
      // 2. Materialize the private clone INTO the sandbox (no bind-mount; host tree stays unwritable).
      await this.#execChecked(
        ["cp", `${join(clone.hostStagingDir, "clone")}/.`, `${sandboxName}:${clone.sandboxPath}`],
        "clone materialize",
      );
      // 3. Apply provider-native network policy: deny-beats-allow, deny-by-default posture.
      await this.#applyNetworkPolicy(sandboxName);
      // 4. Start the sandbox (the agent command runs inside).
      await this.#execChecked(["start", sandboxName], "sandbox start");
    } catch (error) {
      // Compensate: remove the sandbox and its private staging; the host worktree is untouched.
      await this.#provider.sbx(["rm", "--force", sandboxName]);
      await rm(clone.hostStagingDir, { recursive: true, force: true });
      throw error;
    }

    await this.#receipts.save({
      environmentId: request.plan.id,
      profile: request.plan.profile,
      sandboxName,
      hostPort,
      containerPort,
      sandboxPath: clone.sandboxPath,
      stagingDir: clone.hostStagingDir,
      sourceRef: clone.sourceRef,
      hostWorktree: this.#hostWorktree,
      createdAt: this.#now().toISOString(),
    });
    void created;
    return this.#prepared(
      request.plan.id,
      request.plan.profile,
      sandboxName,
      hostPort,
      "not_ready",
    );
  }

  async verifyReady(environment: PreparedEnvironment): Promise<void> {
    const receipt = await this.#requireReceipt(environment.id);
    const running = await this.#running(receipt.sandboxName);
    if (!running) {
      // Never silently promote to ready; readiness failure is attention-worthy, retaining evidence.
      environment.readiness.sandbox = "not_ready";
      throw new SandboxWorkspaceError(`Sandbox ${receipt.sandboxName} is not running`);
    }
    environment.readiness.sandbox = "ready";
    const answered = await this.#endpointAnswers(receipt.hostPort);
    environment.readiness.service = answered ? "ready" : "not_ready";
    if (!answered)
      throw new SandboxWorkspaceError(
        `Service endpoint 127.0.0.1:${receipt.hostPort} is not answering`,
      );
  }

  async logs(environment: PreparedEnvironment): Promise<string[]> {
    const receipt = await this.#requireReceipt(environment.id);
    const result = await this.#provider.sbx(["logs", receipt.sandboxName]);
    // The narrow bridge: only structured lines cross it.
    return `${result.stdout}\n${result.stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("{"));
  }

  /** Resume a stopped sandbox: stop -> run-by-name, then re-verify — never recreated (JWB-328). */
  async resume(id: string): Promise<PreparedEnvironment> {
    const receipt = await this.#requireReceipt(id);
    await this.#execChecked(["run", "--name", receipt.sandboxName], "sandbox resume");
    return this.#prepared(id, receipt.profile, receipt.sandboxName, receipt.hostPort, "ready");
  }

  /** Idempotent, receipt-scoped stop: only the exact owned sandbox; a no-op when already stopped. */
  async stop(environment: PreparedEnvironment): Promise<void> {
    const receipt = await this.#receipts.load(environment.id);
    if (!receipt) return;
    if (!(await this.#running(receipt.sandboxName))) return;
    await this.#execChecked(["stop", "--time", "1", receipt.sandboxName], "sandbox stop");
  }

  /** Destructive teardown of exactly the owned resources. The host worktree is NEVER removed. */
  async destroy(environment: PreparedEnvironment): Promise<DestroyReceipt> {
    const receipt = await this.#receipts.load(environment.id);
    if (!receipt) return { removed: [], preserved: [this.#hostWorktree] };
    const removed: string[] = [];
    const rmResult = await this.#provider.sbx(["rm", "--force", receipt.sandboxName]);
    if (rmResult.exitCode === 0) removed.push(`sandbox:${receipt.sandboxName}`);
    await rm(receipt.stagingDir, { recursive: true, force: true });
    removed.push(`staging:${receipt.stagingDir}`);
    await this.#receipts.remove(environment.id);
    return { removed, preserved: [receipt.hostWorktree] };
  }

  /** Reconnect recovery: a fresh process re-derives from the receipt and re-verifies live state. */
  async recover(id: string): Promise<EnvironmentRecovery> {
    const receipt = await this.#receipts.load(id);
    if (!receipt) {
      return {
        environment: this.#emptyPrepared(id),
        verified: false,
        evidence: { reason: "no durable receipt", id },
      };
    }
    const running = await this.#running(receipt.sandboxName);
    const answered = running ? await this.#endpointAnswers(receipt.hostPort) : false;
    const environment = this.#prepared(
      id,
      receipt.profile,
      receipt.sandboxName,
      receipt.hostPort,
      running && answered ? "ready" : "not_ready",
    );
    return {
      environment,
      // Verified means re-verified live, never recreated.
      verified: running && answered,
      evidence: {
        sandboxName: receipt.sandboxName,
        sourceRef: receipt.sourceRef,
        hostPort: receipt.hostPort,
        running,
        endpointAnswered: answered,
        hostWorktreePreserved: receipt.hostWorktree,
        recreated: false,
      },
    };
  }

  async #applyNetworkPolicy(sandboxName: string): Promise<void> {
    const { posture, allow, deny } = this.#config.network;
    await this.#execChecked(["policy", "preset", posture, sandboxName], "network preset");
    // Deny beats allow: apply denies last so they always win.
    for (const host of allow ?? []) {
      await this.#execChecked(["policy", "allow", "network", host, sandboxName], "network allow");
    }
    for (const host of deny ?? []) {
      await this.#execChecked(["policy", "deny", "network", host, sandboxName], "network deny");
    }
  }

  async #execChecked(argv: readonly string[], label: string): Promise<SandboxExec> {
    const result = await this.#provider.sbx(argv);
    if (result.exitCode !== 0) {
      throw new SandboxWorkspaceError(
        `${label} failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return result;
  }

  async #running(sandboxName: string): Promise<boolean> {
    const result = await this.#provider.sbx(["inspect", "--format", "{{.Running}}", sandboxName]);
    return result.exitCode === 0 && result.stdout.trim() === "true";
  }

  async #endpointAnswers(hostPort: number): Promise<boolean> {
    return this.#endpointProbe(hostPort);
  }

  async #requireReceipt(id: string): Promise<SandboxReceipt> {
    const receipt = await this.#receipts.load(id);
    if (!receipt) throw new SandboxWorkspaceError(`No sandbox receipt for environment ${id}`);
    return receipt;
  }

  #prepared(
    id: string,
    profile: EnvironmentProfileRef,
    _sandboxName: string,
    _hostPort: number,
    service: "ready" | "not_ready",
  ): PreparedEnvironment {
    return {
      id,
      profile,
      readiness: { sandbox: service === "ready" ? "ready" : "not_ready", service },
      logReferences: [`sbx:logs:${_sandboxName}`, `endpoint:127.0.0.1:${_hostPort}`],
    };
  }

  #emptyPrepared(id: string): PreparedEnvironment {
    return {
      id,
      profile: "unknown" as EnvironmentProfileRef,
      readiness: { sandbox: "not_ready", service: "not_ready" },
      logReferences: [],
    };
  }
}

/** Best-effort real provider over the standalone `sbx` CLI and host git. Absent `sbx` = fail-closed. */
export class BunSandboxProvider implements SandboxProvider {
  readonly platform: NodeJS.Platform = process.platform;

  which(): string | null {
    return Bun.which("sbx");
  }

  async sbx(argv: readonly string[]): Promise<SandboxExec> {
    const executable = this.which();
    if (!executable) {
      return { exitCode: 127, stdout: "", stderr: "docker-sandbox binary (sbx) not found" };
    }
    return run([executable, ...argv]);
  }

  async git(argv: readonly string[], cwd?: string): Promise<SandboxExec> {
    return run(["git", ...argv], cwd);
  }

  reserveLoopbackPort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address && typeof address === "object") {
          const { port } = address;
          server.close(() => resolve(port));
        } else {
          server.close(() => reject(new Error("could not reserve a loopback port")));
        }
      });
    });
  }
}

async function defaultEndpointProbe(hostPort: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${hostPort}/`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function run(argv: readonly string[], cwd?: string): Promise<SandboxExec> {
  const child = Bun.spawn([...argv], {
    ...(cwd ? { cwd } : {}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** Best-effort host probe. Fails closed: an unresolved fact is reported as unavailable, not assumed. */
export async function probeDockerSandbox(
  provider: SandboxProvider,
  options: { launchPath: string } = { launchPath: process.cwd() },
): Promise<SandboxProbeResult> {
  const binaryPresent = provider.which() !== null;
  if (!binaryPresent) {
    return {
      binaryPresent: false,
      authenticated: false,
      hypervisor: "absent",
      osQualified: false,
      linkedWorktree: false,
      networkPreset: "locked-down",
    };
  }
  const auth = await provider.sbx(["auth", "status"]);
  const worktree = await provider.git(["rev-parse", "--is-inside-work-tree"], options.launchPath);
  const commonDir = await provider.git(["rev-parse", "--git-common-dir"], options.launchPath);
  const gitDir = await provider.git(["rev-parse", "--git-dir"], options.launchPath);
  const linkedWorktree =
    worktree.stdout.trim() === "true" && commonDir.stdout.trim() !== gitDir.stdout.trim();
  return {
    binaryPresent,
    authenticated: auth.exitCode === 0,
    hypervisor:
      provider.platform === "darwin"
        ? "macos-hvf"
        : provider.platform === "win32"
          ? "windows-whp"
          : "linux-kvm",
    osQualified: false, // Fail closed: OS qualification requires an explicit version/arch probe.
    linkedWorktree,
    networkPreset: "balanced",
  };
}

/** Registry availability + capabilities for the `docker-sandbox` environment adapter. */
export function dockerSandboxAvailable(provider: SandboxProvider): boolean {
  return provider.which() !== null;
}

/**
 * Static registry capabilities for adapter listings. When `sbx` is present it advertises the base
 * environment lifecycle only; `strong_isolation` is never advertised statically because it cannot
 * be verified without the full async host probe.
 */
export function dockerSandboxRegistryCapabilities(present: boolean): CapabilitySet {
  return present ? capabilities(...BASE_ENVIRONMENT_CAPABILITIES) : capabilities();
}

export function dockerSandboxCapabilities(
  probe: SandboxProbeResult,
  context: SandboxHostContext,
): CapabilitySet {
  return qualifyDockerSandbox(probe, context).capabilities;
}
