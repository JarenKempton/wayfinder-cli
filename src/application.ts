import { adapterActions } from "./actions/adapters.ts";
import { composeActions } from "./actions/catalog.ts";
import { configurationActions } from "./actions/configuration.ts";
import { type ActionTree, defineAction } from "./actions/definition.ts";
import { frontierActions } from "./actions/frontier.ts";
import { choice, optional, positional, text } from "./actions/input.ts";
import { reconciliationActions } from "./actions/reconciliation.ts";
import { runActions } from "./actions/runs.ts";
import { withStore } from "./actions/store.ts";
import { builtInAdapters } from "./adapters.ts";
import { completionCandidates, completionScript } from "./completions.ts";
import { manPage } from "./manpage.ts";
import { databasePath } from "./paths.ts";
import { PROTOCOL_VERSION } from "./protocol.ts";
import type { RuntimeServices } from "./runtime-services.ts";
import { VERSION } from "./version.ts";

export function createApplication(services: RuntimeServices = {}) {
  let tree: ActionTree;
  const actions = composeActions(
    configurationActions(
      services.configuration ?? {
        cwd: process.cwd(),
        ...(services.statePath ? { statePath: services.statePath } : {}),
      },
    ),
    frontierActions(),
    adapterActions(),
    runActions(services),
    reconciliationActions(services),
    {
      doctor: defineAction({
        description: "Check local state storage and adapter discovery.",
        input: {},
        dependencies: {},
        handler: () =>
          withStore(services, () => ({
            ok: true,
            version: VERSION,
            protocolVersion: PROTOCOL_VERSION,
            database: services.statePath ?? databasePath(),
            adapters: builtInAdapters().length,
          })),
      }),
      version: defineAction({
        aliases: ["--version"],
        description: "Print the embedded build version.",
        input: {},
        dependencies: {},
        handler: () => VERSION,
      }),
      completions: defineAction({
        description: "Print shell completion for currently available actions.",
        input: {
          shell: positional(choice("Completion shell.", ["bash", "zsh", "fish"] as const)),
          at: optional({
            ...text(
              "Return current completion candidates for a command prefix (empty for root).",
              "PREFIX",
            ),
            parse(value: unknown) {
              if (typeof value !== "string") throw new Error("Expected command prefix");
              return value;
            },
          }),
        },
        dependencies: {},
        handler: (_, input): string =>
          input.at === undefined
            ? completionScript(input.shell)
            : completionCandidates(tree, input.at.split(" ").filter(Boolean)).join("\n"),
      }),
      man: defineAction({
        description: "Print the manual for currently available actions.",
        input: {},
        dependencies: {},
        handler: (): string => manPage(VERSION, tree),
      }),
    },
  );
  tree = actions;
  return actions;
}
