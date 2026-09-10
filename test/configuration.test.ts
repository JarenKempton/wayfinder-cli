import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeAction, registeredActions } from "../src/actions/catalog.ts";
import { configurationActions } from "../src/actions/configuration.ts";
import { run } from "../src/cli.ts";
import {
  configurationReference,
  configurationVersion,
  parseProjectToml,
} from "../src/configuration/files.ts";
import { readPersonalSettings } from "../src/configuration/local-settings.ts";
import {
  configurationOperations,
  INITIAL_CONFIGURATION,
} from "../src/configuration/project-files.ts";
import {
  requireAvailableSelections,
  resolveProjectConfiguration,
} from "../src/configuration/schema.ts";
import type { Run } from "../src/domain.ts";
import { StateStore } from "../src/state.ts";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});
function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "wf-config-"));
  directories.push(cwd);
  const path = join(cwd, "wayfinder.toml");
  const statePath = join(cwd, "local.db");
  const ops = configurationOperations({ cwd, statePath });
  return { cwd, path, statePath, ops };
}
const input = { json: true, help: false };
function resolve(content: string, personal = {}) {
  return resolveProjectConfiguration(parseProjectToml(content), personal, {
    path: "/project/wayfinder.toml",
    version: configurationVersion(content),
  });
}

test("new resolutions follow changed defaults; explicit choices persist; requirements reject conflict", () => {
  const first = INITIAL_CONFIGURATION.replace("[defaults]", '[defaults]\nmodel = "first"');
  const second = first.replace('model = "first"', 'model = "second"');
  const snapshot = resolve(first);
  expect(resolve(second).settings.model).toBe("second");
  expect(snapshot.settings.model).toBe("first");
  expect(resolve(second, { model: "personal" }).settings.model).toBe("personal");
  const required = second.replace("[required]", '[required]\nmodel = "required"');
  expect(resolve(required).sources.model).toBe("required");
  expect(resolve(required, { model: "required" }).settings.model).toBe("required");
  expect(() => resolve(required, { model: "personal" })).toThrow(
    "model conflicts with project requirement in /project/wayfinder.toml",
  );
  expect(resolve(first).source.version).not.toBe(resolve(second).source.version);
});

test("init creates a validated shape and never replaces a file or dangling symlink", async () => {
  const f = fixture();
  const result = await f.ops.init(input);
  expect(result.configuration.settings).toMatchObject({
    host: "t3",
    agent: "codex",
    runtime_mode: "approval-required",
  });
  expect(existsSync(f.statePath)).toBe(false);
  await expect(f.ops.init(input)).rejects.toThrow();
  expect(readFileSync(f.path, "utf8")).toBe(INITIAL_CONFIGURATION);
  if (process.platform === "win32") return; // Windows symlink creation requires a separate OS privilege.
  const link = join(f.cwd, "link.toml");
  symlinkSync(join(f.cwd, "absent"), link);
  await expect(f.ops.init({ ...input, path: link })).rejects.toThrow();
});

test("init imports project shape explicitly and refuses invalid input before creating files", async () => {
  const f = fixture();
  const source = join(f.cwd, "source.toml");
  writeFileSync(source, "malformed = [");
  await expect(f.ops.init({ ...input, from: source })).rejects.toThrow("Malformed project TOML");
  expect(existsSync(f.path)).toBe(false);
  writeFileSync(source, INITIAL_CONFIGURATION);
  expect((await f.ops.init({ ...input, from: source })).action).toBe("initialized");
});

test("show does not initialize a SQLite store; local choices survive reopen and follow removes them", async () => {
  const f = fixture();
  await f.ops.init(input);
  const before = readdirSync(f.cwd);
  await f.ops.show(input);
  expect(readdirSync(f.cwd)).toEqual(before);
  await f.ops.edit({ ...input, set: ["model", "chosen"] });
  expect(readPersonalSettings(f.statePath, f.path)).toEqual({ model: "chosen" });
  writeFileSync(
    f.path,
    INITIAL_CONFIGURATION.replace("[defaults]", '[defaults]\nmodel = "updated"'),
  );
  const reopened = configurationOperations({ cwd: f.cwd, statePath: f.statePath });
  expect((await reopened.show(input)).configuration.settings.model).toBe("chosen");
  expect((await reopened.edit({ ...input, follow: "model" })).configuration.settings.model).toBe(
    "updated",
  );
  expect(readPersonalSettings(f.statePath, f.path)).toEqual({});
});

test("required conflict rolls back local write and leaves earlier choice intact", async () => {
  const f = fixture();
  await f.ops.init(input);
  await f.ops.edit({ ...input, set: ["model", "allowed"] });
  writeFileSync(
    f.path,
    INITIAL_CONFIGURATION.replace("[required]", '[required]\nmodel = "allowed"'),
  );
  await expect(f.ops.edit({ ...input, set: ["model", "conflict"] })).rejects.toThrow("requirement");
  expect(readPersonalSettings(f.statePath, f.path)).toEqual({ model: "allowed" });
});

