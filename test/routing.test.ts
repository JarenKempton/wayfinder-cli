import { expect, test } from "bun:test";
import { resolveExecutionSettings } from "../src/routing.ts";

test("routing applies low-to-high precedence", () => {
  expect(
    resolveExecutionSettings(
      { harness: "codex", model: "default" },
      { model: "map" },
      { harness: "t3" },
    ),
  ).toEqual({ harness: "t3", model: "map" });
});
