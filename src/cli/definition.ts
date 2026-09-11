import type { z } from "zod";
import { type InputParser, inputParser } from "./parser.ts";
import { type Input, parseInput, type RawInput } from "./schema.ts";

export function dependency<T>(value: T | undefined, description: string) {
  return {
    availability:
      value === undefined
        ? { available: false as const, reasons: [`no ${description} is composed`] }
        : { available: true as const },
    get(): T {
      if (value === undefined)
        throw new Error(`Action is unavailable: no ${description} is composed`);
      return value;
    },
  };
}
export type Availability = { available: true } | { available: false; reasons: string[] };
export interface ActionView {
  readonly kind: "action";
  readonly description: string;
  readonly aliases: readonly string[];
  readonly fields: z.ZodRawShape;
  readonly parser: InputParser;
  readonly availability: Availability;
  invoke(input: unknown): Promise<unknown>;
  call(input: unknown, json: boolean): Promise<string[]>;
}
export type ActionTree = { readonly [command: string]: ActionView | ActionTree };
export function isAction(entry: ActionView | ActionTree): entry is ActionView {
  return entry.kind === "action" && typeof entry.invoke === "function";
}
export function defineAction<S extends z.ZodRawShape, O>(definition: {
  description: string;
  aliases?: readonly string[];
  input: S;
  dependencies?: readonly { availability: Availability; get(): unknown }[];
  validate?(input: Input<S>): void;
  handler(input: Input<S>): O | Promise<O>;
  output?(value: unknown): O;
  render?(output: O, json: boolean): string[];
}) {
  const dependencies = definition.dependencies ?? [];
  const reasons = dependencies.flatMap(({ availability }) =>
    availability.available ? [] : availability.reasons,
  );
  const availability: Availability = reasons.length
    ? { available: false, reasons }
    : { available: true };
  async function invoke(raw: unknown): Promise<O> {
    for (const binding of dependencies) binding.get();
    const input = parseInput(definition.input, raw);
    definition.validate?.(input);
    const result = await definition.handler(input);
    return definition.output ? definition.output(result) : result;
  }
  return {
    kind: "action" as const,
    description: definition.description,
    aliases: definition.aliases ?? [],
    fields: definition.input,
    parser: inputParser(definition.input),
    availability,
    invoke,
    execute(input: RawInput<S>): Promise<O> {
      return invoke(input);
    },
    async call(input: unknown, json: boolean): Promise<string[]> {
      const output = await invoke(input);
      return definition.render
        ? definition.render(output, json)
        : [typeof output === "string" && !json ? output : JSON.stringify(output, null, 2)];
    },
  };
}
