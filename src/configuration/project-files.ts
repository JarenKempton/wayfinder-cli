import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  EditConfigurationInput,
  InitConfigurationInput,
  ShowConfigurationInput,
} from "../actions/configuration.ts";
import { databasePath } from "../paths.ts";
import { StateStore } from "../state.ts";
import INITIAL_CONFIGURATION from "./default.toml" with { type: "text" };
import { configurationVersion, parseProjectToml, projectConfigPath } from "./files.ts";
import { readPersonalSettings } from "./local-settings.ts";
import {
  type ResolvedConfiguration,
  resolveProjectConfiguration,
  validateResolvedConfiguration,
} from "./schema.ts";

export { INITIAL_CONFIGURATION };
export interface ConfigurationOutput {
  version: 1;
  action: "initialized" | "configuration" | "edited";
  path: string;
  configuration: ResolvedConfiguration;
}
export function validateConfigurationOutput(output: unknown): ConfigurationOutput {
  if (
    !output ||
    typeof output !== "object" ||
    !("configuration" in output) ||
    !("version" in output) ||
    output.version !== 1 ||
    !("path" in output) ||
    typeof output.path !== "string" ||
    !("action" in output) ||
    !["initialized", "configuration", "edited"].includes(String(output.action))
  )
    throw new Error("Invalid configuration result");
  validateResolvedConfiguration(output.configuration);
  return output as ConfigurationOutput;
}
export interface ConfigurationPlatformOptions {
  cwd: string;
  statePath?: string;
  editor?: string;
  editFile?: (argv: string[]) => Promise<number>;
}
export function configurationOperations(options: ConfigurationPlatformOptions) {
  const pathFor = (input: { path?: string }) => projectConfigPath(options.cwd, input.path);
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
    async init(input: InitConfigurationInput) {
      const path = pathFor(input);
      const content = input.from
        ? readFileSync(resolve(options.cwd, input.from), "utf8")
        : INITIAL_CONFIGURATION;
      const configuration = resolved(path, content);
      // wx rejects existing files and symlinks, including dangling symlinks.
      writeFileSync(path, content, { flag: "wx", mode: 0o600 });
      return output("initialized", path, configuration);
    },
    async show(input: ShowConfigurationInput) {
      const path = pathFor(input);
      return output("configuration", path, resolved(path, readFileSync(path, "utf8")));
    },
    async edit(input: EditConfigurationInput) {
      const path = pathFor(input);
      const original = readFileSync(path, "utf8");
      if (input.set || input.follow) {
        // Only explicit choices are persisted; defaults are always read from the project.
        const candidate = readPersonalSettings(storePath(), path);
        if (input.set) candidate[input.set[0]] = input.set[1];
        if (input.follow) delete candidate[input.follow];
        resolved(path, original, candidate);
        mkdirSync(dirname(storePath()), { recursive: true });
        const store = new StateStore(storePath());
        try {
          const personal = store.updateConfigurationOverrides(path, (settings) => {
            if (input.set) settings[input.set[0]] = input.set[1];
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
