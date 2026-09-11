import { expect, test } from "bun:test";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { runAdapterConformance } from "../src/adapters/conformance.ts";
import { AdapterClient } from "../src/adapters/protocol.ts";
import { run } from "../src/cli.ts";

const fixture = join(import.meta.dir, "fixtures", "conformance-adapter.ts");
chmodSync(fixture, 0o755);

test("subprocess adapter protocol passes the safety conformance suite", async () => {
  const report = await runAdapterConformance(fixture, "0.1.0-test");

  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(9);
  expect(report.checks.every((check) => check.ok)).toBe(true);
  expect(report.checks.find((check) => check.name === "deadline terminates subprocess")).toEqual({
    name: "deadline terminates subprocess",
    ok: true,
    evidence: "observed timeout through the scheduled 30ms deadline",
  });
  expect(
    report.checks.find((check) => check.name === "cancellation terminates subprocess"),
  ).toMatchObject({ ok: true, evidence: "observed cancelled" });
  expect(
    report.checks.find((check) => check.name === "message limit terminates subprocess"),
  ).toMatchObject({ ok: true, evidence: "observed message_too_large" });
});

test("adapter test remains a non-destructive initialization smoke test", async () => {
  const output: string[] = [];
  await run(["adapter", "test", fixture], (line) => output.push(line));

  const result = JSON.parse(output[0] ?? "");
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

  const result = z
    .object({ ok: z.boolean(), checks: z.array(z.unknown()) })
    .parse(JSON.parse(output[0] ?? ""));
  expect(result.ok).toBe(true);
  expect(result.checks).toHaveLength(9);
});

test("typed RPC results must satisfy the caller schema before use", async () => {
  const client = new AdapterClient([process.execPath, fixture]);
  await expect(
    client.call("adapter.initialize", {}, {}, z.object({ requiredResult: z.string() })),
  ).rejects.toThrow("Invalid adapter result");
});
