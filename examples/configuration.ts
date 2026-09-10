import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch } from "../src/actions/command-line.ts";
import { createApplication } from "../src/application.ts";
import { loadConfigurationInstructions } from "../src/configuration/files.ts";
import { validateConfigurationOutput } from "../src/configuration/project-files.ts";
import { planConfiguredLaunch } from "../src/configuration-plan.ts";
import type { Ticket } from "../src/domain.ts";

// Real configuration actions and SQLite, confined to one disposable directory.
const cwd = mkdtempSync(join(tmpdir(), "wayfinder-config-demo-"));
const statePath = join(cwd, "state.sqlite");
const path = join(cwd, "wayfinder.toml");
const app = createApplication({
  configuration: {
    cwd,
    statePath,
    // Deterministic editor for this demo; exercises the real staging/validation/rename path.
    editFile: async (argv) => {
      const staged = argv[1];
      assert(staged);
      writeFileSync(
        staged,
        readFileSync(staged, "utf8").replace("demo-default-v1", "demo-default-v2"),
      );
      return 0;
    },
  },
});
async function cli(args: string[]) {
  console.log(
    `$ wayfinder ${args.map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`,
  );
  const lines: string[] = [];
  await dispatch(app, args, (line) => lines.push(line));
  return lines.join("\n");
}
async function config(args: string[]) {
  const { configuration } = validateConfigurationOutput(JSON.parse(await cli(args)));
  console.log(`model: ${configuration.settings.model} (${configuration.sources.model})`);
  console.log(
    `runtime_mode: ${configuration.settings.runtime_mode} (${configuration.sources.runtime_mode})`,
  );
  return configuration;
}
try {
  copyFileSync(new URL("wayfinder.toml", import.meta.url), join(cwd, "reviewed.toml"));
  copyFileSync(new URL("task.md", import.meta.url), join(cwd, "task.md"));
  console.log("Offline demo: temporary project and SQLite; no tracker, host, or setup calls.");
  console.log("Config results below are summarized by this demo; ordinary CLI results are JSON.\n");
  console.log(await cli(["config", "show", "--help"]));
  console.log(await cli(["completions", "bash", "--at", "config show"]));
  const initial = await config(["init", "--from", "reviewed.toml"]);
  await assert.rejects(() => dispatch(app, ["init"], () => {}), /EEXIST/);
  assert.deepEqual(readFileSync(path), readFileSync(join(cwd, "reviewed.toml")));
  console.log("Second init: refused existing file; original preserved.");
  await config(["config", "show"]);
  assert(!existsSync(statePath));
  console.log("init + show: no SQLite database created.");

  await config(["config", "edit", "--set", "model", "demo-personal"]);
  assert(existsSync(statePath));
  const updated = await config(["config", "edit", "--editor", "demo-editor"]);
  assert.equal(updated.settings.model, "demo-personal");
  assert.notEqual(updated.source.version, initial.source.version);
  assert.equal(initial.settings.model, "demo-default-v1");
  console.log(
    "Project default changed to v2: source hash changed; personal choice and earlier resolution preserved.",
  );
  const configuration = await config(["config", "edit", "--follow", "model"]);
  assert.equal(configuration.settings.model, "demo-default-v2");
  await assert.rejects(
    () => dispatch(app, ["config", "edit", "--set", "runtime_mode", "full-access"], () => {}),
    /conflict/i,
  );
  console.log("Conflicting personal runtime_mode: rejected by project requirement.");

  // This is the same real action used by CLI dispatch; input and result types are inferred.
  const before = readFileSync(statePath);
  const projectBefore = readFileSync(path);
  const result = await app.config.show.execute({ path: "wayfinder.toml" });
  assert.deepEqual(readFileSync(statePath), before);
  assert.deepEqual(readFileSync(path), projectBefore);
  assert.equal(result.configuration.settings.runtime_mode, "approval-required");
  console.log(
    `Typed app.config.show.execute: ${result.configuration.settings.model}; project and database bytes unchanged.`,
  );

  const ticket: Ticket = {
    ref: "jira:example:DEMO:ticket:DEMO-491" as Ticket["ref"],
    map: "jira:example:DEMO:map:DEMO-470" as Ticket["map"],
    kind: "task",
    state: "open",
    status: "To Do",
    order: 0,
    title: "Inspect project configuration",
    description: "Show resolved project defaults, requirements, and personal choices.",
    acceptanceCriteria:
      "- Show configuration without changing durable state.\n- Reject personal choices that conflict with project requirements.",
  };
  const plan = planConfiguredLaunch({
    ticket,
    configuration,
    available: { hosts: ["t3"], agents: ["codex"] },
    instructions: loadConfigurationInstructions(configuration, ticket.kind),
  });
  console.log(`\nPrompt construction only: fake ticket; T3 ${plan.t3?.verification}.`);
  console.log(`Configured setup: ${configuration.project.setup?.steps.length} step; not executed.`);
  console.log(`Loaded instructions: ${plan.instructions.length}; content identity recorded.`);
  console.log(`\n--- Human-readable launch prompt ---\n${plan.prompt}`);
} finally {
  rmSync(cwd, { recursive: true, force: true });
  console.log("\nTemporary demo project and SQLite removed.");
}
