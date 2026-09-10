import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableActions, composeActions, registeredActions } from "../src/actions/catalog.ts";
import { actionHelp, dispatch } from "../src/actions/command-line.ts";
import { defineAction, dependency } from "../src/actions/definition.ts";
import { optional, positional, text } from "../src/actions/input.ts";
import { createApplication } from "../src/application.ts";
import { completionCandidates } from "../src/completions.ts";
import { manPage } from "../src/manpage.ts";
import type { RuntimeServices } from "../src/runtime-services.ts";

function example(service?: (name: string) => string) {
  return {
    sample: {
      greet: defineAction({
        description: "Greet through the actually supplied service.",
        input: {
          name: positional(text("Person to greet.", "NAME")),
          punctuation: optional(text("Ending punctuation.", "TEXT")),
        },
        dependencies: { greet: dependency(service, "greeting service") },
        handler: ({ greet }, input) => greet(input.name) + (input.punctuation ?? "!"),
      }),
    },
  };
}

test("one added action supplies typed calls, CLI dispatch, help, manual and completions", async () => {
  const app = example((name) => `Hello ${name}`);
  expect(await app.sample.greet.execute({ name: "Jaren" })).toBe("Hello Jaren!");
  const output: string[] = [];
  await dispatch(app, ["sample", "greet", "Jaren", "--punctuation", "."], (line) =>
    output.push(line),
  );
  expect(output).toEqual(["Hello Jaren."]);
  expect(actionHelp(app)).toContain("sample greet NAME [--punctuation TEXT]");
  expect(manPage("test", app)).toContain("Greet through the actually supplied service.");
  expect(completionCandidates(app, [])).toEqual(["sample"]);
  expect(completionCandidates(app, ["sample"])).toEqual(["greet"]);
  expect(completionCandidates(app, ["sample", "greet"])).toContain("--punctuation");
  const json = JSON.parse(actionHelp(app, [], true));
  expect(json.actions[0].input.punctuation.values).toEqual(["TEXT"]);
});

test("unbound actions are unavailable to every interface and fail before invocation", async () => {
  const app = example();
  expect(availableActions(app)).toEqual([]);
  expect(completionCandidates(app, [])).toEqual([]);
  expect(actionHelp(app)).not.toContain("sample greet");
  expect(manPage("test", app)).not.toContain("sample greet");
  expect(app.sample.greet.availability).toEqual({
    available: false,
    reasons: ["no greeting service is composed"],
  });
  await expect(app.sample.greet.execute({ name: "Jaren" })).rejects.toThrow("no greeting service");
  await expect(dispatch(app, ["sample", "greet", "Jaren"], () => {})).rejects.toThrow(
    "no greeting service",
  );
});

test("runtime dependencies govern actual application help, manual, completion and dispatch together", async () => {
  const directory = mkdtempSync(join(tmpdir(), "wf-actions-"));
  try {
    const services: RuntimeServices = {
      statePath: join(directory, "state.db"),
      configuration: { cwd: directory, statePath: join(directory, "state.db") },
    };
    const unavailable = createApplication(services);
    expect(actionHelp(unavailable)).not.toContain("wayfinder stop");
    expect(completionCandidates(unavailable, [])).not.toContain("stop");
    expect(completionCandidates(unavailable, ["claim"])).toEqual(["show"]);
    expect(completionCandidates(unavailable, ["supervisor"])).toEqual(["status"]);
    await expect(unavailable.stop.execute({ run: "example" })).rejects.toThrow(
      "no managed lifecycle adapter",
    );
    expect(readdirSync(directory)).toEqual([]);
    let lifecycleCalls = 0;
    services.lifecycle = () => {
      lifecycleCalls++;
      throw new Error("Per-run preflight has not been requested");
    };
    const available = createApplication(services);
    expect(actionHelp(available)).toContain("wayfinder stop");
    expect(manPage("test", available)).toContain(".B stop");
    expect(completionCandidates(available, [])).toContain("stop");
    expect(lifecycleCalls).toBe(0);
    expect(readdirSync(directory)).toEqual([]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test.each(
  [
    ["sample", "greet", "Jaren", "--unknown"],
    ["sample", "greet", "Jaren", "--punctuation"],
    ["sample", "greet", "Jaren", "--punctuation", "!", "--punctuation", "?"],
    ["sample", "greet"],
    ["sample", "greet", "Jaren", "unexpected"],
  ].map((args) => ({ args })),
)("shared parser rejects malformed inputs before handlers: %j", async ({ args }) => {
  let calls = 0;
  await expect(
    dispatch(
      example((name) => {
        calls++;
        return name;
      }),
      args,
      () => {},
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test("direct typed calls also validate untrusted inputs at runtime", async () => {
  let calls = 0;
  const action = example((name) => {
    calls++;
    return name;
  }).sample.greet;
  await expect(action.invoke({ name: 17 })).rejects.toThrow("Invalid name");
  await expect(action.invoke({ name: "Jaren", unknown: "DO_NOT_ECHO" })).rejects.toThrow(
    "Unknown action input field",
  );
  expect(calls).toBe(0);
});

test("current completion queries derive subcommands and options from the live tree", async () => {
  const app = createApplication();
  expect(await app.completions.execute({ shell: "bash", at: "config" })).toBe("show\nedit");
  expect(await app.completions.execute({ shell: "bash", at: "config edit" })).toContain("--follow");
  expect(await app.completions.execute({ shell: "bash", at: "" })).not.toContain("stop");
  expect(registeredActions(app).some((entry) => entry.command.join(" ") === "pickup")).toBe(false);
});

// These compile-only examples fail typecheck if action/input/dependency types become permissive.
export function actionTypeChecks(app: ReturnType<typeof createApplication>) {
  // @ts-expect-error Action names must exist on the application.
  void app.config.shwo.execute({});
  // @ts-expect-error show has no editor option.
  void app.config.show.execute({ editor: "vi" });
  // @ts-expect-error personal setting keys come from the setting schema.
  void app.config.edit.execute({ set: ["unknown", "value"] });
  // @ts-expect-error required positional input cannot be omitted.
  void app.stop.execute({});
  const action = example((name) => name).sample.greet;
  // @ts-expect-error handler result is inferred as a string, not a number.
  const result: Promise<number> = action.execute({ name: "Jaren" });
  return result;
}

test("duplicate registrations cannot silently overwrite an action", () => {
  const app = example((name) => name);
  expect(() => {
    // @ts-expect-error Duplicate registration is rejected by typecheck and at the untyped boundary.
    composeActions(app, app);
  }).toThrow("Duplicate action registration");
});
