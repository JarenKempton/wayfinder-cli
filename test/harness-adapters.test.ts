import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtInAdapters } from "../src/adapters.ts";
import type { LaunchRequest } from "../src/contracts.ts";
import type { HarnessPlatform, HarnessProcess } from "../src/harness-adapters.ts";
import {
  CommandHarnessAdapter,
  type NamedHarnessName,
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
  const profiles: Record<
    NamedHarnessName,
    { executable: string; argv: readonly string[]; nativeWindows: boolean }
  > = {
    pi: { executable: "pi", argv: ["pi", "-p", "{prompt}"], nativeWindows: true },
    claude: {
      executable: "claude",
      argv: ["claude", "-p", "{prompt}"],
      nativeWindows: false,
    },
    codex: {
      executable: "codex",
      argv: ["codex", "exec", "{prompt}"],
      nativeWindows: false,
    },
    cursor: {
      executable: "cursor-agent",
      argv: ["cursor-agent", "-p", "{prompt}"],
      nativeWindows: false,
    },
    opencode: {
      executable: "opencode",
      argv: ["opencode", "run", "{prompt}"],
      nativeWindows: true,
    },
  };

  test("renders the documented launch argv exactly for every named command harness", async () => {
    const item = fixture();
    try {
      for (const [name, profile] of Object.entries(profiles)) {
        const platform = new FakePlatform();
        platform.found.add(profile.executable);
        const adapter = namedHarnessAdapter(name as NamedHarnessName, platform);
        const receipt = await adapter.launch(item.request);
        expect(platform.calls).toEqual([
          {
            argv: profile.argv.map((token) =>
              token === "{prompt}"
                ? "Work on jira:example:W:ticket:T-1.\n\nKeep the change narrow."
                : token,
            ),
            cwd: item.path,
          },
        ]);
        await adapter.stop(receipt);
      }
    } finally {
      item.cleanup();
    }
  });

  test("detection adds only process launch to the implemented prepare tier", async () => {
    for (const [name, profile] of Object.entries(profiles)) {
      const platform = new FakePlatform();
      const adapter = namedHarnessAdapter(name as NamedHarnessName, platform);
      expect(await adapter.describe()).toEqual({ prompt_generation: true });
      expect(namedHarnessCapabilities(name as NamedHarnessName, platform)).toEqual({
        prompt_generation: true,
      });
      platform.found.add(profile.executable);
      const expected = { prompt_generation: true, process_launch: true } as const;
      expect(await adapter.describe()).toEqual(expected);
      expect(namedHarnessCapabilities(name as NamedHarnessName, platform)).toEqual(expected);
    }
  });

  test("applies the documented native-platform qualification to every named harness", async () => {
    for (const [name, profile] of Object.entries(profiles)) {
      for (const os of ["darwin", "linux", "win32"] as const) {
        const platform = new FakePlatform();
        platform.platform = os;
        platform.found.add(profile.executable);
        const launchSupported = os !== "win32" || profile.nativeWindows;
        expect(await namedHarnessAdapter(name as NamedHarnessName, platform).describe()).toEqual({
          prompt_generation: true,
          ...(launchSupported ? { process_launch: true } : {}),
        });
      }
    }
  });

  test("registry availability uses the same injected executable and platform gate", () => {
    for (const name of ["claude", "codex", "cursor"] as const) {
      const platform = new FakePlatform();
      platform.platform = "win32";
      platform.found.add(profiles[name].executable);
      const descriptor = builtInAdapters(platform).find((adapter) => adapter.name === name);
      expect(descriptor).toMatchObject({
        name,
        available: false,
        capabilities: { prompt_generation: true },
      });

      platform.platform = "linux";
      expect(builtInAdapters(platform).find((adapter) => adapter.name === name)).toMatchObject({
        name,
        available: true,
        capabilities: { prompt_generation: true, process_launch: true },
      });

      platform.found.clear();
      expect(builtInAdapters(platform).find((adapter) => adapter.name === name)).toMatchObject({
        name,
        available: false,
        capabilities: { prompt_generation: true },
      });
    }
  });

  test("keeps T3 out of command discovery and advertises no unproven host capability", () => {
    const t3 = builtInAdapters().find((adapter) => adapter.name === "t3");
    expect(t3).toEqual({
      name: "t3",
      kind: "harness",
      bundled: false,
      available: false,
      capabilities: {},
    });
  });

  test("never advertises managed lifecycle from command adapters", async () => {
    const forbidden = [
      "session_create",
      "session_resume",
      "session_status",
      "session_interrupt",
      "session_close",
    ] as const;
    for (const [name, profile] of Object.entries(profiles)) {
      const platform = new FakePlatform();
      platform.found.add(profile.executable);
      const adapter = namedHarnessAdapter(name as NamedHarnessName, platform);
      const described = await adapter.describe();
      for (const capability of forbidden) expect(described[capability]).toBeUndefined();
    }
  });
});
