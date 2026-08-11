import type { RunLifecycleAdapter } from "../contracts.ts";
import type { Run, RunObservation } from "../domain.ts";

/** Narrow Bun/Node process implementation; managed sessions use harness adapters instead. */
export class ProcessLifecycleAdapter implements RunLifecycleAdapter {
  async observe(run: Run): Promise<RunObservation> {
    const observedAt = new Date().toISOString();
    const pid = run.execution?.pid;
    if (pid === undefined)
      return { state: "unknown", observedAt, detail: "No process id recorded" };
    try {
      process.kill(pid, 0);
      return { state: "running", observedAt };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ESRCH") return { state: "missing", observedAt };
      return {
        state: "unknown",
        observedAt,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async stop(run: Run): Promise<void> {
    const pid = run.execution?.pid;
    if (pid === undefined)
      throw new Error("Run has no process id; use its harness lifecycle adapter");
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
}
