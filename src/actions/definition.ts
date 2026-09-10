import { type Fields, type Input, parseInput } from "./input.ts";
export interface Dependency<T> {
  readonly value: T | undefined;
  readonly description: string;
}
export function dependency<T>(value: T | undefined, description: string): Dependency<T> {
  return { value, description };
}
type Dependencies = Record<string, Dependency<unknown>>;
type Provided<D extends Dependencies> = { [K in keyof D]: Exclude<D[K]["value"], undefined> };
export type Availability = { available: true } | { available: false; reasons: string[] };
export interface ActionView {
  readonly kind: "action";
  readonly description: string;
  readonly aliases: readonly string[];
  readonly fields: Fields;
  readonly availability: Availability;
  invoke(input: unknown): Promise<unknown>;
  render(output: unknown, json: boolean): string[];
}
export type ActionTree = { readonly [command: string]: ActionView | ActionTree };

export function defineAction<S extends Fields, D extends Dependencies, O>(definition: {
  description: string;
  aliases?: readonly string[];
  input: S;
  dependencies: D;
  validate?(input: Input<S>): void;
  handler(dependencies: Provided<D>, input: Input<S>): O | Promise<O>;
  output?(value: unknown): O;
  render?(output: O, json: boolean): string[];
}) {
  const missing = Object.values(definition.dependencies)
    .filter((item) => item.value === undefined)
    .map((item) => `no ${item.description} is composed`);
  const availability: Availability = missing.length
    ? { available: false, reasons: missing }
    : { available: true };
  async function invoke(raw: unknown): Promise<O> {
    const input = parseInput(definition.input, raw);
    definition.validate?.(input);
    if (!availability.available)
      throw new Error(`Action is unavailable: ${availability.reasons.join("; ")}`);
    // The missing-dependency check above is the only place an unbound service becomes callable.
    const provided = Object.fromEntries(
      Object.entries(definition.dependencies).map(([key, item]) => [key, item.value]),
    ) as Provided<D>;
    const result = await definition.handler(provided, input);
    return definition.output ? definition.output(result) : result;
  }
  return {
    kind: "action" as const,
    description: definition.description,
    aliases: definition.aliases ?? [],
    fields: definition.input,
    availability,
    invoke,
    execute(input: Input<S>): Promise<O> {
      return invoke(input);
    },
    render(output: unknown, json: boolean): string[] {
      if (definition.render) return definition.render(output as O, json);
      return [typeof output === "string" && !json ? output : JSON.stringify(output, null, 2)];
    },
  };
}
