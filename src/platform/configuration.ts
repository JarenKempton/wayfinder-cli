import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type {
  ConfigurationInput,
  ConfigurationOperations,
  ConfigurationOutput,
} from "../config-actions.ts";
import {
  type PersonalSettings,
  type ProjectConfiguration,
  resolveProjectConfiguration,
  validatePersonalSettings,
  validateProjectConfiguration,
} from "../configuration.ts";
import { databasePath } from "../paths.ts";
import { StateStore } from "../state.ts";

export const INITIAL_CONFIGURATION = `# Project-owned defaults and requirements. No credentials belong here.
version = 1

[repositories]
# [repositories.example]
# github = "owner/repository"
# path = "."
# worktree_root = "../worktrees"
# base_branch = "main"

[maps]
# [maps.EXAMPLE-1]
# repository = "example"
# claim_status = "In Progress"
# available_statuses = ["To Do"]

[tracker.jira]
site = "https://example.atlassian.net"
cli = "acli"

[t3]
provider = "codex"
runtime_mode = "approval-required"
interaction_mode = "default"
open = "none"

[defaults]
host = "t3"

[required]
# Required settings reject conflicting personal choices.
`;
export function configurationVersion(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}
export function projectConfigPath(cwd: string, path = "wayfinder.toml"): string {
  return resolve(cwd, path);
}
/** Resolve local config references only. Setup locations belong to the future environment runner. */
export function configurationReference(configPath: string, path: string): string {
  if (path.startsWith("~"))
    throw new Error("Use a project-relative or absolute path; shell expansion is not performed");
  return isAbsolute(path) ? path : resolve(dirname(configPath), path);
}
export function parseProjectToml(content: string): ProjectConfiguration {
  let value: unknown;
  try {
    value = Bun.TOML.parse(content);
  } catch {
    throw new Error("Malformed project TOML; values omitted from diagnostic");
  }
  return validateProjectConfiguration(value);
}
export function readPersonalSettings(statePath: string, projectPath: string): PersonalSettings {
  if (!existsSync(statePath)) return {};
  const database = new Database(statePath, { readonly: true, strict: true });
  try {
    if (
      !database
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='configuration_overrides'",
        )
        .get()
    )
      return {};
    const row = database
      .query("SELECT settings_json FROM configuration_overrides WHERE project_path=?")
      .get(projectPath) as { settings_json: string } | null;
    if (!row) return {};
    let settings: unknown;
    try {
      settings = JSON.parse(row.settings_json);
    } catch {
      throw new Error("Invalid local configuration record");
    }
    return validatePersonalSettings(settings);
  } finally {
    database.close();
  }
}
export interface ConfigurationPlatformOptions {
  cwd: string;
  statePath?: string;
  editor?: string;
  editFile?: (argv: string[]) => Promise<number>;
}
export function configurationOperations(
  options: ConfigurationPlatformOptions,
): ConfigurationOperations {
  const pathFor = (input: ConfigurationInput) => projectConfigPath(options.cwd, input.path);
  const storePath = () => options.statePath ?? databasePath();
  const resolved = (
    path: string,
    content: string,
    personal = readPersonalSettings(storePath(), path),
  ) =>
    resolveProjectConfiguration(parseProjectToml(content), personal, {
      path,
      version: configurationVersion(content),
    });
  const output = (
    action: ConfigurationOutput["action"],
    path: string,
    configuration: ConfigurationOutput["configuration"],
  ): ConfigurationOutput => ({ version: 1, action, path, configuration });
  return {
    async init(input) {
      const path = pathFor(input);
      const content = input.from
        ? readFileSync(resolve(options.cwd, input.from), "utf8")
        : INITIAL_CONFIGURATION;
      const configuration = resolved(path, content);
      // wx rejects existing files and symlinks, including dangling symlinks.
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return output("initialized", path, configuration);
    },
    async show(input) {
      const path = pathFor(input);
      return output("configuration", path, resolved(path, readFileSync(path, "utf8")));
    },
    async edit(input) {
      const path = pathFor(input);
      const original = readFileSync(path, "utf8");
      if (input.set || input.follow) {
        // Only explicit choices are persisted; defaults are always read from the project.
        const candidate = readPersonalSettings(storePath(), path);
        if (input.set) candidate[input.set.key] = input.set.value;
        if (input.follow) delete candidate[input.follow];
        resolved(path, original, candidate);
        mkdirSync(dirname(storePath()), { recursive: true });
        const store = new StateStore(storePath());
        try {
          const personal = store.updateConfigurationOverrides(path, (settings) => {
            if (input.set) settings[input.set.key] = input.set.value;
            if (input.follow) delete settings[input.follow];
            resolved(path, original, settings);
            return settings;
          });
          return output("edited", path, resolved(path, original, personal));
        } finally {
          store.close();
        }
      }
      const editor = input.editor ?? options.editor ?? process.env.VISUAL ?? process.env.EDITOR;
      if (!editor)
        throw new Error(
          "config edit requires --editor EXECUTABLE, --set KEY VALUE, or --follow KEY",
        );
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
        throw new Error("Project edit requires a regular file, not a symlink");
      const staging = mkdtempSync(join(dirname(path), ".wayfinder-edit-"));
      const stagedPath = join(staging, "wayfinder.toml");
      try {
        writeFileSync(stagedPath, original, { mode: 0o600 });
        const argv = [editor, stagedPath];
        const code = options.editFile
          ? await options.editFile(argv)
          : await Bun.spawn(argv, {
              cwd: options.cwd,
              stdin: "inherit",
              stdout: "inherit",
              stderr: "inherit",
            }).exited;
        if (code !== 0) throw new Error("Editor failed; project configuration was preserved");
        const content = readFileSync(stagedPath, "utf8");
        const configuration = resolved(path, content);
        if (readFileSync(path, "utf8") !== original || lstatSync(path).isSymbolicLink())
          throw new Error("Project configuration changed during editing; refusing overwrite");
        renameSync(stagedPath, path);
        return output("edited", path, configuration);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    },
  };
}

/** Read-only instruction loading. Content identities belong in the eventual execution receipt. */
export function loadConfigurationInstructions(
  configuration: import("../configuration.ts").ResolvedConfiguration,
  role: import("../domain.ts").TicketKind,
) {
  const references = configuration.project.instructions;
  const load = (path: string) => {
    const resolved = configurationReference(configuration.source.path, path);
    const content = readFileSync(resolved, "utf8");
    return { path, resolvedPath: resolved, version: configurationVersion(content), content };
  };
  return {
    ...(references?.runtime_contract ? { runtimeContract: load(references.runtime_contract) } : {}),
    ...(references?.role_templates?.[role]
      ? { roleTemplate: load(references.role_templates[role]) }
      : {}),
  };
}
