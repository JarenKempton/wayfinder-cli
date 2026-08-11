import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { runAdapterConformance } from "../src/conformance.ts";
import type { AdapterDescription } from "../src/protocol.ts";

const fixture = join(import.meta.dir, "fixtures", "conformance-adapter.ts");
chmodSync(fixture, 0o755);

test("subprocess adapter protocol passes the safety conformance suite", async () => {
  const report = await runAdapterConformance(fixture, "0.1.0-test");

  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(9);
  expect(report.checks.every((check) => check.ok)).toBe(true);
});

test("adapter test remains a non-destructive initialization smoke test", async () => {
  const output: string[] = [];
  await run(["adapter", "test", fixture], (line) => output.push(line));

  const result = JSON.parse(output[0] ?? "") as { ok: boolean; adapter: AdapterDescription };
  expect(result).toEqual({
    ok: true,
    adapter: {
      name: "conformance-fixture",
      version: "0.1.0",
      protocol_versions: ["1.0"],
      capabilities: {},
    },
  });
});

test("adapter conformance is an explicit fixture-only command", async () => {
  const output: string[] = [];
  await run(["adapter", "conformance", fixture], (line) => output.push(line));

  const result = JSON.parse(output[0] ?? "") as { ok: boolean; checks: unknown[] };
  expect(result.ok).toBe(true);
  expect(result.checks).toHaveLength(9);
});
