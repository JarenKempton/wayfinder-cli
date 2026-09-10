import { builtInAdapters, findAdapter } from "../adapters.ts";
import { runAdapterConformance } from "../conformance.ts";
import { AdapterClient } from "../protocol.ts";
import { T3Adapter } from "../t3-adapter.ts";
import { VERSION } from "../version.ts";
import { defineAction } from "./definition.ts";
import { flag, positional, text } from "./input.ts";

const probeDescription =
  "Probe an adapter. T3 live lifecycle acceptance is pending a disposable-session approval packet; use adapter test t3 --read-only.";

export function adapterActions() {
  return {
    adapter: {
      list: defineAction({
        description: "Inspect discovered adapter capabilities.",
        input: {},
        dependencies: {},
        handler: () => builtInAdapters(),
      }),
      describe: defineAction({
        description: "Inspect one adapter.",
        input: { name: positional(text("Adapter name.", "NAME")) },
        dependencies: {},
        handler: (_, input) => findAdapter(input.name),
      }),
      test: defineAction({
        description: probeDescription,
        input: {
          target: positional(text("Adapter executable or t3.", "EXECUTABLE")),
          "read-only": flag("For T3, verify discovery/authentication/snapshot only."),
        },
        dependencies: {},
        handler: async (_, input) => {
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
        description: "Verify an adapter using its conformance fixture.",
        input: { fixture: positional(text("Conformance executable.", "FIXTURE")) },
        dependencies: {},
        handler: (_, input) => runAdapterConformance(input.fixture, VERSION),
      }),
    },
  };
}
