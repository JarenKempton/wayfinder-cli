import type { ActionTree, ActionView } from "./definition.ts";
export interface RegisteredAction {
  command: string[];
  action: ActionView;
}
export function registeredActions(tree: ActionTree, prefix: string[] = []): RegisteredAction[] {
  return Object.entries(tree).flatMap(([name, entry]) => {
    const command = [...prefix, name];
    return entry.kind === "action"
      ? [{ command, action: entry as ActionView }]
      : registeredActions(entry as ActionTree, command);
  });
}
export function availableActions(tree: ActionTree): RegisteredAction[] {
  return registeredActions(tree).filter((entry) => entry.action.availability.available);
}
export function actionUsage({ command, action }: RegisteredAction): string {
  return [
    ...command,
    ...Object.entries(action.fields).map(([key, field]) => {
      const value = field.positional
        ? field.values.join(" ")
        : [`--${key}`, ...field.values].join(" ");
      return field.required ? value : `[${value}]`;
    }),
    "[--json]",
  ].join(" ");
}
export function describeAction(entry: RegisteredAction) {
  return {
    command: entry.command,
    description: entry.action.description,
    usage: actionUsage(entry),
    availability: entry.action.availability,
    input: Object.fromEntries(
      Object.entries(entry.action.fields).map(([key, { parse: _parse, ...field }]) => [key, field]),
    ),
  };
}

type Intersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;
type Unique<
  Groups extends readonly ActionTree[],
  Seen extends PropertyKey = never,
> = Groups extends readonly [
  infer Head extends ActionTree,
  ...infer Tail extends readonly ActionTree[],
]
  ? Extract<keyof Head, Seen> extends never
    ? Unique<Tail, Seen | keyof Head>
    : never
  : unknown;

export function composeActions<const Groups extends readonly ActionTree[]>(
  ...groups: Groups & Unique<Groups>
): Intersection<Groups[number]> {
  const entries = groups.flatMap((group) => Object.entries(group));
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    throw new Error("Duplicate action registration");
  return Object.fromEntries(entries) as Intersection<Groups[number]>;
}
