import {
  actionUsage,
  availableActions,
  describeAction,
  type RegisteredAction,
  registeredActions,
} from "./catalog.ts";
import type { ActionTree, ActionView } from "./definition.ts";

export function actionHelp(tree: ActionTree, prefix: string[] = [], json = false): string {
  const entries = availableActions(tree).filter((entry) =>
    prefix.every((part, i) => entry.command[i] === part),
  );
  if (json) return JSON.stringify({ actions: entries.map(describeAction) }, null, 2);
  return `Wayfinder CLI — portable work orchestration for agents\n\n${entries.map((entry) => `wayfinder ${actionUsage(entry)}\n  ${entry.action.description}`).join("\n")}\n`;
}
export function parseArguments(entry: RegisteredAction, args: string[]) {
  const input: Record<string, unknown> = {};
  const positionals = Object.entries(entry.action.fields).filter(([, field]) => field.positional);
  let position = 0;
  let json = false;
  let help = false;
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] as string;
    if (!arg.startsWith("--")) {
      const next = positionals[position++];
      if (!next) throw new Error("Unexpected positional argument");
      input[next[0]] = arg;
      continue;
    }
    const name = arg.slice(2);
    if (seen.has(name)) throw new Error("Duplicate option");
    seen.add(name);
    if (name === "json") {
      json = true;
      continue;
    }
    if (name === "help") {
      help = true;
      continue;
    }
    const field = entry.action.fields[name];
    if (!Object.hasOwn(entry.action.fields, name) || !field || field.positional)
      throw new Error("Unknown option; use --help");
    const values = args.slice(index + 1, index + 1 + field.values.length);
    if (values.length !== field.values.length || values.some((value) => value.startsWith("--")))
      throw new Error(`--${name} requires ${field.values.map((value) => `<${value}>`).join(" ")}`);
    input[name] = values.length === 0 ? true : values.length === 1 ? values[0] : values;
    index += values.length;
  }
  return { input, json, help };
}
export async function dispatch(
  tree: ActionTree,
  args: string[],
  write: (text: string) => void,
): Promise<void> {
  if (args[0] === "help") args = [...args.slice(1), "--help"];
  if (args[0] === "-h") args = ["--help", ...args.slice(1)];
  const aliases = new Map(
    registeredActions(tree).flatMap((entry) =>
      entry.action.aliases.map((alias) => [alias, entry] as const),
    ),
  );
  const alias = aliases.get(args[0] ?? "");
  if (alias) args = [...alias.command, ...args.slice(1)];
  let node: ActionTree | ActionView = tree;
  const command: string[] = [];
  let offset = 0;
  while (node.kind !== "action" && args[offset] && !args[offset]?.startsWith("--")) {
    const part = args[offset] as string;
    if (!Object.hasOwn(node, part)) throw new Error("Unknown command");
    node = (node as ActionTree)[part] as ActionTree | ActionView;
    command.push(part);
    offset++;
  }
  if (node.kind !== "action") {
    const flags = args.slice(offset);
    if (
      flags.some((flag) => flag !== "--help" && flag !== "--json") ||
      new Set(flags).size !== flags.length
    )
      throw new Error("Group help accepts --help and --json");
    write(actionHelp(tree, command, flags.includes("--json")));
    return;
  }
  const entry = { command, action: node as ActionView };
  let parsed: ReturnType<typeof parseArguments>;
  try {
    parsed = parseArguments(entry, args.slice(entry.command.length));
  } catch (cause) {
    throw new Error(
      `${entry.action.description} ${cause instanceof Error ? cause.message : "Invalid arguments"}`,
    );
  }
  if (parsed.help) {
    if (!entry.action.availability.available)
      throw new Error(`Action is unavailable: ${entry.action.availability.reasons.join("; ")}`);
    write(
      parsed.json
        ? JSON.stringify(describeAction(entry), null, 2)
        : `${actionHelp(tree, entry.command)}${Object.entries(entry.action.fields)
            .map(([key, field]) => `  ${key}: ${field.description}`)
            .join("\n")}`,
    );
    return;
  }
  const output = await entry.action.invoke(parsed.input);
  for (const line of entry.action.render(output, parsed.json)) write(line);
}
