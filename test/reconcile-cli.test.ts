import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Ticket } from "../src/domain.ts";
import {
  FakeStatusRepairService,
  type StatusRepairReceiptStore,
  type StatusRepairRecoveryReceipt,
} from "../src/status-repair.ts";

const map = "jira:x:W:map:M" as Ticket["map"];
const scope = String(map);

class MemoryReceipts implements StatusRepairReceiptStore {
  records = new Map<string, StatusRepairRecoveryReceipt>();
  updates = 0;
  async create(receipt: Omit<StatusRepairRecoveryReceipt, "ref">): Promise<string> {
    const ref = "status-repair:test-receipt";
    this.records.set(ref, { ...receipt, ref });
    return ref;
  }
  async load(ref: string): Promise<StatusRepairRecoveryReceipt | undefined> {
    return structuredClone(this.records.get(ref));
  }
  async update(ref: string, receipt: StatusRepairRecoveryReceipt): Promise<void> {
    this.updates += 1;
    this.records.set(ref, structuredClone(receipt));
  }
}

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
          refresh: async () => new FakeStatusRepairService(new Map()).refresh([]),
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
    const receipts = new MemoryReceipts();
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
          statusRepairReceipts: receipts,
        },
      ),
    ).resolves.toBeUndefined();
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "status_repair_recovery_required",
      dispositions: [{ outcome: "ambiguous" }],
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
            create: () => {
              throw new Error("receipt disk unavailable");
            },
            load: async () => undefined,
            update: () => undefined,
          },
        },
      ),
    ).rejects.toThrow("receipt disk unavailable");
  });

  test("persists complete partial-success recovery and exact retry command", async () => {
    const receipts = new MemoryReceipts();
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
        statusRepairReceipts: receipts,
      },
    );
    const receipt = JSON.parse(output[0] ?? "null");
    expect(receipt).toMatchObject({
      action: "status_repair_recovery_required",
      requested: [{ ticket: "jira:x:W:ticket:B" }, { ticket: "jira:x:W:ticket:E" }],
      dispositions: [{ outcome: "verified" }, { outcome: "collision" }],
      recoveryArgv: [
        "reconcile",
        "statuses",
        scope,
        "--recover",
        "status-repair:test-receipt",
        "--json",
      ],
      refreshEvidence: [],
    });
    expect(receipts.records.size).toBe(1);
  });

  test("executes durable recovery, retries only unresolved work, and is idempotent", async () => {
    const receipts = new MemoryReceipts();
    const records = new Map([
      ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
      ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
    ]);
    const service = new FakeStatusRepairService(records);
    const initialOutput: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      initialOutput.push.bind(initialOutput),
      { statusRepair: service, statusRepairReceipts: receipts },
    );
    expect(service.repairCalls.map((call) => call.map(String))).toEqual([
      ["jira:x:W:ticket:B", "jira:x:W:ticket:E"],
    ]);
    const output: string[] = [];
    const recoveryArgv = JSON.parse(initialOutput[0] ?? "null").recoveryArgv as string[];
    await run(recoveryArgv, output.push.bind(output), {
      statusRepair: service,
      statusRepairReceipts: receipts,
    });
    expect(service.repairCalls[1]?.map(String)).toEqual(["jira:x:W:ticket:E"]);
    expect(service.refreshCalls[0]?.map(String)).toEqual([
      "jira:x:W:ticket:B",
      "jira:x:W:ticket:E",
    ]);
    const recoveredReceipt = JSON.parse(output[0] ?? "null");
    expect(recoveredReceipt).toMatchObject({
      action: "status_repair_recovered",
      dispositions: [
        { outcome: "verified", reconciled: true },
        { outcome: "verified", expectedVersion: "current" },
      ],
    });
    expect(recoveredReceipt.refreshEvidence[0].observations).toHaveLength(2);
    await run(
      ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
      () => undefined,
      { statusRepair: service, statusRepairReceipts: receipts },
    );
    expect(service.repairCalls).toHaveLength(2);
  });

  test("fails closed for missing receipt and persists ambiguous refresh attention", async () => {
    const receipts = new MemoryReceipts();
    const service = new FakeStatusRepairService(new Map());
    await expect(
      run(["reconcile", "statuses", scope, "--recover", "missing", "--json"], () => undefined, {
        statusRepair: service,
        statusRepairReceipts: receipts,
      }),
    ).rejects.toThrow("not found");

    const records = new Map<string, { status: string; version: string; outcome?: "ambiguous" }>([
      ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
      ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
    ]);
    const partial = new FakeStatusRepairService(records);
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      () => undefined,
      { statusRepair: partial, statusRepairReceipts: receipts },
    );
    const unresolved = records.get("jira:x:W:ticket:E");
    if (!unresolved) throw new Error("missing fake record");
    unresolved.outcome = "ambiguous";
    const output: string[] = [];
    await run(
      ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
      output.push.bind(output),
      { statusRepair: partial, statusRepairReceipts: receipts },
    );
    expect(JSON.parse(output[0] ?? "null")).toMatchObject({
      action: "attention_required",
      dispositions: [{ outcome: "verified", reconciled: true }, { outcome: "ambiguous" }],
    });
    expect(receipts.records.get("status-repair:test-receipt")?.action).toBe("attention_required");
  });

  test("fails closed when a recovered receipt cannot be persisted", async () => {
    const receipts = new MemoryReceipts();
    const service = new FakeStatusRepairService(
      new Map([
        ["jira:x:W:ticket:B", { status: "To Do", version: "v-B" }],
        ["jira:x:W:ticket:E", { status: "To Do", version: "current" }],
      ]),
    );
    await run(
      ["reconcile", "statuses", scope, "--input", partialFixture(), "--repair", "--json"],
      () => undefined,
      { statusRepair: service, statusRepairReceipts: receipts },
    );
    const failingStore: StatusRepairReceiptStore = {
      create: receipts.create.bind(receipts),
      load: receipts.load.bind(receipts),
      update: () => {
        throw new Error("recovery receipt unavailable");
      },
    };
    const output: string[] = [];
    await expect(
      run(
        ["reconcile", "statuses", scope, "--recover", "status-repair:test-receipt", "--json"],
        output.push.bind(output),
        { statusRepair: service, statusRepairReceipts: failingStore },
      ),
    ).rejects.toThrow("recovery receipt unavailable");
    expect(output).toEqual([]);
  });

  test("requires a recovery receipt reference", async () => {
    await expect(
      run(["reconcile", "statuses", scope, "--recover"], () => undefined),
    ).rejects.toThrow("--recover requires <receipt-ref>");
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
