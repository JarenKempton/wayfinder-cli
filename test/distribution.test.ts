import { describe, expect, test } from "bun:test";
import { completionScript, parseCompletionShell } from "../src/completions.ts";
import { manPage } from "../src/manpage.ts";

describe("distribution documentation", () => {
  test.each(["bash", "zsh", "fish"] as const)("emits %s completion", (shell) => {
    const script = completionScript(shell);
    expect(script).toContain("wayfinder");
    expect(script).toContain("frontier");
    expect(script.endsWith("\n")).toBe(true);
  });

  test("rejects unknown completion shells", () => {
    expect(() => parseCompletionShell("powershell")).toThrow("bash, zsh, fish");
  });

  test("emits a versioned man page", () => {
    const page = manPage("1.2.3-rc.1");
    expect(page).toContain(".TH WAYFINDER 1");
    expect(page).toContain("wayfinder 1.2.3-rc.1");
    expect(page).toContain(".B completions bash|zsh|fish");
  });
});
