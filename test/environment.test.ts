import { expect, test } from "bun:test";
import type {
  AdapterRef,
  EnvironmentProfileRef,
  EnvironmentStartAuthorization,
} from "../src/domain.ts";
import {
  requireEnvironmentSettings,
  requireEnvironmentStartAuthorization,
  resolveEnvironmentSettings,
} from "../src/environment.ts";

const adapter = (value: string) => value as AdapterRef;
const profile = (value: string) => value as EnvironmentProfileRef;

test("workspace environment defaults are retained without higher layers", () => {
  expect(
    resolveEnvironmentSettings({
      adapter: adapter("environment:example"),
      profile: profile("base"),
    }),
  ).toEqual({ adapter: adapter("environment:example"), profile: profile("base") });
});

test("environment selection applies workspace, local, ticket, then invocation precedence", () => {
  expect(
    resolveEnvironmentSettings(
      { adapter: adapter("environment:workspace"), profile: profile("workspace") },
      { profile: profile("local") },
      { adapter: adapter("environment:ticket"), profile: profile("ticket") },
      { profile: profile("invocation") },
    ),
  ).toEqual({ adapter: adapter("environment:ticket"), profile: profile("invocation") });
});

test("adapter and profile resolve independently by field", () => {
  expect(
    resolveEnvironmentSettings(
      { adapter: adapter("environment:workspace"), profile: profile("workspace") },
      { adapter: adapter("environment:explicit") },
    ),
  ).toEqual({ adapter: adapter("environment:explicit"), profile: profile("workspace") });
});

test("environment selection is complete before an adapter call", () => {
  expect(() => requireEnvironmentSettings({ profile: profile("hybrid") })).toThrow(
    "An environment adapter is required",
  );
  expect(() => requireEnvironmentSettings({ adapter: adapter("environment:example") })).toThrow(
    "An environment profile is required",
  );
});

test("human confirmation authorizes environment start", () => {
  const authorization: EnvironmentStartAuthorization = { kind: "human" };
  expect(requireEnvironmentStartAuthorization(authorization)).toEqual(authorization);
});

test("a named automation policy authorizes environment start", () => {
  const authorization: EnvironmentStartAuthorization = { kind: "policy", policy: "trusted-ci" };
  expect(requireEnvironmentStartAuthorization(authorization)).toEqual(authorization);
});

test("environment start rejects missing or unnamed authority", () => {
  expect(() => requireEnvironmentStartAuthorization()).toThrow(
    "Environment start authorization is required",
  );
  expect(() => requireEnvironmentStartAuthorization({ kind: "policy" })).toThrow(
    "Environment automation policy must be named",
  );
  expect(() => requireEnvironmentStartAuthorization({ kind: "policy", policy: "  " })).toThrow(
    "Environment automation policy must be named",
  );
});
