import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Ticket } from "../src/domain.ts";
import { FakeStatusRepairService } from "../src/status-repair.ts";

const map = "jira:x:W:map:M" as Ticket["map"];
const scope = String(map);

function fixture(): string {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-reconcile-"));
  const blocker: Ticket = {
    ref: "jira:x:W:ticket:A" as Ticket["ref"],
    map,
    kind: "task",
    state: "open",
    status: "To Do",
    order: 0,
    metadata: { version: "v-A" },
  };
  const blocked: Ticket = {
    ...blocker,
    ref: "jira:x:W:ticket:B" as Ticket["ref"],
    order: 1,
    metadata: { version: "v-B" },
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: "jira:x:W:ticket:B" as Ticket["ref"],
        kind: "blocks",
      },
    ],
  };
  const active: Ticket = {
    ...blocked,
    ref: "jira:x:W:ticket:C" as Ticket["ref"],
    status: "In Review",
    order: 2,
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: "jira:x:W:ticket:C" as Ticket["ref"],
        kind: "blocks",
      },
    ],
  };
  const unmanaged: Ticket = {
    ...blocked,
    ref: "jira:x:W:ticket:D" as Ticket["ref"],
    status: "Backlog",
    assignee: "human" as NonNullable<Ticket["assignee"]>,
    order: 3,
    dependencies: [
      {
        blocking: blocker.ref,
        blocked: "jira:x:W:ticket:D" as Ticket["ref"],
        kind: "blocks",
      },
    ],
  };
  const path = join(directory, "tickets.json");
  writeFileSync(path, JSON.stringify([blocker, blocked, active, unmanaged]));
  return path;
}

function partialFixture(): string {
  const path = fixture();
  const tickets = JSON.parse(readFileSync(path, "utf8")) as Ticket[];
  const blocker = tickets[0] as Ticket;
  const template = tickets[1] as Ticket;
  tickets.push({
    ...template,
    ref: "jira:x:W:ticket:E" as Ticket["ref"],
    order: 4,
    metadata: { version: "v-E" },
    dependencies: [
      { blocking: blocker.ref, blocked: "jira:x:W:ticket:E" as Ticket["ref"], kind: "blocks" },
    ],
  });
  writeFileSync(path, JSON.stringify(tickets));
  return path;
}

describe("reconcile statuses CLI", () => {
  test("audits transitions and protected-state drift as a structured receipt", async () => {
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--json"],
      output.push.bind(output),
    );
    const receipt = JSON.parse(output[0] ?? "null");
    expect(receipt.action).toBe("statuses_audited");
    expect(receipt.transitions).toHaveLength(1);
    expect(receipt.drift).toHaveLength(1);
    expect(JSON.stringify(receipt)).not.toContain("jira:x:W:ticket:D");
  });

  test("dry-run plans repair without mutation and live repair requires a verifier", async () => {
    const output: string[] = [];
    let calls = 0;
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--dry-run", "--json"],
      output.push.bind(output),
      {
        statusRepair: {
          repair: async () => {
            calls += 1;
            return new FakeStatusRepairService(new Map()).repair([]);
          },
        },
      },
    );
    expect(calls).toBe(0);
    expect(JSON.parse(output[0] ?? "null").action).toBe("status_repair_planned");
    await expect(
      run(["reconcile", "statuses", scope, "--input", fixture(), "--repair"], () => undefined),
    ).rejects.toThrow("conditional status mutation and verification service");
  });

  test("repair delegates the exact conditional transition plan", async () => {
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
      output.push.bind(output),
      {
        statusRepair: new FakeStatusRepairService(
          new Map([["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }]]),
        ),
      },
    );
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "statuses_repaired",
      repairOutcomes: [{ outcome: "verified" }],
    });
  });

  test("does not report repaired when an outcome is ambiguous", async () => {
    const output: string[] = [];
    await expect(
      run(
        ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
        output.push.bind(output),
        {
          statusRepair: new FakeStatusRepairService(
            new Map([
              ["jira:x:W:ticket:B", { status: "To Do", version: "v-B", outcome: "ambiguous" }],
            ]),
          ),
          statusRepairReceipts: { persist: () => undefined },
        },
      ),
    ).resolves.toBeUndefined();
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "status_repair_recovery_required",
      outcomes: [{ outcome: "ambiguous" }],
    });
  });

  test("fails closed when recovery receipt persistence fails", async () => {
    await expect(
      run(
        ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
        () => undefined,
        {
          statusRepair: new FakeStatusRepairService(
            new Map([
              ["jira:x:W:ticket:B", { status: "To Do", version: "v-B", outcome: "collision" }],
            ]),
          ),
          statusRepairReceipts: {
            persist: () => {
              throw new Error("receipt disk unavailable");
            },
          },
        },
      ),
    ).rejects.toThrow("receipt disk unavailable");
  });

  test("persists complete partial-success recovery and exact retry command", async () => {
    const persisted: unknown[] = [];
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      output.push.bind(output),
      {
        statusRepair: new FakeStatusRepairService(
          new Map([
            ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
            ["jira:x:W:ticket:E", { status: "To Do", version: "changed" }],
          ]),
        ),
        statusRepairReceipts: { persist: (receipt) => void persisted.push(receipt) },
      },
    );
    const receipt = JSON.parse(output[0] ?? "null");
    expect(receipt).toMatchObject({
      action: "status_repair_recovery_required",
      requested: [{ ticket: "jira:x:W:ticket:B" }, { ticket: "jira:x:W:ticket:E" }],
      outcomes: [{ outcome: "verified" }, { outcome: "collision" }],
      recoveryCommand: `wayfinder reconcile statuses ${scope} --repair --json`,
    });
    expect(persisted).toHaveLength(1);
  });

  test("requires and validates the positional qualified scope", async () => {
    await expect(
      run(["reconcile", "statuses", "--input", fixture()], () => undefined),
    ).rejects.toThrow("qualified <scope>");
    await expect(
      run(["reconcile", "statuses", "wayfinder-run:123", "--input", fixture()], () => undefined),
    ).rejects.toThrow("not a frontier scope");
    await expect(
      run(["reconcile", "statuses", "not-a-reference", "--input", fixture()], () => undefined),
    ).rejects.toThrow();
  });

  test("rejects dry-run without repair", async () => {
    await expect(
      run(["reconcile", "statuses", scope, "--input", fixture(), "--dry-run"], () => undefined),
    ).rejects.toThrow("--dry-run requires --repair");
  });
});
