import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrototypeLedger } from "./model.ts";

const leaseMs = 600;
const directory = mkdtempSync(join(tmpdir(), "wayfinder-jwb-281-prototype-"));
const databasePath = join(directory, "PROTOTYPE-wipe-me.sqlite");
const processScript = join(import.meta.dir, "process.ts");
const children: ChildProcess[] = [];

function child(role: "cli" | "harness" | "supervisor", extra: string[] = []): ChildProcess {
  const value = spawn(
    process.execPath,
    ["run", processScript, role, databasePath, String(leaseMs), ...extra],
    {
      stdio: "ignore",
    },
  );
  children.push(value);
  return value;
}

function kill(value: ChildProcess): void {
  if (value.pid && value.exitCode === null && value.signalCode === null) value.kill("SIGKILL");
}

const pause = (ms: number) => Bun.sleep(ms);

function assertState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
  console.log(`PASS  ${message}`);
}

let ledger: PrototypeLedger | undefined;
try {
  console.log("JWB-281 crash supervision prototype\n");
  const harness = child("harness");
  await pause(100);
  assertState(harness.pid, "harness process started");

  const cli = child("cli", [String(harness.pid)]);
  await new Promise<void>((resolve, reject) => {
    cli.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`CLI exited ${code}`))));
  });
  ledger = new PrototypeLedger(databasePath);
  assertState(
    ledger.snapshot().status === "active",
    "CLI exit leaves a durable active run and lease",
  );

  let supervisor = child("supervisor");
  await pause(300);
  const afterCliCrash = ledger.snapshot();
  assertState(
    afterCliCrash.status === "active",
    "separate supervisor renews after the CLI process is gone",
  );

  const firstEpoch = afterCliCrash.supervisorEpoch;
  kill(supervisor);
  await pause(leaseMs + 150);
  assertState(
    ledger.snapshot().status === "stale",
    "supervisor crash makes lease stale without changing ownership",
  );

  supervisor = child("supervisor");
  await pause(300);
  const afterSupervisorRestart = ledger.snapshot();
  assertState(
    afterSupervisorRestart.supervisorEpoch === firstEpoch + 1,
    "one replacement supervisor records a new epoch",
  );
  assertState(
    afterSupervisorRestart.status === "active",
    "replacement supervisor resumes renewal from WAL state",
  );
  assertState(
    afterSupervisorRestart.claim === afterCliCrash.claim,
    "restart retains the exact claim identity",
  );

  kill(harness);
  await pause(350);
  const afterHarnessCrash = ledger.snapshot();
  assertState(
    afterHarnessCrash.status === "attention_required",
    "harness crash is durably surfaced as attention_required",
  );

  console.log("\nFinal state");
  console.log(JSON.stringify(afterHarnessCrash, null, 2));
  console.log("\nDurable event sequence");
  console.log(JSON.stringify(ledger.events(), null, 2));
  console.log("\nVERDICT: PROVED for the tested local process model.");
  console.log(
    "A single per-user supervisor can resume matching-claim renewal after restart and expose a dead harness.",
  );
} finally {
  for (const value of children) kill(value);
  ledger?.close();
  rmSync(directory, { recursive: true, force: true });
}
