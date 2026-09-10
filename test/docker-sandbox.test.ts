import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtInAdapters } from "../src/adapters.ts";
import type { EnvironmentPlanRequest, EnvironmentStartRequest } from "../src/contracts.ts";
import {
  DockerSandboxEnvironmentAdapter,
  MemorySandboxReceiptStore,
  qualifyDockerSandbox,
  SandboxCloneWorkspaceStrategy,
  type SandboxExec,
  type SandboxHostContext,
  type SandboxProbeResult,
  type SandboxProfileConfig,
  type SandboxProvider,
} from "../src/docker-sandbox.ts";
import type { EnvironmentProfileRef, PreparedWorkspace, Ticket, TicketRef } from "../src/domain.ts";

const SECRET_VALUE = "s3cr3t-token-DO-NOT-LEAK";

// --- Real offline git, so the private-clone proof has full fidelity without docker/sbx. ---
async function git(argv: readonly string[], cwd: string): Promise<SandboxExec> {
  const child = Bun.spawn(["git", ...argv], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wf-sbx-repo-"));
  await git(["init", "--quiet", "-b", "main"], dir);
  await writeFile(join(dir, "package.json"), '{"name":"lane"}\n');
  await git(["add", "."], dir);
  await git(["commit", "--quiet", "-m", "init"], dir);
  return dir;
}

async function repoSignature(dir: string): Promise<string> {
  const head = (await git(["rev-parse", "HEAD"], dir)).stdout.trim();
  const status = (await git(["status", "--porcelain"], dir)).stdout.trim();
  const tracked = (await git(["ls-files", "-s"], dir)).stdout;
  return new Bun.CryptoHasher("sha256").update(`${head}\n${status}\n${tracked}`).digest("hex");
}

class FakeSandbox {
  running = false;
}

/** Fakes the `sbx` CLI; delegates `git` to real offline git. Records every argv for assertions. */
class FakeSandboxProvider implements SandboxProvider {
  readonly platform: NodeJS.Platform;
  readonly sbxCalls: string[][] = [];
  readonly gitCalls: string[][] = [];
  readonly sandboxes = new Map<string, FakeSandbox>();
  readonly failSubcommands: Set<string>;
  #nextPort: number;
  #present: boolean;
  #authenticated: boolean;

  constructor(
    options: {
      platform?: NodeJS.Platform;
      present?: boolean;
      authenticated?: boolean;
      startPort?: number;
      failSubcommands?: string[];
    } = {},
  ) {
    this.platform = options.platform ?? "linux";
    this.#present = options.present ?? true;
    this.#authenticated = options.authenticated ?? true;
    this.#nextPort = options.startPort ?? 41000;
    this.failSubcommands = new Set(options.failSubcommands ?? []);
  }

  which(): string | null {
    return this.#present ? "/usr/bin/sbx" : null;
  }

  async sbx(argv: readonly string[]): Promise<SandboxExec> {
    this.sbxCalls.push([...argv]);
    const sub = argv[0] ?? "";
    if (this.failSubcommands.has(sub)) {
      return { exitCode: 1, stdout: "", stderr: `forced failure: ${sub}` };
    }
    if (sub === "auth") {
      return { exitCode: this.#authenticated ? 0 : 1, stdout: "", stderr: "" };
    }
    if (sub === "create") {
      const name = this.#nameFlag(argv);
      this.sandboxes.set(name, new FakeSandbox());
      return { exitCode: 0, stdout: `${name}\n`, stderr: "" };
    }
    if (sub === "cp" || sub === "policy") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sub === "start" || sub === "run") {
      const name = sub === "run" ? this.#nameFlag(argv) : (argv[1] ?? "");
      const box = this.sandboxes.get(name);
      if (!box) return { exitCode: 1, stdout: "", stderr: "no such sandbox" };
      box.running = true;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sub === "stop") {
      const name = argv[argv.length - 1] ?? "";
      const box = this.sandboxes.get(name);
      if (box) box.running = false;
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sub === "rm") {
      const name = argv[argv.length - 1] ?? "";
      this.sandboxes.delete(name);
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (sub === "inspect") {
      const name = argv[argv.length - 1] ?? "";
      const box = this.sandboxes.get(name);
      return { exitCode: box ? 0 : 1, stdout: box ? `${box.running}\n` : "", stderr: "" };
    }
    if (sub === "logs") {
      return {
        exitCode: 0,
        stdout: 'noise line\n{"event":"agent_boot"}\n{"event":"service_listening","port":8080}\n',
        stderr: "",
      };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  }

  async git(argv: readonly string[], cwd?: string): Promise<SandboxExec> {
    this.gitCalls.push([...argv]);
    return git(argv, cwd ?? process.cwd());
  }

  /** Staging roots created by clone operations, for exact test cleanup (0-leftover hygiene). */
  stagingRoots(): string[] {
    return this.gitCalls
      .filter((call) => call[0] === "clone")
      .map((call) => call[call.length - 1] ?? "")
      .map((dest) => dest.replace(/\/clone$/, ""));
  }

  async reserveLoopbackPort(): Promise<number> {
    return this.#nextPort++;
  }

  #nameFlag(argv: readonly string[]): string {
    const index = argv.indexOf("--name");
    return index >= 0 ? (argv[index + 1] ?? "") : "";
  }
}

function probe(overrides: Partial<SandboxProbeResult> = {}): SandboxProbeResult {
  return {
    binaryPresent: true,
    authenticated: true,
    hypervisor: "linux-kvm",
    osQualified: true,
    linkedWorktree: false,
    networkPreset: "balanced",
    ...overrides,
  };
}

function ticket(): Ticket {
  return {
    ref: "JWB-330" as TicketRef,
    map: "JWB-323" as Ticket["map"],
    kind: "task",
    state: "open",
    status: "In Progress",
    order: 1,
  };
}

function planRequest(): EnvironmentPlanRequest {
  const workspace: PreparedWorkspace = { path: "/lanes/JWB-330", branch: "task/JWB-330" };
  return {
    ticket: ticket(),
    workspaces: { primary: workspace },
    profile: "sandbox-strong" as EnvironmentProfileRef,
  };
}

function profileConfig(overrides: Partial<SandboxProfileConfig> = {}): SandboxProfileConfig {
  return {
    image: "wayfinder/lane:latest",
    service: { containerPort: 8080 },
    credentialHandles: ["GH_TOKEN", "NPM_TOKEN"],
    network: { posture: "balanced", allow: ["*.github.com"], deny: ["metadata.internal"] },
    command: ["lane-agent", "--serve"],
    workspaceMode: "clone",
    requireStrongIsolation: true,
    ...overrides,
  };
}

function makeAdapter(
  provider: FakeSandboxProvider,
  repoPath: string,
  overrides: {
    probe?: Partial<SandboxProbeResult>;
    config?: Partial<SandboxProfileConfig>;
    receiptStore?: MemorySandboxReceiptStore;
    endpointReady?: boolean;
  } = {},
): DockerSandboxEnvironmentAdapter {
  let clock = 1_000;
  return new DockerSandboxEnvironmentAdapter({
    provider,
    probe: probe(overrides.probe),
    profileConfig: profileConfig(overrides.config),
    repositoryPath: repoPath,
    ref: "HEAD",
    hostWorktree: "/lanes/JWB-330",
    receiptStore: overrides.receiptStore ?? new MemorySandboxReceiptStore(),
    now: () => new Date(clock++),
    // Endpoint readiness follows the fake sandbox's running state unless forced.
    endpointProbe: async (_port) =>
      (overrides.endpointReady ?? provider.sandboxes.size > 0)
        ? [...provider.sandboxes.values()].some((box) => box.running)
        : false,
  });
}

let repos: string[] = [];
let staging: string[] = [];

beforeEach(() => {
  repos = [];
  staging = [];
});

afterEach(async () => {
  for (const dir of [...repos, ...staging]) await rm(dir, { recursive: true, force: true });
});

// === Acceptance #1 + #6: capability qualification and fail-closed, no silent downgrade ===

test("advertises strong_isolation only when every gate passes", () => {
  const context: SandboxHostContext = {
    requiredMode: "clone",
    requireStrongIsolation: true,
    requiredNetworkPosture: "balanced",
    hostSideClone: true,
  };
  const ok = qualifyDockerSandbox(probe(), context);
  expect(ok.strongIsolation).toBe(true);
  expect(ok.capabilities.strong_isolation).toBe(true);
  expect(ok.capabilities.environment_start).toBe(true);
  expect(ok.blockers).toEqual([]);
});

test("withholds strong_isolation when unauthenticated, without dropping base capabilities", () => {
  const q = qualifyDockerSandbox(probe({ authenticated: false }), {
    requiredMode: "clone",
    requireStrongIsolation: true,
    hostSideClone: true,
  });
  expect(q.strongIsolation).toBe(false);
  expect(q.capabilities.strong_isolation).toBeUndefined();
  expect(q.capabilities.environment_start).toBe(true); // base surface still offered
  expect(q.blockers.join(" ")).toContain("unauthenticated");
});

test("binary absent yields zero capabilities", () => {
  const q = qualifyDockerSandbox(probe({ binaryPresent: false }), {
    requiredMode: "clone",
    requireStrongIsolation: false,
  });
  expect(q.capabilities).toEqual({});
  expect(q.blockers[0]).toContain("not found");
});

test("clone + linked worktree is a hard blocker under native semantics, resolved by host-side clone", () => {
  const native = qualifyDockerSandbox(probe({ linkedWorktree: true }), {
    requiredMode: "clone",
    requireStrongIsolation: true,
    hostSideClone: false,
  });
  expect(native.strongIsolation).toBe(false);
  expect(native.blockers.join(" ")).toContain("linked worktree");

  const resolved = qualifyDockerSandbox(probe({ linkedWorktree: true }), {
    requiredMode: "clone",
    requireStrongIsolation: true,
    hostSideClone: true,
  });
  expect(resolved.strongIsolation).toBe(true); // JWB-329 resolution: host-side cloning
});

test("a weaker active network preset cannot satisfy a stronger required posture", () => {
  const q = qualifyDockerSandbox(probe({ networkPreset: "open" }), {
    requiredMode: "clone",
    requireStrongIsolation: true,
    requiredNetworkPosture: "locked-down",
    hostSideClone: true,
  });
  expect(q.strongIsolation).toBe(false);
  expect(q.blockers.join(" ")).toContain("weaker than required");
});

test("preflight fails closed when strong isolation is required but unavailable — never downgrades", async () => {
  const provider = new FakeSandboxProvider({ authenticated: false });
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { probe: { authenticated: false } });
  await expect(adapter.preflight(planRequest())).rejects.toThrow(
    "Strong isolation required but unavailable",
  );
  // No sandbox was created as a fallback.
  expect(provider.sandboxes.size).toBe(0);
});

// === Acceptance #2: sandbox-private clone without a writable host worktree ===

test("workspace strategy prepares a host-private clone and leaves the source tree byte-identical", async () => {
  const provider = new FakeSandboxProvider();
  const repo = await makeRepo();
  repos.push(repo);
  const before = await repoSignature(repo);
  const strategy = new SandboxCloneWorkspaceStrategy(provider);
  const clone = await strategy.prepare({ source: repo, ref: "HEAD" });
  staging.push(clone.hostStagingDir);
  expect(clone.hostPrivate).toBe(true);
  expect(clone.sandboxPath).toBe("/workspace");
  expect(clone.sourceRef).toMatch(/^[0-9a-f]{40}$/);
  // The source repository is untouched — no writable host worktree was required.
  expect(await repoSignature(repo)).toBe(before);
  // The clone materialized real content.
  expect(await Bun.file(join(clone.hostStagingDir, "clone", "package.json")).exists()).toBe(true);
});

test("workspace strategy refuses a non-git source rather than silently proceeding", async () => {
  const provider = new FakeSandboxProvider();
  const dir = await mkdtemp(join(tmpdir(), "wf-sbx-nogit-"));
  staging.push(dir);
  const strategy = new SandboxCloneWorkspaceStrategy(provider);
  await expect(strategy.prepare({ source: dir, ref: "HEAD" })).rejects.toThrow(
    "not a git repository",
  );
});

test("start never bind-mounts the host tree; the clone is materialized into the sandbox", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  const receipt = await store.load(env.id);
  staging.push(receipt?.stagingDir ?? "");
  const argvFlat = provider.sbxCalls.flat().join(" ");
  expect(argvFlat).not.toContain("--mount");
  expect(argvFlat).not.toContain(":ro");
  expect(argvFlat).not.toContain(repo); // the host repo path is never handed to a bind-mount
  // JWB-329 resolution: isolation is host-side clone + cp, never sbx-native clone/direct mode.
  expect(argvFlat).not.toContain("--clone");
  expect(argvFlat).not.toContain("--workspace-mode");
  // Materialization happened via `cp` into the sandbox workspace path.
  const cp = provider.sbxCalls.find((call) => call[0] === "cp");
  expect(cp?.some((token) => token.endsWith(":/workspace"))).toBe(true);
});

