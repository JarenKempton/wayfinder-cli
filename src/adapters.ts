import { type CapabilitySet, capabilities } from "./domain.ts";

export type AdapterKind = "tracker" | "harness" | "workspace" | "environment";

export interface AdapterDescriptor {
  name: string;
  kind: AdapterKind;
  bundled: boolean;
  available: boolean;
  executable?: string;
  capabilities: CapabilitySet;
}

const harnessExecutables: Record<string, string | undefined> = {
  t3: undefined,
  pi: "pi",
  claude: "claude",
  codex: "codex",
  cursor: "cursor",
  opencode: "opencode",
  command: undefined,
};

export function builtInAdapters(): AdapterDescriptor[] {
  const trackers = [
    { name: "jira", available: false, capabilities: {} },
    {
      name: "linear",
      available: Boolean(Bun.env.LINEAR_API_KEY),
      capabilities: capabilities("native_maps", "native_dependencies"),
    },
    {
      name: "github",
      available: Boolean(Bun.env.GITHUB_TOKEN || Bun.env.GH_TOKEN),
      capabilities: capabilities("native_maps", "native_dependencies"),
    },
    { name: "markdown", available: false, capabilities: {} },
  ].map<AdapterDescriptor>((tracker) => ({
    ...tracker,
    kind: "tracker",
    bundled: true,
  }));

  const harnesses = Object.entries(harnessExecutables).map<AdapterDescriptor>(
    ([name, executable]) => {
      const available = name === "command" || (executable ? Bun.which(executable) !== null : false);
      return {
        name,
        kind: "harness",
        bundled: true,
        available,
        ...(executable ? { executable } : {}),
        capabilities: available
          ? capabilities("prompt_generation", "process_launch")
          : capabilities("prompt_generation"),
      };
    },
  );

  return [
    ...trackers,
    ...harnesses,
    {
      name: "git",
      kind: "workspace" as const,
      bundled: true,
      available: true,
      capabilities: capabilities("workspace_prepare"),
    },
  ].toSorted((left, right) =>
    left.kind === right.kind
      ? left.name.localeCompare(right.name)
      : left.kind.localeCompare(right.kind),
  );
}

export function findAdapter(name: string): AdapterDescriptor {
  const builtIn = builtInAdapters().find((adapter) => adapter.name === name);
  if (builtIn) return builtIn;
  const executable = Bun.which(`wayfinder-adapter-${name}`);
  if (!executable) throw new Error(`Adapter not found: ${JSON.stringify(name)}`);
  return {
    name,
    kind: "tracker",
    bundled: false,
    available: true,
    executable,
    capabilities: {},
  };
}
