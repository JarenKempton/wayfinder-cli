import {
  hasControlCharacters,
  SETTING_KEYS,
  type SettingKey,
  validateResolvedConfiguration,
} from "./configuration.ts";

export interface ConfigurationInput {
  path?: string;
  json: boolean;
  help: boolean;
  editor?: string;
  set?: { key: SettingKey; value: string };
  follow?: SettingKey;
  from?: string;
}
export interface ConfigurationOutput {
  version: 1;
  action: "initialized" | "configuration" | "edited";
  path: string;
  configuration: import("./configuration.ts").ResolvedConfiguration;
}
export interface ConfigurationOperations {
  init(input: ConfigurationInput): Promise<ConfigurationOutput>;
  show(input: ConfigurationInput): Promise<ConfigurationOutput>;
  edit(input: ConfigurationInput): Promise<ConfigurationOutput>;
}
/** Deliberately limited to configuration actions; no global dispatch framework. */
export const configurationActions = [
  {
    name: "init",
    command: ["init"],
    description:
      "Create project configuration exclusively; preview resolved defaults and requirements.",
    options: ["path", "from", "json", "help"],
    usage: "init [--path FILE] [--from FILE] [--json]",
    handler: (ops: ConfigurationOperations, input: ConfigurationInput) => ops.init(input),
  },
  {
    name: "show",
    command: ["config", "show"],
    description: "Read project configuration and explicit personal choices without writing state.",
    options: ["path", "json", "help"],
    usage: "config show [--path FILE] [--json]",
    handler: (ops: ConfigurationOperations, input: ConfigurationInput) => ops.show(input),
  },
  {
    name: "edit",
    command: ["config", "edit"],
    description:
      "Edit a staged project copy, or set a personal choice in SQLite; follow removes that choice.",
    options: ["path", "editor", "set", "follow", "json", "help"],
    usage:
      "config edit [--path FILE] [--editor EXECUTABLE | --set KEY VALUE | --follow KEY] [--json]",
    handler: (ops: ConfigurationOperations, input: ConfigurationInput) => ops.edit(input),
  },
] as const;
export type ConfigurationAction = (typeof configurationActions)[number];
export function describeConfigurationAction(action: ConfigurationAction) {
  return {
    version: 1,
    command: action.command,
    description: action.description,
    usage: action.usage,
    options: action.options,
    settingKeys: SETTING_KEYS,
  };
}
export function configurationHelp(action?: ConfigurationAction): string {
  const definitions = action ? [action] : configurationActions;
  return (
    definitions.map((item) => `wayfinder ${item.usage}\n  ${item.description}`).join("\n") +
    `\nPersonal setting keys: ${SETTING_KEYS.join(", ")}\nDo not place secret values in configuration or arguments.`
  );
}
export function parseConfigurationInput(
  action: ConfigurationAction,
  args: readonly string[],
): ConfigurationInput {
  const result: ConfigurationInput = { json: false, help: false };
  const seen = new Set<string>();
  const take = (index: number): string => {
    const value = args[index];
    if (!value || value.startsWith("--") || hasControlCharacters(value))
      throw new Error("Configuration option requires a value");
    return value;
  };
  const key = (value: string): SettingKey => {
    if (!(SETTING_KEYS as readonly string[]).includes(value))
      throw new Error(`Setting must be one of: ${SETTING_KEYS.join(", ")}`);
    return value as SettingKey;
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]?.replace(/^--/, "");
    if (
      !args[i]?.startsWith("--") ||
      !flag ||
      !(action.options as readonly string[]).includes(flag) ||
      seen.has(flag)
    )
      throw new Error(
        `Invalid configuration arguments; use wayfinder ${action.command.join(" ")} --help`,
      );
    seen.add(flag);
    switch (flag) {
      case "help":
        result.help = true;
        break;
      case "json":
        result.json = true;
        break;
      case "path":
        result.path = take(++i);
        break;
      case "from":
        result.from = take(++i);
        break;
      case "editor":
        result.editor = take(++i);
        break;
      case "set":
        result.set = { key: key(take(++i)), value: take(++i) };
        break;
      case "follow":
        result.follow = key(take(++i));
        break;
    }
  }
  if ([result.editor, result.set, result.follow].filter((value) => value !== undefined).length > 1)
    throw new Error("Choose one of --editor, --set, or --follow");
  return result;
}
export function validateConfigurationOutput(output: ConfigurationOutput): ConfigurationOutput {
  if (
    output.version !== 1 ||
    !["initialized", "configuration", "edited"].includes(output.action) ||
    !output.path ||
    output.configuration.version !== 1
  )
    throw new Error("Invalid configuration action result");
  validateResolvedConfiguration(output.configuration);
  return output;
}
