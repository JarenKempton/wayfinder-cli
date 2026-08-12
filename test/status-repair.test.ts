import { describe, expect, test } from "bun:test";
import type { DependencyStatusTransition } from "../src/frontier.ts";
import { FakeStatusRepairService, verifyStatusRepairOutcomes } from "../src/status-repair.ts";

const transition = (id: string, version: string): DependencyStatusTransition => ({
  ticket: `jira:x:W:ticket:${id}` as DependencyStatusTransition["ticket"],
  from: "To Do",
  to: "Blocked",
  expectedVersion: version,
  unresolvedBlockers: ["jira:x:W:ticket:A" as DependencyStatusTransition["ticket"]],
});

describe("verified status repair conformance", () => {
  test("accepts complete guarded mutation plus read-after-write evidence", async () => {
    const request = transition("B", "v1");
    const fake = new FakeStatusRepairService(
      new Map([[request.ticket, { status: "To Do", version: "v1" }]]),
    );
    expect(verifyStatusRepairOutcomes([request], await fake.repair([request]))[0]).toMatchObject({
      outcome: "verified",
      observedStatus: "Blocked",
      observedVersion: "v1:repaired",
    });
  });

  test("fails closed on a conditional collision", async () => {
    const request = transition("B", "stale");
    const fake = new FakeStatusRepairService(
      new Map([[request.ticket, { status: "To Do", version: "current" }]]),
    );
    const outcomes = await fake.repair([request]);
    expect(() => verifyStatusRepairOutcomes([request], outcomes)).toThrow("not verified");
  });

  test("fails closed after partial success", async () => {
    const first = transition("B", "v1");
    const second = transition("C", "stale");
    const fake = new FakeStatusRepairService(
      new Map([
        [first.ticket, { status: "To Do", version: "v1" }],
        [second.ticket, { status: "To Do", version: "current" }],
      ]),
    );
    const outcomes = await fake.repair([first, second]);
    expect(() => verifyStatusRepairOutcomes([first, second], outcomes)).toThrow("not verified");
  });

  test("fails closed when mutation cannot be read-after-write verified", async () => {
    const request = transition("B", "v1");
    const fake = new FakeStatusRepairService(
      new Map([[request.ticket, { status: "To Do", version: "v1", verifiable: false }]]),
    );
    const outcomes = await fake.repair([request]);
    expect(() => verifyStatusRepairOutcomes([request], outcomes)).toThrow("unverifiable");
  });

  test("rejects missing and ambiguous outcomes", () => {
    const request = transition("B", "v1");
    expect(() => verifyStatusRepairOutcomes([request], [])).toThrow("omitted");
    expect(() =>
      verifyStatusRepairOutcomes(
        [request],
        [{ ticket: request.ticket, expectedVersion: "v1", outcome: "ambiguous", evidence: {} }],
      ),
    ).toThrow("ambiguous");
  });
});
