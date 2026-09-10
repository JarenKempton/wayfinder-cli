import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  bash,
  fish,
  formatDocPage,
  formatMessage,
  getDocPageSync,
  parseSync,
  suggestSync,
  zsh,
} from "@optique/core";
import { generateManPageSync } from "@optique/man";
import { Command } from "commander";
import { createApplication } from "../../src/application.ts";
import { validateConfigurationOutput } from "../../src/configuration/project-files.ts";
import { commanderTree } from "./commander.ts";
import { optiqueTree } from "./optique.ts";
import { typedZodProbe } from "./typed-zod.ts";

typedZodProbe();
for (const name of ["Commander", "Optique"] as const) {
  const cwd = mkdtempSync(join(tmpdir(), "wf-library-probe-"));
  const statePath = join(cwd, "state.sqlite");
  const services = { configuration: { cwd, statePath }, statePath };
  const app = createApplication(services);
  const parser = optiqueTree(app);
  const execute = async (args: string[]) => {
    if (name === "Commander") return commanderTree(app).execute(args);
    const parsed = parseSync(parser, args);
    if (!parsed.success) throw new Error("Invalid command line; input omitted");
    return parsed.value();
  };
  try {
    if (name === "Optique") {
      const page = getDocPageSync(parser, ["config", "edit"]);
      assert(page);
      const help = formatDocPage("wayfinder", page);
      assert(help.includes("--set"));
      assert(generateManPageSync(parser, { name: "wayfinder", section: 1 }).includes("config"));
      const completions = suggestSync(parser, ["config", "edit", "--f"]);
      assert(completions.some((entry) => entry.kind === "literal" && entry.text === "--follow"));
      const rootSuggestions = suggestSync(parser, [""]);
      assert(!rootSuggestions.some((entry) => entry.kind === "literal" && entry.text === "stop"));
      let calls = 0;
      const bound = optiqueTree(
        createApplication({
          ...services,
          lifecycle: () => {
            calls++;
            throw new Error("No lifecycle execution authorized");
          },
        }),
      );
      assert(
        suggestSync(bound, [""]).some((entry) => entry.kind === "literal" && entry.text === "stop"),
      );
      assert(getDocPageSync(bound));
      assert.equal(calls, 0);
      for (const shell of [bash, zsh, fish]) {
        const script = shell.generateScript("wayfinder");
        assert(script.includes("wayfinder"));
        assert(!script.includes("--follow")); // candidates queried at runtime, not frozen in script
      }
      console.log(
        "PASS Optique: derived help, man, Bash/zsh/fish scripts and live candidate queries; unbound stop absent, bound stop present; zero lifecycle calls",
      );
      console.log(help.trim());
    } else {
      const { root } = commanderTree(app);
      assert(!root.commands.some((command) => command.name() === "stop"));
      const config = root.commands.find((command) => command.name() === "config");
      const edit = config?.commands.find((command) => command.name() === "edit");
      assert(edit?.helpInformation().includes("--set <VALUES...>"));
      console.log(
        "PASS Commander: help and registered commands derive from actual available actions",
      );
    }
    assert.deepEqual(readdirSync(cwd), []);
    await assert.rejects(() => execute(["stop", "unavailable"]));
    await execute(["init"]);
    const path = join(cwd, "wayfinder.toml");
    const original = readFileSync(path);
    await assert.rejects(() => execute(["init"]), /EEXIST/);
    assert.deepEqual(readFileSync(path), original);
    await execute(["config", "show"]);
    assert(!existsSync(statePath));
    const edit = validateConfigurationOutput(
      await execute(["config", "edit", "--set", "model", "chosen model"]),
    );
    assert.equal(edit.configuration.settings.model, "chosen model");
    const followed = validateConfigurationOutput(
      await execute(["config", "edit", "--follow", "model"]),
    );
    assert.equal(followed.configuration.settings.model, undefined);
    for (const args of [
      ["config", "edit", "--set", "model"],
      ["config", "edit", "--set", "model", "one", "extra"],
      ["config", "edit", "--follow", "unknown-setting"],
      ["config", "edit", "--set", "model", "one", "--follow", "model"],
      ["config", "show", "--unknown"],
    ])
      await assert.rejects(() => execute(args));
    const db = readFileSync(statePath);
    const viaEquals = validateConfigurationOutput(
      await execute(["config", "show", `--path=${path}`]),
    );
    assert.equal(viaEquals.path, path);
    assert.deepEqual(readFileSync(statePath), db);
    console.log(
      `PASS ${name}: real init/non-overwrite, read-only show, set/follow via SQLite, spaces and equals syntax, malformed inputs rejected`,
    );
    if (name === "Optique") {
      await assert.rejects(() => execute(["config", "show", "--json", "--json"]));
      console.log("PASS Optique: duplicate flag rejected");
    } else {
      await execute(["config", "show", "--json", "--json"]);
      console.log("GAP Commander: duplicate flag accepted; Wayfinder currently rejects it");
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
const nativePair = new Command()
  .option("--set <KEY> <VALUE>")
  .exitOverride()
  .configureOutput({ writeErr: () => {} });
assert.throws(() => nativePair.parse(["--set", "model", "chosen"], { from: "user" }));
console.log(
  "GAP Commander: native two-placeholder option does not consume two values; bridge uses variadic + action tuple validation",
);
try {
  nativePair.parse(["--DO_NOT_ECHO"], { from: "user" });
} catch (error) {
  assert(String(error).includes("DO_NOT_ECHO"));
}
const unsafe = parseSync(optiqueTree(createApplication()), ["DO_NOT_ECHO"]);
assert(!unsafe.success);
assert(formatMessage(unsafe.error).includes("DO_NOT_ECHO"));
console.log(
  "GAP both: default parser diagnostics can repeat input; retain a sanitized error boundary",
);
const builtIn = parseArgs({ args: ["--path=example.toml"], options: { path: { type: "string" } } });
assert.equal(builtIn.values.path, "example.toml");
console.log(
  "PASS Bun node:util.parseArgs: equals syntax; command routing/help/completions still need another layer",
);
console.log(
  `All probe assertions passed on ${process.platform}/${process.arch}, Bun ${Bun.version}. No tracker/host/setup calls.`,
);
