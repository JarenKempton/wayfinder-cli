import { expect, test } from "bun:test";
import { resolveEnvironmentSettings, selectEnvironmentProfile } from "../src/environment.ts";

const profiles = [
  {
    name: "hybrid",
    services: [
      { service: "web", mode: "local" as const },
      { service: "database", mode: "hosted" as const, target: "staging" },
    ],
  },
];

test("environment settings apply repository, user, then invocation precedence", () => {
  expect(
    resolveEnvironmentSettings(
      { profile: "hybrid", services: { web: { service: "web", mode: "local" } } },
      { services: { web: { service: "web", mode: "disabled" } } },
      { services: { web: { service: "web", mode: "hosted", target: "preview" } } },
    ),
  ).toEqual({
    profile: "hybrid",
    services: { web: { service: "web", mode: "hosted", target: "preview" } },
  });
});

test("profiles compose local and hosted services deterministically", () => {
  expect(
    selectEnvironmentProfile(profiles, {
      profile: "hybrid",
      services: { web: { service: "web", mode: "hosted", target: "preview" } },
    }),
  ).toEqual({
    name: "hybrid",
    services: [
      { service: "web", mode: "hosted", target: "preview" },
      { service: "database", mode: "hosted", target: "staging" },
    ],
  });
});

test("profiles reject overrides for undeclared application services", () => {
  expect(() =>
    selectEnvironmentProfile(profiles, {
      profile: "hybrid",
      services: { payments: { service: "payments", mode: "local" } },
    }),
  ).toThrow("Unknown service override: payments");
});
