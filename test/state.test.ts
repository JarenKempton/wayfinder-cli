import { expect, test } from "bun:test";
import { capabilities, type Run } from "../src/domain.ts";
import { StateStore } from "../src/state.ts";

test("SQLite store round-trips runs", () => {
  const directory = `${process.env.TMPDIR ?? "/tmp"}/nav-test-${crypto.randomUUID()}`;
  const store = new StateStore(`${directory}.db`);
  const now = new Date().toISOString();
  const run: Run = {
    ref: "nav-run:test",
    ticket: "jira:x:W:ticket:A" as Run["ticket"],
    harness: "codex" as Run["harness"],
    model: "gpt",
    workspace: { path: "/tmp/work", branch: "task/A" },
    capabilities: capabilities("process_launch"),
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
  try {
    store.saveRun(run);
    expect(store.run(run.ref)).toEqual(run);
  } finally {
    store.close();
  }
});
