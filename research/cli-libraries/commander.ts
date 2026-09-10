// Evaluation bridge only. Variadic pair options deliberately expose a compatibility tradeoff.
import { Command, Option } from "commander";
import { availableActions } from "../../src/actions/catalog.ts";
import type { ActionTree } from "../../src/actions/definition.ts";

export function commanderTree(tree: ActionTree) {
  const root = new Command("wayfinder");
  let result: unknown;
  const configure = (command: Command) =>
    command.exitOverride().configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });
  configure(root);
  for (const entry of availableActions(tree)) {
    let command = root;
    for (const name of entry.command) {
      let child = command.commands.find((child) => child.name() === name);
      if (!child) {
        child = configure(new Command(name));
        command.addCommand(child);
      }
      command = child;
    }
    command.description(entry.action.description);
    const keys = new Map<string, string>();
    const positionalKeys: string[] = [];
    for (const [key, field] of Object.entries(entry.action.fields)) {
      if (field.positional) {
        command.argument(field.required ? `<${key}>` : `[${key}]`, field.description);
        positionalKeys.push(key);
      } else {
        const suffix =
          field.values.length === 0 ? "" : field.values.length === 1 ? " <VALUE>" : " <VALUES...>";
        const option = new Option(`--${key}${suffix}`, field.description);
        if (field.required) option.makeOptionMandatory();
        command.addOption(option);
        keys.set(option.attributeName(), key);
      }
    }
    command.option("--json");
    command.action(async (...args: unknown[]) => {
      const input = Object.fromEntries(
        Object.entries(command.opts())
          .filter(([key]) => keys.has(key))
          .map(([key, value]) => [keys.get(key), value]),
      );
      positionalKeys.forEach((key, index) => {
        input[key] = args[index];
      });
      result = await entry.action.invoke(input);
    });
  }
  return {
    root,
    async execute(args: string[]) {
      await root.parseAsync(args, { from: "user" });
      return result;
    },
  };
}
