import { type CapabilitySet, capabilities } from "./domain.ts";
import { namedHarnessCapabilities, namedHarnessExecutable } from "./harness-adapters.ts";

export type AdapterKind = "tracker" | "harness" | "workspace" | "environment";

export interface AdapterDescriptor {
  name: string;
  kind: AdapterKind;
  bundled: boolean;
  available: boolean;
  executable?: string;
  capabilities: CapabilitySet;
}

const harnessExecutables = {
  t3: namedHarnessExecutable("t3"),
  pi: namedHarnessExecutable("pi"),
  claude: namedHarnessExecutable("claude"),
  codex: namedHarnessExecutable("codex"),
  cursor: namedHarnessExecutable("cursor"),
  opencode: namedHarnessExecutable("opencode"),
  command: undefined,
};

export function builtInAdapters(): AdapterDescriptor[] {
  const trackers = ["jira", "linear", "github", "markdown"].map<AdapterDescriptor>((name) => ({
    name,
    kind: "tracker",
    bundled: true,
    available: false,
    capabilities: {},
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
        capabilities:
          name === "command"
            ? capabilities()
            : namedHarnessCapabilities(name as Exclude<keyof typeof harnessExecutables, "command">),
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