test("execution snapshots persist independently and cannot be silently replaced", () => {
  const f = fixture();
  let store = new StateStore(f.statePath);
  const run = {
    ref: "wayfinder-run:config",
    ticket: "jira:example:P:ticket:P-1" as Run["ticket"],
    harness: "codex" as Run["harness"],
    workspace: { path: "/workspace" },
    capabilities: {},
    status: "planning",
    createdAt: "now",
    updatedAt: "now",
  } as Run;
  store.saveRun(run);
  const original = resolve(INITIAL_CONFIGURATION, { model: "original" });
  store.saveExecutionConfiguration(run.ref, original);
  store.close();
  store = new StateStore(f.statePath);
  try {
    expect(store.getExecutionConfiguration(run.ref)).toEqual(original);
    expect(() =>
      store.saveExecutionConfiguration(run.ref, resolve(INITIAL_CONFIGURATION, { model: "new" })),
    ).toThrow();
    expect(store.getExecutionConfiguration(run.ref)).toEqual(original);
  } finally {
    store.close();
  }
});

test.each(["host", "agent"] as const)(
  "unavailable %s shows alternatives without substitution",
  (key) => {
    const configuration = resolve(INITIAL_CONFIGURATION, { [key]: "missing" });
    expect(() =>
      requireAvailableSelections(configuration, {
        hosts: key === "host" ? ["supported-host"] : ["t3"],
        agents: ["supported-agent"],
      }),
    ).toThrow("Available supported alternatives");
    expect(configuration.settings[key]).toBe("missing");
  },
);

test.each(["version = 2", 'token = "DO_NOT_ECHO"', 'version = "DO_NOT_ECHO"'])(
  "malformed project values are rejected without echoing them: %s",
  (prefix) => {
    const content = prefix.includes("version")
      ? INITIAL_CONFIGURATION.replace("version = 1", prefix)
      : `${prefix}\n${INITIAL_CONFIGURATION}`;
    try {
      parseProjectToml(content);
      throw new Error("accepted invalid input");
    } catch (error) {
      expect(String(error)).toContain("Invalid configuration");
      expect(String(error)).not.toContain("DO_NOT_ECHO");
    }
  },
);

test("rejects dangling map, credentials in tracker URL, invalid runtime, and shell-text setup", () => {
  expect(() =>
    parseProjectToml(
      INITIAL_CONFIGURATION.replace(
        "[maps]",
        '[maps.bad]\nrepository = "absent"\nclaim_status = "In Progress"\navailable_statuses = ["To Do"]',
      ),
    ),
  ).toThrow("map.repository");
  expect(() =>
    parseProjectToml(
      INITIAL_CONFIGURATION.replace(
        "https://example.atlassian.net",
        "https://user:secret@example.atlassian.net",
      ),
    ),
  ).toThrow("tracker.jira.site");
  expect(() =>
    parseProjectToml(
      INITIAL_CONFIGURATION.replace(
        'runtime_mode = "approval-required"',
        'runtime_mode = "unknown"',
      ),
    ),
  ).toThrow("settings.runtime_mode");
  expect(() =>
    parseProjectToml(
      `${INITIAL_CONFIGURATION}\n[setup]\nversion = "v1"\n[[setup.steps]]\nargv = "sh setup.sh"\nlocation = "workspace"\nscripts = []`,
    ),
  ).toThrow("setup.step.argv");
});

test("setup is ordered argv with explicit location and script version, and stays present across personal resolution", () => {
  const content = `${INITIAL_CONFIGURATION}\n[setup]\nversion = "recipe-v1"\n[[setup.steps]]\nargv = ["bun", "install", "--frozen-lockfile"]\nlocation = "workspace"\nscripts = []\n[[setup.steps]]\nargv = ["sh", "scripts/setup.sh"]\nlocation = "workspace"\nscripts = [{ path = "scripts/setup.sh", version = "sha256:script-v1" }]`;
  const configuration = resolve(content, { model: "personal" });
  expect(configuration.project.setup?.steps.map((step) => step.argv[0])).toEqual(["bun", "sh"]);
  expect(configuration.project.setup?.steps[1]?.scripts[0]?.version).toBe("sha256:script-v1");
  const f = fixture();
  expect(configurationReference(f.path, "docs/contract.md")).toBe(
    join(f.cwd, "docs", "contract.md"),
  );
  expect(() => configurationReference("/project/wayfinder.toml", "~/contract.md")).toThrow(
    "shell expansion",
  );
});

