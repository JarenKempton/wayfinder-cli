import { describe, expect, test } from "bun:test";
import { capabilities, UnsupportedCapabilityError } from "../src/domain.ts";
import {
  CONFIGURATION_LAYER_ORDER,
  resolveExecutionRoute,
  resolveExecutionSettings,
  validateExecutionRoute,
} from "../src/routing.ts";

describe("layered execution routing", () => {
  test("declares the deterministic least-to-most-specific order", () => {
    expect(CONFIGURATION_LAYER_ORDER).toEqual([
      "harness",
      "user",
      "repository",
      "workspace",
      "group",
      "map",
      "ticket",
      "cli",
    ]);
  });

  test("resolves scalars by specificity and records provenance", () => {
    expect(
      resolveExecutionRoute({
        cli: { effort: "high" },
        harness: { harness: "codex", model: "default", effort: "medium" },
        map: { model: "map-model" },
        ticket: { harness: "t3" },
      }),
    ).toEqual({
      harness: "t3",
      model: "map-model",
      effort: "high",
      sources: { harness: "ticket", model: "map", effort: "cli" },
    });
  });

  test("empty scalar values do not erase lower-precedence choices", () => {
    expect(
      resolveExecutionRoute({
        harness: { harness: "codex", model: "default" },
        cli: { model: "" },
      }).model,
    ).toBe("default");
  });

  test("required capabilities accumulate instead of being overridden", () => {
    expect(
      resolveExecutionRoute({
        harness: {
          harness: "codex",
          requiredCapabilities: capabilities("process_launch"),
        },
        map: { requiredCapabilities: capabilities("session_resume") },
        cli: { requiredCapabilities: capabilities("visible_multi_session") },
      }),
    ).toMatchObject({
      requiredCapabilities: capabilities(
        "process_launch",
        "session_resume",
        "visible_multi_session",
      ),
      sources: { requiredCapabilities: "cli" },
    });
  });

  test("requires a selected harness", () => {
    expect(() => resolveExecutionRoute({ user: { model: "gpt" } })).toThrow(
      "No harness is configured",
    );
  });

  test("validates inferred and explicit capabilities", () => {
    const route = {
      model: "gpt",
      effort: "high",
      context: "repo",
      requiredCapabilities: capabilities("session_resume"),
    };
    expect(() =>
      validateExecutionRoute(
        route,
        capabilities(
          "model_selection",
          "reasoning_selection",
          "context_selection",
          "session_resume",
        ),
      ),
    ).not.toThrow();
    expect(() => validateExecutionRoute(route, capabilities("model_selection"))).toThrow(
      UnsupportedCapabilityError,
    );
  });

  test("keeps the protocol-v1 anonymous low-to-high merge", () => {
    expect(
      resolveExecutionSettings(
        { harness: "codex", model: "default" },
        { model: "map" },
        { harness: "t3" },
      ),
    ).toEqual({ harness: "t3", model: "map" });
    expect(resolveExecutionSettings({ model: "model-only" })).toEqual({ model: "model-only" });
  });
});
