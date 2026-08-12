import { type CapabilitySet, capabilities } from "./domain.ts";
import {
  type CommandToken,
  commandHarnessAvailable,
  commandHarnessCapabilities,
  type NamedHarnessName,
  namedHarnessAvailable,
  namedHarnessCapabilities,
  namedHarnessExecutable,
} from "./harness-adapters.ts";

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
  pi: namedHarnessExecutable("pi"),
  claude: namedHarnessExecutable("claude"),
  codex: namedHarnessExecutable("codex"),
  cursor: namedHarnessExecutable("cursor"),
  opencode: namedHarnessExecutable("opencode"),
};

export interface AdapterDiscoveryPlatform {
  which(executable: string): string | null;
  platform: NodeJS.Platform;
}

export interface AdapterRegistryConfiguration {
  command?: { argv: readonly CommandToken[] };
}

const bunDiscoveryPlatform: AdapterDiscoveryPlatform = {
  which: Bun.which,
  platform: process.platform,
};

export function builtInAdapters(
  platform: AdapterDiscoveryPlatform = bunDiscoveryPlatform,
  configuration: AdapterRegistryConfiguration = {},
): AdapterDescriptor[] {
  const trackers = ["jira", "linear", "github", "markdown"].map<AdapterDescriptor>((name) => ({
    name,
    kind: "tracker",
    bundled: true,
    available: false,
    capabilities: {},
  }));

  const namedCommandHarnesses = Object.entries(harnessExecutables).map<AdapterDescriptor>(
    ([name, executable]) => {
      const available = namedHarnessAvailable(name as NamedHarnessName, platform);
      return {
        name,
        kind: "harness",
        bundled: true,
        available,
        ...(executable ? { executable } : {}),
        capabilities: namedHarnessCapabilities(name as NamedHarnessName, platform),
      };
    },
  );
  const commandArgv = configuration.command?.argv;
  const commandExecutable = commandArgv?.[0];
  const harnesses: AdapterDescriptor[] = [
    ...namedCommandHarnesses,
    {
      name: "command",
      kind: "harness",
      bundled: true,
      available: commandHarnessAvailable(commandArgv, platform),
      ...(commandExecutable ? { executable: commandExecutable } : {}),
      capabilities: commandHarnessCapabilities(commandArgv, platform),
    },
    {
      name: "t3",
      kind: "harness",
      bundled: false,
      available: false,
      capabilities: capabilities(),
    },
  ];

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