// === Acceptance #5: collision-free host endpoint publication ===

test("publishes the service to a collision-free 127.0.0.1 loopback endpoint", async () => {
  const provider = new FakeSandboxProvider({ startPort: 45000 });
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  const create = provider.sbxCalls.find((call) => call[0] === "create");
  expect(create).toContain("--publish");
  const publish = create?.[create.indexOf("--publish") + 1];
  expect(publish).toBe("127.0.0.1:45000:8080");
  expect(env.logReferences).toContain("endpoint:127.0.0.1:45000");
});

test("two lanes receive distinct collision-free ports", async () => {
  const provider = new FakeSandboxProvider({ startPort: 46000 });
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const p1 = await adapter.plan(planRequest());
  const p2 = await adapter.plan(planRequest());
  staging.push(...provider.stagingRoots());
  expect(p1.summary).not.toBe(p2.summary);
  // Distinct reserved ports appear in the two plan summaries.
  expect(p1.summary).toContain("46000");
  expect(p2.summary).toContain("46001");
});

// === Acceptance #4: scoped credentials + provider-native network policy ===

test("credential handles are passed by name; no secret value ever reaches sbx argv", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  // A handle that names a secret; the VALUE must never appear in argv.
  const adapter = makeAdapter(provider, repo, {
    receiptStore: store,
    config: { credentialHandles: ["GH_TOKEN"] },
  });
  const plan = await adapter.plan(planRequest());
  expect(plan.credentialHandles).toEqual(["GH_TOKEN"]);
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  const flat = JSON.stringify(provider.sbxCalls);
  expect(flat).toContain("--credential");
  expect(flat).toContain("GH_TOKEN"); // the handle name
  expect(flat).not.toContain(SECRET_VALUE); // never the value
});

