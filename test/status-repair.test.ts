import { describe, expect, test } from "bun:test";
import type { DependencyStatusTransition } from "../src/frontier.ts";
import {
  evaluateStatusRepairBatch,
  FakeStatusRepairService,
  opaqueVersionContract,
  type StatusRepairBatchResult,
} from "../src/status-repair.ts";

const transition = (id: string, version: string): DependencyStatusTransition => ({
  ticket: `jira:x:W:ticket:${id}` as DependencyStatusTransition["ticket"],
  from: "To Do",
  to: "Blocked",
  expectedVersion: version,
  unresolvedBlockers: ["jira:x:W:ticket:A" as DependencyStatusTransition["ticket"]],
});

describe("verified status repair conformance", () => {
  test("accepts complete conditional and read-after-write proof", async () => {
    const request = transition("B", "v1");
    const fake = new FakeStatusRepairService(
      new Map([[request.ticket, { status: "To Do", version: "v1" }]]),
    );
    expect(evaluateStatusRepairBatch([request], await fake.repair([request]))).toMatchObject({
      verified: true,
      outcomes: [{ outcome: "verified" }],
    });
  });

  test("rejects forged, empty, and unchanged-version proof", () => {
    const request = transition("B", "v1");
    const adapter = {
      adapter: "fake",
      instance: "test",
      capabilities: { conditional_update: true as const, workflow_transition: true as const },
      versionContract: opaqueVersionContract,
    };
    const base: StatusRepairBatchResult = {
      adapter,
      outcomes: [{ ticket: request.ticket, expectedVersion: "v1", outcome: "verified" }],
    };
    expect(evaluateStatusRepairBatch([request], base).verified).toBeFalse();
    const proof = {
      conditionalGuard: { expectedVersion: "v1", applied: true as const },
      mutation: { acknowledged: true as const, version: "v1" },
      observation: { readAfterWrite: true as const, version: "v1", status: "Blocked" },
      adapter: {
        adapter: "fake",
        instance: "test",
        capabilities: adapter.capabilities,
        versionContract: opaqueVersionContract.name,
      },
    };
    expect(
      evaluateStatusRepairBatch([request], {
        adapter,
        outcomes: [
          {
            ticket: request.ticket,
            expectedVersion: request.expectedVersion,
            outcome: "verified",
            proof,
          },
        ],
      }).verified,
    ).toBeFalse();
  });

  test.each(["collision", "mutation_failed", "unverifiable", "ambiguous"] as const)(
    "fails closed on %s",
    async (outcome) => {
      const request = transition("B", "v1");
      const fake = new FakeStatusRepairService(
        new Map([[request.ticket, { status: "To Do", version: "v1", outcome }]]),
      );
      expect(evaluateStatusRepairBatch([request], await fake.repair([request]))).toMatchObject({
        verified: false,
        outcomes: [{ outcome }],
      });
    },
  );

  test("retains first success and second collision, then verifies a reconciled retry", async () => {
    const first = transition("B", "v1");
    const second = transition("C", "stale");
    const records = new Map([
      [first.ticket, { status: "To Do", version: "v1" }],
      [second.ticket, { status: "To Do", version: "current" }],
    ]);
    const fake = new FakeStatusRepairService(records);
    const partial = evaluateStatusRepairBatch([first, second], await fake.repair([first, second]));
    expect(partial).toMatchObject({
      verified: false,
      outcomes: [{ outcome: "verified" }, { outcome: "collision" }],
    });
    const retry = transition("C", "current");
    expect(evaluateStatusRepairBatch([retry], await fake.repair([retry])).verified).toBeTrue();
  });
});