test.each(["failure", "malformed", "concurrent"])(
  "staged editor %s preserves the project file",
  async (scenario) => {
    const f = fixture();
    await f.ops.init(input);
    const operations = configurationOperations({
      cwd: f.cwd,
      statePath: f.statePath,
      editFile: async (argv) => {
        expect(argv[0]).toBe("editor with spaces");
        writeFileSync(
          argv[1] as string,
          scenario === "malformed" ? "broken = [" : `${INITIAL_CONFIGURATION}\n# edit`,
        );
        if (scenario === "concurrent")
          writeFileSync(f.path, `${INITIAL_CONFIGURATION}\n# external edit`);
        return scenario === "failure" ? 1 : 0;
      },
    });
    await expect(operations.edit({ ...input, editor: "editor with spaces" })).rejects.toThrow();
    expect(readFileSync(f.path, "utf8")).toBe(
      INITIAL_CONFIGURATION + (scenario === "concurrent" ? "\n# external edit" : ""),
    );
  },
);

test("successful editor commits validated staged content and reports its identity", async () => {
  const f = fixture();
  await f.ops.init(input);
  const content = `${INITIAL_CONFIGURATION}\n# intentional edit`;
  const ops = configurationOperations({
    cwd: f.cwd,
    statePath: f.statePath,
    editFile: async (argv) => {
      writeFileSync(argv[1] as string, content);
      return 0;
    },
  });
  const output = await ops.edit({ ...input, editor: "fake" });
  expect(readFileSync(f.path, "utf8")).toBe(content);
  expect(output.configuration.source.version).toBe(configurationVersion(content));
});

test("configuration catalog drives help, JSON help, registration and man page", async () => {
  const f = fixture();
  const services = { configuration: { cwd: f.cwd, statePath: f.statePath } };
  const actions = registeredActions(configurationActions(services.configuration));
  for (const entry of actions) {
    const action = describeAction(entry);
    const human: string[] = [];
    const json: string[] = [];
    await run([...action.command, "--help"], (text) => human.push(text), services);
    await run([...action.command, "--help", "--json"], (text) => json.push(text), services);
    expect(human.join("")).toContain(action.description);
    expect(JSON.parse(json[0] as string)).toMatchObject({
      description: action.description,
      input: action.input,
    });
  }
  const manual: string[] = [];
  await run(["man"], (text) => manual.push(text), services);
  expect(manual[0]).toContain(actions[1]?.action.description);
  const output: string[] = [];
  await run(["init", "--json"], (text) => output.push(text), services);
  expect(JSON.parse(output[0] as string).action).toBe("initialized");
  const show: string[] = [];
  await run(["config", "show", "--json"], (text) => show.push(text), services);
  expect(JSON.parse(show[0] as string).configuration).toEqual(
    JSON.parse(output[0] as string).configuration,
  );
});

test.each(
  (
    [
      ["init", "--path"],
      ["init", "--json", "--json"],
      ["config", "show", "--unknown"],
      ["config", "edit", "--set", "secret", "DO_NOT_ECHO"],
      ["config", "edit", "--set", "model"],
      ["config", "edit", "--follow", "model", "--editor", "vi"],
    ] as string[][]
  ).map((args) => ({ args })),
)("CLI rejects malformed configuration arguments without mutations: %j", async ({ args }) => {
  const f = fixture();
  await expect(
    run(args, () => {}, { configuration: { cwd: f.cwd, statePath: f.statePath } }),
  ).rejects.toThrow();
  expect(readdirSync(f.cwd)).toEqual([]);
});

test("show reads an existing local database without changing durable data", async () => {
  const f = fixture();
  await f.ops.init(input);
  await f.ops.edit({ ...input, set: ["model", "chosen"] });
  const before = readFileSync(f.statePath);
  await f.ops.show(input);
  expect(readFileSync(f.statePath).equals(before)).toBe(true);
  expect(readPersonalSettings(f.statePath, f.path)).toEqual({ model: "chosen" });
});

test("invalid personal setting fails before creating local state", async () => {
  const f = fixture();
  await f.ops.init(input);
  await expect(f.ops.edit({ ...input, set: ["runtime_mode", "invalid"] })).rejects.toThrow(
    "settings.runtime_mode",
  );
  expect(existsSync(f.statePath)).toBe(false);
});

test("config group JSON help lists the same registered action contracts", async () => {
  const output: string[] = [];
  await run(["config", "--help", "--json"], (text) => output.push(text));
  expect(
    JSON.parse(output[0] as string).actions.map((action: { command: string[] }) => action.command),
  ).toEqual(
    registeredActions(configurationActions({ cwd: "/unused" }))
      .filter((entry) => entry.command[0] === "config")
      .map((entry) => entry.command),
  );
  await expect(run(["config", "--help", "--unknown"], () => {})).rejects.toThrow("Group help");
});