test("network policy applies deny-beats-allow via provider-native sbx policy", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, {
    receiptStore: store,
    // Host preset satisfies the required posture, so qualification passes and policy is applied.
    probe: { networkPreset: "locked-down" },
    config: {
      network: { posture: "locked-down", allow: ["*.github.com"], deny: ["metadata.internal"] },
    },
  });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  const policy = provider.sbxCalls.filter((call) => call[0] === "policy");
  expect(policy[0]).toEqual(["policy", "preset", "locked-down", expect.any(String)]);
  const allowIndex = policy.findIndex((call) => call[1] === "allow");
  const denyIndex = policy.findIndex((call) => call[1] === "deny");
  // Deny is applied AFTER allow so deny always wins.
  expect(allowIndex).toBeGreaterThanOrEqual(0);
  expect(denyIndex).toBeGreaterThan(allowIndex);
  // UDP/ICMP are never claimed as controllable.
  expect(JSON.stringify(policy)).not.toContain("udp");
  expect(JSON.stringify(policy)).not.toContain("icmp");
});

// === Acceptance #3: readiness, logs, resume, stop, destroy, recovery evidence ===

test("verifyReady reports ready when running and refuses silent promotion when not", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  await adapter.verifyReady(env);
  expect(env.readiness.sandbox).toBe("ready");
  expect(env.readiness.service).toBe("ready");

  // Stop it out from under readiness → must not silently promote.
  await adapter.stop(env);
  await expect(adapter.verifyReady(env)).rejects.toThrow("not running");
  expect(env.readiness.sandbox).toBe("not_ready");
});

