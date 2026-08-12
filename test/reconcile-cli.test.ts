import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import type { Ticket } from "../src/domain.ts";

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
  };
  const blocked: Ticket = {
    ...blocker,
    ref: "jira:x:W:ticket:B" as Ticket["ref"],
    order: 1,
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
        repairStatuses: async () => {
          calls += 1;
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
    const repaired: unknown[] = [];
    await run(
      ["reconcile", "statuses", scope, "--input", fixture(), "--repair", "--json"],
      () => undefined,
      { repairStatuses: async (transitions) => void repaired.push(...transitions) },
    );
    expect(repaired).toHaveLength(1);
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
