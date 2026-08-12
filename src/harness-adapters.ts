import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import type { HarnessAdapter, LaunchReceipt, LaunchRequest } from "./contracts.ts";
import { HarnessLaunchError } from "./contracts.ts";
import type { CapabilitySet } from "./domain.ts";
import { capabilities } from "./domain.ts";

export type NamedHarnessName = "pi" | "claude" | "codex" | "cursor" | "opencode";
export type HarnessName = "command" | NamedHarnessName;
export type CommandToken =
  | string
  | "{prompt}"
  | "{workspace}"
  | "{model}"
  | "{effort}"
  | "{context}";

export interface HarnessProcess {
  readonly pid: number;
  readonly exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface HarnessPlatform {
  which(executable: string): string | null;
  spawn(argv: readonly string[], cwd: string): HarnessProcess;
  platform: NodeJS.Platform;
}

export interface CommandHarnessOptions {
  name?: HarnessName;
  argv: readonly CommandToken[];
  platform?: HarnessPlatform;
  supportedPlatforms?: readonly NodeJS.Platform[];
}

const bunPlatform: HarnessPlatform = {
  which: Bun.which,
  platform: process.platform,
  spawn(argv, cwd) {
    const child = Bun.spawn([...argv], {
      cwd,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return { pid: child.pid, exited: child.exited, kill: (signal) => child.kill(signal) };
  },
};

/** An argv-only harness. It owns child handles, never shell text or bare-PID signaling. */
export class CommandHarnessAdapter implements HarnessAdapter {
  readonly name: HarnessName;
  readonly #argv: readonly CommandToken[];
  readonly #platform: HarnessPlatform;
  readonly #supportedPlatforms: readonly NodeJS.Platform[] | undefined;
  readonly #children = new Map<string, HarnessProcess>();
  readonly #exited = new Set<string>();

  constructor(options: CommandHarnessOptions) {
    if (options.argv.length === 0 || !options.argv[0]) throw new Error("Harness argv is required");
    this.name = options.name ?? "command";
    this.#argv = [...options.argv];
    this.#platform = options.platform ?? bunPlatform;
    this.#supportedPlatforms = options.supportedPlatforms;
  }

  async describe(): Promise<CapabilitySet> {
    const prepare = this.#argv.includes("{prompt}") ? (["prompt_generation"] as const) : [];
    if (!this.#available()) return capabilities(...prepare);
    return capabilities(
      ...prepare,
      "process_launch",
      ...(this.#argv.includes("{model}") ? (["model_selection"] as const) : []),
      ...(this.#argv.includes("{effort}") ? (["reasoning_selection"] as const) : []),
      ...(this.#argv.includes("{context}") ? (["context_selection"] as const) : []),
    );
  }

  async preflight(request: LaunchRequest): Promise<void> {
    if (!this.#platformSupported())
      throw new Error(`${this.name} is not supported on ${this.#platform.platform}`);
    const executable = this.#argv[0] as string;
    if (!this.#platform.which(executable))
      throw new Error(`Harness executable not found: ${executable}`);
    await access(request.workspace.path);
    this.#render(request);
  }

  async launch(request: LaunchRequest): Promise<LaunchReceipt> {
    await this.preflight(request);
    const id = `${this.name}:${randomUUID()}`;
    try {
      const child = this.#platform.spawn(this.#render(request), request.workspace.path);
      this.#children.set(id, child);
      void child.exited.finally(() => {
        this.#children.delete(id);
        this.#exited.add(id);
      });
      return { sessionId: id, pid: child.pid, tier: "launch" };
    } catch (error) {
      throw new HarnessLaunchError(error instanceof Error ? error.message : String(error));
    }
  }

  async stop(receipt: LaunchReceipt): Promise<void> {
    const id = receipt.sessionId;
    const child = id ? this.#children.get(id) : undefined;
    if (id && this.#exited.delete(id)) return;
    if (!id || !child)
      throw new Error("Harness child handle is unavailable; refusing bare-PID stop");
    child.kill("SIGTERM");
    await child.exited;
    this.#children.delete(id);
  }

  #available(): boolean {
    return this.#platformSupported() && this.#platform.which(this.#argv[0] as string) !== null;
  }

  #platformSupported(): boolean {
    return !this.#supportedPlatforms || this.#supportedPlatforms.includes(this.#platform.platform);
  }

  #render(request: LaunchRequest): string[] {
    const prompt = request.context
      ? `Work on ${request.ticket.ref}.\n\n${request.context}`
      : `Work on ${request.ticket.ref}.`;
    const values: Record<string, string | undefined> = {
      "{prompt}": prompt,
      "{workspace}": request.workspace.path,
      "{model}": request.model,
      "{effort}": request.effort,
      "{context}": request.context,
    };
    return this.#argv.map((token) => {
      if (!(token in values)) return token;
      const value = values[token];
      if (value === undefined) throw new Error(`Harness argv requires ${token}`);
      return value;
    });
  }
}

interface NamedHarness {
  argv: readonly CommandToken[];
  platforms?: readonly NodeJS.Platform[];
}

const namedHarnesses: Record<NamedHarnessName, NamedHarness> = {
  pi: { argv: ["pi", "-p", "{prompt}"] },
  claude: { argv: ["claude", "-p", "{prompt}"], platforms: ["darwin", "linux"] },
  codex: { argv: ["codex", "exec", "{prompt}"], platforms: ["darwin", "linux"] },
  cursor: { argv: ["cursor-agent", "-p", "{prompt}"], platforms: ["darwin", "linux"] },
  opencode: { argv: ["opencode", "run", "{prompt}"] },
};

export function namedHarnessAdapter(
  name: NamedHarnessName,
  platform?: HarnessPlatform,
): CommandHarnessAdapter {
  const profile = namedHarnesses[name];
  return new CommandHarnessAdapter({
    name,
    argv: profile.argv,
    ...(profile.platforms ? { supportedPlatforms: profile.platforms } : {}),
    ...(platform ? { platform } : {}),
  });
}

export function namedHarnessExecutable(name: NamedHarnessName): string {
  return namedHarnesses[name].argv[0] as string;
}

export function namedHarnessCapabilities(
  name: NamedHarnessName,
  platform: Pick<HarnessPlatform, "which" | "platform"> = bunPlatform,
): CapabilitySet {
  const profile = namedHarnesses[name];
  const prepare = profile.argv.includes("{prompt}") ? (["prompt_generation"] as const) : [];
  const supported = !profile.platforms || profile.platforms.includes(platform.platform);
  if (!supported || !platform.which(profile.argv[0] as string)) return capabilities(...prepare);
  return capabilities(...prepare, "process_launch");
}
