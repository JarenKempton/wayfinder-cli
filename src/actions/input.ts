export interface Field<T> {
  readonly description: string;
  readonly values: readonly string[];
  readonly required: boolean;
  readonly positional: boolean;
  parse(value: unknown): T;
}
export type Fields = Record<string, Field<unknown>>;
type Value<F> = F extends Field<infer T> ? T : never;
export type Input<S extends Fields> = {
  [K in keyof S as undefined extends Value<S[K]> ? never : K]: Value<S[K]>;
} & {
  [K in keyof S as undefined extends Value<S[K]> ? K : never]?: Exclude<Value<S[K]>, undefined>;
};

export function text(description: string, label = "VALUE"): Field<string> {
  return {
    description,
    values: [label],
    required: true,
    positional: false,
    parse(value) {
      if (
        typeof value !== "string" ||
        !value.trim() ||
        [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        throw new Error(`Expected ${label}`);
      return value;
    },
  };
}
export function optional<T>(field: Field<T>): Field<T | undefined> {
  return {
    ...field,
    required: false,
    parse: (value) => (value === undefined ? undefined : field.parse(value)),
  };
}
export function positional<T>(field: Field<T>): Field<T> {
  return { ...field, positional: true };
}
export function flag(description: string): Field<boolean | undefined> {
  return {
    description,
    values: [],
    required: false,
    positional: false,
    parse(value) {
      if (value === undefined) return false;
      if (typeof value !== "boolean") throw new Error("Expected a flag");
      return value;
    },
  };
}
export function choice<const T extends readonly string[]>(
  description: string,
  choices: T,
): Field<T[number]> {
  return {
    ...text(`${description} (${choices.join(", ")})`, choices.join("|")),
    parse(value) {
      if (typeof value !== "string" || !choices.includes(value))
        throw new Error(`Expected one of: ${choices.join(", ")}`);
      return value;
    },
  };
}
export function pair<A, B>(first: Field<A>, second: Field<B>, description: string): Field<[A, B]> {
  return {
    description,
    values: [...first.values, ...second.values],
    required: true,
    positional: false,
    parse(value) {
      if (!Array.isArray(value) || value.length !== 2) throw new Error("Expected two values");
      return [first.parse(value[0]), second.parse(value[1])];
    },
  };
}
export function parseInput<S extends Fields>(fields: S, raw: unknown): Input<S> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Expected action input object");
  const object = raw as Record<string, unknown>;
  if (Object.keys(object).some((key) => !Object.hasOwn(fields, key)))
    throw new Error("Unknown action input field");
  return Object.fromEntries(
    Object.entries(fields).flatMap(([key, field]) => {
      let value: unknown;
      try {
        value = field.parse(object[key]);
      } catch (cause) {
        throw new Error(
          `Invalid ${field.positional ? key : `--${key}`}: ${cause instanceof Error ? cause.message : "invalid value"}`,
        );
      }
      return value === undefined ? [] : [[key, value]];
    }),
  ) as Input<S>;
}
