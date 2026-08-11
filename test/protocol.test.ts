import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { runAdapterConformance } from "../src/conformance.ts";

const fixture = join(import.meta.dir, "fixtures", "conformance-adapter.ts");
chmodSync(fixture, 0o755);

test("subprocess adapter protocol passes the safety conformance suite", async () => {
  const report = await runAdapterConformance(fixture);

  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(9);
  expect(report.checks.every((check) => check.ok)).toBe(true);
});
