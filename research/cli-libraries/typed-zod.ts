import assert from "node:assert/strict";
import { Command } from "@commander-js/extra-typings";
import {
  argument,
  command,
  getDocPageSync,
  type InferValue,
  map,
  object,
  option,
  optional,
  or,
  parseSync,
  seq,
  suggestSync,
} from "@optique/core";
import { zod } from "@optique/zod";
import { z } from "zod";
import { personalSettingsSchema } from "../../src/configuration/schema.ts";

// Future definition style: shared Zod setting keys supply both validation and value completion.
// Keep the placeholder literal: a widened string here widens the inferred result too.
const setting = zod(personalSettingsSchema.keyof(), { placeholder: "model" as const });
const value = zod(z.string().min(1), { placeholder: "example" });
export const editParser = command(
  "edit",
  object({
    path: optional(option("--path", value)),
    operation: or(
      map(seq(option("--set", setting), argument(value)), (set) => ({ set })),
      map(option("--follow", setting), (follow) => ({ follow })),
      map(optional(option("--editor", value)), (editor) => ({ editor })),
    ),
  }),
);
type Edit = InferValue<typeof editParser>;

export function typedZodProbe() {
  const result = parseSync(editParser, ["edit", "--set", "model", "chosen"]);
  assert(result.success);
  assert.deepEqual(result.value.operation, { set: ["model", "chosen"] });
  assert(!parseSync(editParser, ["edit", "--set", "secret", "redacted"]).success);
  assert(!parseSync(editParser, ["edit", "--set", "model", "chosen", "--follow", "model"]).success);
  const suggestions = suggestSync(editParser, ["edit", "--follow", "mo"]);
  assert(suggestions.some((item) => item.kind === "literal" && item.text === "model"));
  assert(getDocPageSync(editParser));

  const typedCommand = new Command().option("--path <FILE>").option("--json");
  typedCommand.action((options) => {
    const path: string | undefined = options.path;
    void path;
    // @ts-expect-error inferred Commander handler rejects invented option names
    options.missing;
  });
  const typeExamples = () => {
    // @ts-expect-error inferred Optique input rejects unknown setting names
    const bad: Edit = { path: undefined, operation: { set: ["secret", "value"] } };
    void bad;
    // @ts-expect-error shared Zod schema keys remain a literal union
    const key: z.infer<ReturnType<typeof personalSettingsSchema.keyof>> = "secret";
    void key;
  };
  void typeExamples;
  // No handler should ever execute while displaying help or obtaining suggestions.
  let executions = 0;
  const deferred = map(option("--inspect"), () => () => {
    executions++;
  });
  getDocPageSync(deferred);
  suggestSync(deferred, [""]);
  assert.equal(executions, 0);
  console.log(
    "PASS typed definitions: inferred handler inputs, shared Zod choices, exclusive operations, value completion, deferred execution",
  );
}
