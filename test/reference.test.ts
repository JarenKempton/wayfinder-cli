import { describe, expect, test } from "bun:test";
import { capabilities, missingCapabilities } from "../src/domain.ts";
import type { RefKind } from "../src/reference.ts";
import { parseRef } from "../src/reference.ts";

describe("parseRef", () => {
  test.each([
    ["jira:responsibid", "tracker"],
    ["jira:responsibid:JWB", "workspace"],
    ["jira:responsibid:JWB:group:JWB-150", "group"],
    ["jira:responsibid:JWB:map:JWB-239", "map"],
    ["jira:responsibid:JWB:ticket:JWB-245", "ticket"],
    ["wayfinder-run:018f", "run"],
    ["wayfinder-claim:018f", "claim"],
  ] as const)("parses %s", (raw, kind) => expect(parseRef(raw).kind).toBe(kind as RefKind));

  test.each([
    "JWB-245",
    "jira:",
    "jira:x:y:map",
    "jira:x:y:other:z",
    "wayfinder-run:",
    "nav-run:018f",
    "nav-claim:018f",
  ])("rejects %s", (raw) => expect(() => parseRef(raw)).toThrow());
});

test("reports missing capabilities", () => {
  expect(
    missingCapabilities(capabilities("native_maps"), capabilities("native_maps", "claim_comments")),
  ).toEqual(["claim_comments"]);
});
