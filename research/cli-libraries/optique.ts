// Evaluation bridge only: the production CLI does not import this module.
import {
  argument,
  command,
  fail,
  map,
  message,
  object,
  option,
  optional,
  or,
  type Parser,
  seq,
  string,
} from "@optique/core";
import type { ActionTree, ActionView } from "../../src/actions/definition.ts";

export type Invocation = () => Promise<unknown>;
type SyncParser<T> = Parser<"sync", T, unknown>;
export function optiqueTree(tree: ActionTree): SyncParser<Invocation> {
  const branches: SyncParser<Invocation>[] = [];
  for (const [name, node] of Object.entries(tree)) {
    if (node.kind !== "action") {
      branches.push(command(name, optiqueTree(node as ActionTree)));
      continue;
    }
    const action = node as ActionView;
    if (!action.availability.available) continue;
    const fields: Record<string, SyncParser<unknown>> = { json: option("--json") };
    for (const [key, field] of Object.entries(action.fields)) {
      const description = message`${field.description}`;
      let parser: SyncParser<unknown>;
      if (field.positional) parser = argument(string(), { description });
      else if (field.values.length === 0) parser = option(`--${key}`, { description });
      else if (field.values.length === 1) parser = option(`--${key}`, string(), { description });
      else if (field.values.length === 2)
        parser = seq(option(`--${key}`, string(), { description }), argument(string()));
      else throw new Error("Evaluation bridge covers only the current field arities");
      fields[key] = field.required ? parser : optional(parser);
    }
    branches.push(
      command(
        name,
        map(
          object(fields),
          ({ json: _json, ...input }) =>
            // Parsing/help/completion may evaluate mappings: return work, never execute it here.
            () =>
              action.invoke(input),
        ),
        { description: message`${action.description}` },
      ),
    );
  }
  return branches.reduce((left, right) => or(left, right), fail<Invocation>());
}
