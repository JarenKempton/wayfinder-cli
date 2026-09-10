import {
  type ConfigurationPlatformOptions,
  configurationOperations,
  validateConfigurationOutput,
} from "../configuration/project-files.ts";
import { SETTING_KEYS } from "../configuration/schema.ts";
import { defineAction, dependency } from "./definition.ts";
import { choice, type Input, optional, pair, text } from "./input.ts";

const path = optional(
  text("Project configuration file (default: wayfinder.toml in the current directory).", "FILE"),
);
const setting = choice("Personal setting", SETTING_KEYS);
export const initInput = {
  path,
  from: optional(text("Copy an explicitly selected, validated project file.", "FILE")),
};
export const showInput = { path };
export const editInput = {
  path,
  editor: optional(
    text("Executable used to edit a staged copy; defaults to VISUAL or EDITOR.", "EXECUTABLE"),
  ),
  set: optional(
    pair(
      setting,
      text("Explicit personal value; never supply secrets."),
      "Persist one explicit personal choice in local SQLite.",
    ),
  ),
  follow: optional(setting),
};
export type InitConfigurationInput = Input<typeof initInput>;
export type ShowConfigurationInput = Input<typeof showInput>;
export type EditConfigurationInput = Input<typeof editInput>;

export function configurationActions(platform: ConfigurationPlatformOptions) {
  const operations = configurationOperations(platform);
  return {
    init: defineAction({
      description:
        "Create project configuration without overwriting a file; show resolved defaults and requirements.",
      input: initInput,
      dependencies: { initialize: dependency(operations.init, "project configuration writer") },
      handler: ({ initialize }, input) => initialize(input),
      output: validateConfigurationOutput,
    }),
    config: {
      show: defineAction({
        description:
          "Read project configuration and explicit personal choices without changing durable state.",
        input: showInput,
        dependencies: { read: dependency(operations.show, "project configuration reader") },
        handler: ({ read }, input) => read(input),
        output: validateConfigurationOutput,
      }),
      edit: defineAction({
        description:
          "Edit a staged project file, set a personal choice, or follow the current project default.",
        input: editInput,
        dependencies: { edit: dependency(operations.edit, "project configuration editor") },
        validate(input) {
          if (
            [input.editor, input.set, input.follow].filter((value) => value !== undefined).length >
            1
          )
            throw new Error("Choose one of --editor, --set, or --follow");
        },
        handler: ({ edit }, input) => edit(input),
        output: validateConfigurationOutput,
      }),
    },
  };
}
