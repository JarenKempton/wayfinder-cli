import { PrototypeLedger, pidIsAlive } from "./model.ts";

const [, , role, databasePath, leaseText = "600"] = process.argv;
const leaseMs = Number(leaseText);

if (role === "harness") {
  setInterval(() => {}, 60_000);
} else if (role === "cli") {
  const harnessPid = Number(process.argv[5]);
  const ledger = new PrototypeLedger(databasePath);
  ledger.initialize(harnessPid, Date.now(), leaseMs);
  ledger.close();
} else if (role === "supervisor") {
  const ledger = new PrototypeLedger(databasePath);
  ledger.bootSupervisor(process.pid, Date.now());
  const tick = () => {
    const snapshot = ledger.snapshot();
    ledger.supervise(Date.now(), leaseMs, pidIsAlive(snapshot.harnessPid));
  };
  tick();
  setInterval(tick, Math.max(50, Math.floor(leaseMs / 3)));
} else {
  throw new Error(`Unknown prototype process role: ${role}`);
}
