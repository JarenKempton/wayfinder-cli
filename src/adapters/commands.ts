import { defineAction } from "../cli/definition.ts";
import { flag, positional, text } from "../cli/schema.ts";
import { VERSION } from "../distribution/version.ts";
import { runAdapterConformance } from "./conformance.ts";
import { AdapterClient } from "./protocol.ts";
import { builtInAdapters, findAdapter } from "./registry.ts";
import { T3Adapter } from "./session-hosts/t3/adapter.ts";

const probeDescription =
  "Probe an adapter. For T3, this command supports read-only discovery only; use adapter test t3 --read-only.";

export function adapterActions() {
  return {
    adapter: {
      list: defineAction({
        description: "Inspect discovered adapter capabilities.",
        input: {},
        handler: () => builtInAdapters(),
      }),
      describe: defineAction({
        description: "Inspect one adapter.",
        input: { name: positional(text("Adapter name.", "NAME")) },
        handler: (input) => findAdapter(input.name),
      }),
      test: defineAction({
        description: probeDescription,
        input: {
          target: positional(text("Adapter executable or t3.", "EXECUTABLE")),
          "read-only": flag("For T3, verify discovery/authentication/snapshot only."),
        },
        handler: async (input) => {
          if (input.target === "t3") {
            if (!input["read-only"]) throw new Error(probeDescription);
            const t3 = new T3Adapter({
              journal: async () => {
                throw new Error("Read-only T3 probe cannot dispatch");
              },
            });
            return {
              ok: true,
              mode: "read-only",
              adapter: "t3",
              ...(await t3.describe()),
              liveLifecycleAcceptance: "pending",
            };
          }
          const command = input.target.endsWith(".ts")
            ? [process.execPath, input.target]
            : input.target;
          return {
            ok: true,
            adapter: await new AdapterClient(command).initialize(
              "tracker",
              "conformance:test",
              VERSION,
            ),
          };
        },
      }),
      conformance: defineAction({
        description: "Check adapter protocol behavior using a dedicated fake executable.",
        input: {
          fixture: positional(
            text("Path to a fake adapter executable used for protocol checks.", "fixture-path"),
          ),
        },
        handler: (input) => runAdapterConformance(input.fixture, VERSION),
      }),
    },
  };
}
