import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProjectConfiguration } from "../src/configuration.ts";
import { planConfiguredLaunch } from "../src/configuration-plan.ts";
import { acceptanceCriteria, buildLaunchPrompt, jiraDescription } from "../src/launch-prompt.ts";
import {
  configurationVersion,
  INITIAL_CONFIGURATION,
  loadConfigurationInstructions,
  parseProjectToml,
} from "../src/platform/configuration.ts";
import { fakeConfigurationPlan, fakePlanningTicket } from "./fixtures/configuration-plan.ts";

test("pure fake planning includes T3 selection and entire title, description, and VERIFY context", () => {
  const original = structuredClone(fakePlanningTicket);
  const plan = fakeConfigurationPlan();
  expect(plan).toMatchObject({
    state: "planned",
    dryRun: true,
    t3: { provider: "codex", verification: "pending-host-preflight" },
  });
  expect(plan.prompt).toContain(fakePlanningTicket.title as string);
  expect(plan.prompt).toContain(fakePlanningTicket.description as string);
  expect(plan.prompt).toContain("Acceptance criteria:\n- Prompt contains ticket title");
  expect(plan.prompt).toContain("Role:\ntask");
  expect(fakePlanningTicket).toEqual(original);
  plan.ticket.title = "changed";
  expect(fakePlanningTicket).toEqual(original);
});

test.each([
  "## Acceptance criteria",
  "AC:",
  "**Acceptance Criteria**",
  "VERIFY (all must pass; paste output in the PR)",
  "h2. Acceptance Criteria",
])("extracts acceptance section headed %s", (heading) => {
  expect(acceptanceCriteria(`Description\n${heading}\n- One\n- Two\n\nRULES\nKeep scope`)).toBe(
    "- One\n- Two",
  );
});

test("explicit acceptance field takes precedence; absent content is reported honestly", () => {
  const prompt = buildLaunchPrompt({ ...fakePlanningTicket, acceptanceCriteria: "Explicit AC" });
  expect(prompt).toContain("Acceptance criteria:\nExplicit AC");
  expect(prompt).toContain(fakePlanningTicket.description as string);
  const { title: _title, description: _description, ...legacy } = fakePlanningTicket;
  expect(buildLaunchPrompt(legacy)).toContain("Not supplied by tracker");
  expect(buildLaunchPrompt(legacy)).not.toContain("/Users/");
});

test("ADF description preserves paragraph, list, code, hard break and link content", () => {
  const text = (text: string) => ({ type: "text", text });
  const value = {
    type: "doc",
    version: 1,
    content: [
      { type: "heading", content: [text("Acceptance Criteria")] },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [
              {
                type: "paragraph",
                content: [text("First"), { type: "hardBreak" }, text("continued")],
              },
            ],
          },
        ],
      },
      { type: "codeBlock", content: [text("bun test")] },
      {
        type: "paragraph",
        content: [
          {
            ...text("Evidence"),
            marks: [{ type: "link", attrs: { href: "https://example.com/evidence" } }],
          },
        ],
      },
    ],
  };
  expect(jiraDescription(value)).toBe(
    "Acceptance Criteria\nFirst\ncontinued\nbun test\nEvidence (https://example.com/evidence)",
  );
  expect(jiraDescription(null)).toBeUndefined();
  expect(() => jiraDescription({ type: "doc", content: "bad" })).toThrow(
    "Invalid Jira description",
  );
});

test("configured instruction paths are loaded read-only, versioned, and used in the prompt", () => {
  const cwd = mkdtempSync(join(tmpdir(), "wf-instructions-"));
  try {
    const path = join(cwd, "wayfinder.toml");
    const content = `${INITIAL_CONFIGURATION}\n[instructions]\nruntime_contract = "contract.md"\n[instructions.role_templates]\ntask = "task.md"`;
    writeFileSync(path, content);
    writeFileSync(join(cwd, "contract.md"), "Runtime guidance");
    writeFileSync(join(cwd, "task.md"), "Implement exactly this task; report evidence.");
    const configuration = resolveProjectConfiguration(
      parseProjectToml(content),
      {},
      { path, version: configurationVersion(content) },
    );
    const args = {
      ticket: fakePlanningTicket,
      configuration,
      available: { hosts: ["t3"], agents: ["codex"] },
    };
    expect(() => planConfiguredLaunch(args)).toThrow("must be loaded");
    const before = readdirSync(cwd).map((file) => [file, readFileSync(join(cwd, file), "utf8")]);
    const instructions = loadConfigurationInstructions(configuration, "task");
    const plan = planConfiguredLaunch({ ...args, instructions });
    expect(plan.prompt).toContain(join(cwd, "contract.md"));
    expect(plan.prompt).toContain("Allowed action:\nImplement exactly this task; report evidence.");
    expect(plan.instructions).toHaveLength(2);
    expect(plan.instructions[0]?.version).toBe(configurationVersion("Runtime guidance"));
    expect(readdirSync(cwd).map((file) => [file, readFileSync(join(cwd, file), "utf8")])).toEqual(
      before,
    );
    writeFileSync(join(cwd, "task.md"), "Updated guidance");
    const updated = loadConfigurationInstructions(configuration, "task");
    expect(updated.roleTemplate?.version).not.toBe(instructions.roleTemplate?.version);
    expect(plan.prompt).toContain("Implement exactly this task");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
