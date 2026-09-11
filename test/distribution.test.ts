import { describe, expect, test } from "bun:test";
import { createApplication } from "../src/application.ts";
import {
  completionCandidates,
  completionScript,
  parseCompletionShell,
} from "../src/cli/completions.ts";
import { manPage } from "../src/cli/manpage.ts";

describe("distribution documentation", () => {
  test.each(["bash", "zsh", "fish"] as const)("emits %s completion", (shell) => {
    const script = completionScript(shell);
    expect(script).toContain("wayfinder");
    expect(script).toContain("--complete");
    expect(script).toContain(shell);
    expect(completionCandidates(createApplication(), [])).toContain("frontier");
    expect(script.endsWith("\n")).toBe(true);
  });

  test("rejects unknown completion shells", () => {
    expect(() => parseCompletionShell("powershell")).toThrow("bash, zsh, fish");
  });

  test("emits a versioned man page", () => {
    const page = manPage("1.2.3-rc.1", createApplication());
    expect(page).toContain('.TH "WAYFINDER" 1');
    expect(page).toContain("wayfinder 1.2.3-rc.1");
    expect(page).toContain("Print shell completion for currently available actions.");
  });
});

test("generated manual retains operational contracts alongside available commands", () => {
  const page = manPage("test", createApplication());
  for (const heading of ["ENVIRONMENT", "FILES", "EXIT STATUS", "SEE ALSO"])
    expect(page).toContain(heading);
  for (const variable of [
    "WAYFINDER_NO_UPDATE_CHECK",
    "WAYFINDER_UPDATE_URL",
    "XDG_STATE_HOME",
    "LOCALAPPDATA",
    "VISUAL",
    "EDITOR",
  ])
    expect(page).toContain(variable);
  expect(page).toContain("Secrets must not be placed");
  expect(page).toContain("command arguments, logs, or receipts");
  expect(page).toContain("wayfinder.db");
  expect(page).toContain("config show");
  expect(page).not.toContain("Stop a recorded run");
});
