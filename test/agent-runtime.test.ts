import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentInvocation,
  AgentRuntime,
  LaunchReceipt,
  LaunchRequest,
} from "../src/contracts.ts";
import { HarnessLaunchError } from "../src/contracts.ts";
import type { HarnessPlatform, HarnessProcess } from "../src/harness-adapters.ts";
import { CommandHarnessAdapter, HostRuntime } from "../src/harness-adapters.ts";

const PROMPT = "Work on jira:example:W:ticket:T-1.\n\nKeep the change narrow.";

class FakePlatform implements HarnessPlatform {
  platform: NodeJS.Platform = "darwin";
  found = new Set<string>();
  calls: { argv: readonly string[]; cwd: string }[] = [];
  killed: Array<number | NodeJS.Signals | undefined> = [];
  #finishers: Array<(code: number) => void> = [];

  which(executable: string) {
    return this.found.has(executable) ? `/bin/${executable}` : null;
  }

  spawn(argv: readonly string[], cwd: string): HarnessProcess {
    this.calls.push({ argv, cwd });
    let finish = (_code: number) => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    this.#finishers.push(finish);
    return {
      pid: 42,
      exited,
      kill: (signal) => {
        this.killed.push(signal);
        finish(0);
      },
    };
  }

  /** Simulate the most-recently spawned child exiting on its own, then drain callbacks. */
  async exitLast(): Promise<void> {
    this.#finishers.at(-1)?.(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "wayfinder-runtime-"));
  const request: LaunchRequest = {
    run: "wayfinder-run:test",
    ticket: {
      ref: "jira:example:W:ticket:T-1" as LaunchRequest["ticket"]["ref"],
      map: "jira:example:W:map:M-1" as LaunchRequest["ticket"]["map"],
      kind: "task",
      state: "open",
      status: "In Progress",
      order: 1,
    },
    workspace: { path },
    context: "Keep the change narrow.",
  };
  return { path, request, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe("agent invocation / execution boundary", () => {
  test("invoke() describes a portable invocation without launching anything", async () => {
    const item = fixture();
    const platform = new FakePlatform();
    platform.found.add("agent");
    try {
      const adapter = new CommandHarnessAdapter({ argv: ["agent", "{prompt}"], platform });
      const invocation = await adapter.invoke(item.request);
      expect(invocation).toEqual({ agent: "command", argv: ["agent", PROMPT], cwd: item.path });
      expect(platform.calls).toEqual([]);
    } finally {
      item.cleanup();
    }
  });

  test("the host runtime and an isolated runtime execute the identical invocation", async () => {
    const item = fixture();
    const platform = new FakePlatform();
    platform.found.add("agent");
    try {
      const adapter = new CommandHarnessAdapter({ argv: ["agent", "{prompt}"], platform });
      const invocation = await adapter.invoke(item.request);

      const host = new HostRuntime(platform);
      const hostReceipt = await host.execute(invocation);
      expect(platform.calls).toEqual([{ argv: invocation.argv, cwd: item.path }]);
      expect(hostReceipt).toMatchObject({ pid: 42, tier: "launch" });
      expect(hostReceipt.sessionId).toContain("command:");
      await host.stop(hostReceipt);
      expect(platform.killed).toEqual(["SIGTERM"]);

      const executed: AgentInvocation[] = [];
      const isolated: AgentRuntime = {
        async describe() {
          return {};
        },
        async execute(received) {
          executed.push(received);
          return { sessionId: `isolated:${received.agent}`, tier: "managed" };
        },
        async stop() {
          /* the isolated runtime owns its own teardown */
        },
      };
      const isolatedReceipt = await isolated.execute(invocation);
      expect(executed).toEqual([invocation]);
      expect(isolatedReceipt).toEqual({ sessionId: "isolated:command", tier: "managed" });
      // The isolated runtime never touched the host: still one host spawn.
      expect(platform.calls).toHaveLength(1);
    } finally {
      item.cleanup();
    }
  });

  test("the adapter delegates launch and stop to an injected runtime", async () => {
    const item = fixture();
    const platform = new FakePlatform();
    platform.found.add("agent");
    try {
      const executed: AgentInvocation[] = [];
      const stopped: LaunchReceipt[] = [];
      const runtime: AgentRuntime = {
        async describe() {
          return { process_launch: true };
        },
        async execute(received) {
          executed.push(received);
          return { sessionId: "run:1", pid: 7, tier: "launch" };
        },
        async stop(receipt) {
          stopped.push(receipt);
        },
      };
      const adapter = new CommandHarnessAdapter({ argv: ["agent", "{prompt}"], platform, runtime });

      const receipt = await adapter.launch(item.request);
      expect(receipt).toEqual({ sessionId: "run:1", pid: 7, tier: "launch" });
      expect(executed).toEqual([{ agent: "command", argv: ["agent", PROMPT], cwd: item.path }]);
      // Execution is the runtime's concern: the host platform was never spawned.
      expect(platform.calls).toEqual([]);

      await adapter.stop(receipt);
      expect(stopped).toEqual([receipt]);
    } finally {
      item.cleanup();
    }
  });

  test("the host runtime advertises the launch capability", async () => {
    expect(await new HostRuntime(new FakePlatform()).describe()).toEqual({ process_launch: true });
  });

  test("host stop is idempotent after natural exit and refuses handles it does not own", async () => {
    const platform = new FakePlatform();
    const host = new HostRuntime(platform);
    const receipt = await host.execute({ agent: "command", argv: ["agent"], cwd: "/tmp" });

    await platform.exitLast();
    await host.stop(receipt);
    expect(platform.killed).toEqual([]);

    await expect(host.stop({ pid: 42, tier: "launch" })).rejects.toThrow("bare-PID");
    await expect(host.stop({ sessionId: "command:unknown", tier: "launch" })).rejects.toThrow(
      "bare-PID",
    );
  });

  test("host execution wraps spawn failures as HarnessLaunchError", async () => {
    const platform = new FakePlatform();
    platform.spawn = () => {
      throw new Error("spawn boom");
    };
    const host = new HostRuntime(platform);
    const error = await host
      .execute({ agent: "command", argv: ["agent"], cwd: "/tmp" })
      .catch((thrown) => thrown);
    expect(error).toBeInstanceOf(HarnessLaunchError);
    expect((error as Error).message).toBe("spawn boom");
  });
});
