import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaunchRequest } from "../src/contracts.ts";
import type { HarnessPlatform, HarnessProcess } from "../src/harness-adapters.ts";
import {
  CommandHarnessAdapter,
  namedHarnessAdapter,
  namedHarnessCapabilities,
} from "../src/harness-adapters.ts";

class FakePlatform implements HarnessPlatform {
  platform: NodeJS.Platform = "darwin";
  found = new Set<string>();
  calls: { argv: readonly string[]; cwd: string }[] = [];
  killed: Array<number | NodeJS.Signals | undefined> = [];

  which(executable: string) {
    return this.found.has(executable) ? `/bin/${executable}` : null;
  }

  spawn(argv: readonly string[], cwd: string): HarnessProcess {
    this.calls.push({ argv, cwd });
    let finish = (_code: number) => {};
    const exited = new Promise<number>((resolve) => {
      finish = resolve;
    });
    return {
      pid: 42,
      exited,
      kill: (signal) => {
        this.killed.push(signal);
        finish(0);
      },
    };
  }
}

function fixture() {
  const path = mkdtempSync(join(tmpdir(), "wayfinder-harness-"));
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
    model: "model-x",
    effort: "high",
    context: "Keep the change narrow.",
  };
  return { path, request, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

describe("generic command harness", () => {
  test("advertises only detected and explicitly templated capabilities", async () => {
    const platform = new FakePlatform();
    const adapter = new CommandHarnessAdapter({
      argv: ["agent", "--model", "{model}", "{prompt}"],
      platform,
    });
    expect(await adapter.describe()).toEqual({ prompt_generation: true });
    platform.found.add("agent");
    expect(await adapter.describe()).toEqual({
      prompt_generation: true,
      process_launch: true,
      model_selection: true,
    });
  });

  test("launches with an argv array and stops only its owned child handle", async () => {
    const item = fixture();
    const platform = new FakePlatform();
    platform.found.add("agent");
    const adapter = new CommandHarnessAdapter({ argv: ["agent", "{prompt}"], platform });
    try {
      const receipt = await adapter.launch(item.request);
      expect(platform.calls).toEqual([
        {
          argv: ["agent", "Work on jira:example:W:ticket:T-1.\n\nKeep the change narrow."],
          cwd: item.path,
        },
      ]);
      await adapter.stop(receipt);
      expect(platform.killed).toEqual(["SIGTERM"]);
      await expect(adapter.stop({ pid: 42, tier: "launch" })).rejects.toThrow("bare-PID");
    } finally {
      item.cleanup();
    }
  });

  test("preflight rejects missing executables before spawning", async () => {
    const item = fixture();
    const platform = new FakePlatform();
    try {
      const adapter = new CommandHarnessAdapter({ argv: ["missing", "{prompt}"], platform });
      await expect(adapter.preflight(item.request)).rejects.toThrow("executable not found");
      expect(platform.calls).toEqual([]);
    } finally {
      item.cleanup();
    }
  });
});

describe("named harnesses", () => {
  test("use the correct executable names and conservative launch capabilities", async () => {
    const expected = {
      t3: "t3",
      pi: "pi",
      claude: "claude",
      codex: "codex",
      cursor: "cursor-agent",
      opencode: "opencode",
    } as const;
    for (const [name, executable] of Object.entries(expected)) {
      const platform = new FakePlatform();
      platform.found.add(executable);
      const adapter = namedHarnessAdapter(name as keyof typeof expected, platform);
      const described = await adapter.describe();
      expect(described.prompt_generation).toBe(name === "t3" ? undefined : true);
      expect(described.process_launch).toBeTrue();
      expect(described.session_status).toBeUndefined();
      expect(described.session_interrupt).toBeUndefined();
      expect(described.session_close).toBeUndefined();
    }
  });

  test("does not advertise a platform-qualified adapter on unsupported native Windows", async () => {
    const platform = new FakePlatform();
    platform.platform = "win32";
    platform.found.add("cursor-agent");
    const expected = {
      prompt_generation: true,
    } as const;
    expect(await namedHarnessAdapter("cursor", platform).describe()).toEqual(expected);
    expect(namedHarnessCapabilities("cursor", platform)).toEqual(expected);
  });

  test("advertises T3 host visibility only after detecting its executable", () => {
    const platform = new FakePlatform();
    expect(namedHarnessCapabilities("t3", platform)).toEqual({});
    platform.found.add("t3");
    expect(namedHarnessCapabilities("t3", platform)).toEqual({
      process_launch: true,
      visible_multi_session: true,
    });
  });
});