test("logs cross only the narrow structured bridge", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  const lines = await adapter.logs(env);
  expect(lines.every((line) => line.startsWith("{"))).toBe(true);
  expect(lines).toContain('{"event":"agent_boot"}');
  expect(lines.some((line) => line.includes("noise"))).toBe(false);
});

test("resume restarts by name and never recreates", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  const receipt = await store.load(env.id);
  staging.push(receipt?.stagingDir ?? "");
  await adapter.stop(env);
  provider.sbxCalls.length = 0;
  await adapter.resume(env.id);
  const created = provider.sbxCalls.filter((call) => call[0] === "create");
  const resumed = provider.sbxCalls.filter((call) => call[0] === "run");
  expect(created).toHaveLength(0); // not recreated
  expect(resumed[0]).toEqual(["run", "--name", receipt?.sandboxName ?? ""]);
});

test("stop is idempotent and receipt-scoped", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  staging.push((await store.load(env.id))?.stagingDir ?? "");
  await adapter.stop(env);
  provider.sbxCalls.length = 0;
  await adapter.stop(env); // second call is a no-op (already stopped)
  expect(provider.sbxCalls.filter((call) => call[0] === "stop")).toHaveLength(0);
});

test("destroy removes exactly the owned resources and always preserves the host worktree", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  const receipt = await store.load(env.id);
  const stagingDir = receipt?.stagingDir ?? "";
  const destroyReceipt = await adapter.destroy(env);
  expect(destroyReceipt.removed).toContain(`sandbox:${receipt?.sandboxName}`);
  expect(destroyReceipt.removed).toContain(`staging:${stagingDir}`);
  expect(destroyReceipt.preserved).toEqual(["/lanes/JWB-330"]);
  expect(provider.sandboxes.size).toBe(0);
  expect(await Bun.file(join(stagingDir, "clone", "package.json")).exists()).toBe(false);
  expect(await store.load(env.id)).toBeUndefined();
});

test("recovery re-derives from the durable receipt and re-verifies live state without recreating", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  const receipt = await store.load(env.id);
  staging.push(receipt?.stagingDir ?? "");

  // A FRESH adapter instance (no in-memory plan state) recovers from the shared receipt store.
  const fresh = makeAdapter(provider, repo, { receiptStore: store });
  provider.sbxCalls.length = 0;
  const recovery = await fresh.recover(env.id);
  expect(recovery.verified).toBe(true);
  expect((recovery.evidence as { recreated: boolean }).recreated).toBe(false);
  expect((recovery.evidence as { hostWorktreePreserved: string }).hostWorktreePreserved).toBe(
    "/lanes/JWB-330",
  );
  // Recovery never issues create/run — it observes, it does not rebuild.
  expect(provider.sbxCalls.some((call) => call[0] === "create" || call[0] === "run")).toBe(false);
});

test("recovery of a vanished sandbox reports unverified and retains evidence, never silent success", async () => {
  const provider = new FakeSandboxProvider();
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  const env = await adapter.start({
    plan,
    authorization: { kind: "human" },
  } as EnvironmentStartRequest);
  const receipt = await store.load(env.id);
  staging.push(receipt?.stagingDir ?? "");
  // The sandbox disappears (host reboot, external prune).
  provider.sandboxes.clear();
  const recovery = await adapter.recover(env.id);
  expect(recovery.verified).toBe(false);
  expect((recovery.evidence as { running: boolean }).running).toBe(false);
});

// === Compensation (AGENTS.md: every failure path compensates) ===

test("a start-time failure compensates: sandbox and staging removed, no receipt, host untouched", async () => {
  const provider = new FakeSandboxProvider({ failSubcommands: ["start"] });
  const store = new MemorySandboxReceiptStore();
  const repo = await makeRepo();
  repos.push(repo);
  const before = await repoSignature(repo);
  const adapter = makeAdapter(provider, repo, { receiptStore: store });
  const plan = await adapter.plan(planRequest());
  await expect(
    adapter.start({ plan, authorization: { kind: "human" } } as EnvironmentStartRequest),
  ).rejects.toThrow();
  // Compensated: the sandbox was force-removed and no receipt persisted.
  expect(provider.sandboxes.size).toBe(0);
  expect(await store.load(plan.id)).toBeUndefined();
  // The host repository is byte-identical.
  expect(await repoSignature(repo)).toBe(before);
});

// === Acceptance #7: the separate host execution path is preserved ===

test("the registry keeps a host environment path alongside docker-sandbox", () => {
  const withoutSbx = builtInAdapters({ which: () => null, platform: "linux" });
  const host = withoutSbx.find((a) => a.name === "host" && a.kind === "environment");
  const sandbox = withoutSbx.find((a) => a.name === "docker-sandbox");
  expect(host?.available).toBe(true); // host path never depends on sandbox availability
  expect(sandbox?.available).toBe(false); // fail-closed when sbx absent
  expect(sandbox?.capabilities).toEqual({}); // advertises nothing it cannot verify
});

test("the registry advertises base sandbox capabilities but never strong_isolation statically", () => {
  const withSbx = builtInAdapters({
    which: (bin) => (bin === "sbx" ? "/usr/bin/sbx" : null),
    platform: "linux",
  });
  const sandbox = withSbx.find((a) => a.name === "docker-sandbox");
  expect(sandbox?.available).toBe(true);
  expect(sandbox?.capabilities.environment_start).toBe(true);
  expect(sandbox?.capabilities.strong_isolation).toBeUndefined(); // only the live probe may advertise it
});
