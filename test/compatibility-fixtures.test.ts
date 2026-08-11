import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const fixtureRoot = join(import.meta.dir, "fixtures", "compatibility");

function fixture<T>(name: string): T {
  return JSON.parse(readFileSync(join(fixtureRoot, name), "utf8")) as T;
}

describe("pickup compatibility fixtures", () => {
  test("frontier remains read-only, filtered, and in map order", () => {
    const value = fixture<{
      map: { subtasks: string[] };
      configuration: { availableStatuses: string[] };
      children: Array<{
        key: string;
        status: string;
        assigned: boolean;
        openBlockers: string[];
      }>;
      expected: {
        eligibleTickets: Array<{ key: string }>;
        firstEligibleTicket: string;
        trackerMutations: number;
      };
    }>("frontier.json");
    const eligible = value.map.subtasks.filter((key) => {
      const child = value.children.find((item) => item.key === key);
      return (
        child !== undefined &&
        value.configuration.availableStatuses.includes(child.status) &&
        !child.assigned &&
        child.openBlockers.length === 0
      );
    });
    expect(value.expected.eligibleTickets.map((ticket) => ticket.key)).toEqual(eligible);
    expect(eligible.length).toBeGreaterThan(0);
    expect(value.expected.firstEligibleTicket).toBe(eligible[0] as string);
    expect(value.expected.trackerMutations).toBe(0);
  });

  test("pickup captures deterministic identity and every supported form", () => {
    const value = fixture<{
      modes: string[];
      expected: {
        plan: {
          ticket: { key: string; role: string };
          workspace: { path: string; branch: string; policy: string };
          session: { worktreePath: string };
          trackerMutations: number;
          worktreesCreated: number;
          sessionsCreated: number;
        };
        resume: Record<string, boolean | number | string>;
      };
    }>("pickup.json");
    expect(value.modes).toEqual(["direct_ticket", "first_frontier", "plan_only", "resume_only"]);
    expect(value.expected.plan.workspace.branch).toBe(
      `${value.expected.plan.ticket.role}/${value.expected.plan.ticket.key}`,
    );
    expect(value.expected.plan.workspace.path.endsWith(`/${value.expected.plan.ticket.key}`)).toBe(
      true,
    );
    expect(value.expected.plan.workspace.policy).toBe("ticket-key-v1");
    expect(value.expected.plan.session.worktreePath).toBe(value.expected.plan.workspace.path);
    expect(value.expected.plan).toMatchObject({
      trackerMutations: 0,
      worktreesCreated: 0,
      sessionsCreated: 0,
    });
    expect(value.expected.resume).toMatchObject({
      sameTransaction: true,
      sameWorkspace: true,
      sameSession: true,
      additionalClaims: 0,
      additionalWorktrees: 0,
      additionalSessions: 0,
    });
  });

  test("map configuration resolves the canonical repository and worktree", () => {
    const value = fixture<{
      input: {
        maps: Record<string, { repository: string }>;
        repositories: Record<string, { github: string; worktree_root: string }>;
      };
      expectedResolution: {
        map: string;
        repositoryConfigKey: string;
        github: string;
        worktreePath: string;
      };
    }>("configuration.json");
    const repositoryKey = value.input.maps[value.expectedResolution.map]?.repository;
    expect(repositoryKey).toBe(value.expectedResolution.repositoryConfigKey);
    const repository = value.input.repositories[value.expectedResolution.repositoryConfigKey];
    expect(repository?.github).toBe(value.expectedResolution.github);
    expect(value.expectedResolution.worktreePath.startsWith(`${repository?.worktree_root}/`)).toBe(
      true,
    );
  });

  test("failure fixtures preserve mutation and recovery boundaries", () => {
    const value = fixture<{
      cases: Array<{ name: string; expected: Record<string, unknown> }>;
    }>("errors.json");
    expect(value.cases.map((item) => item.name)).toEqual([
      "map requires frontier flag",
      "frontier requires map",
      "resume requires manifest",
      "claim race prevents local mutation",
      "worktree failure is compensated",
      "bootstrap failure remains resumable",
    ]);
    expect(value.cases[3]?.expected).toMatchObject({ worktreesCreated: 0, threadsCreated: 0 });
    expect(value.cases[4]?.expected).toMatchObject({ claimRolledBack: true, threadsCreated: 0 });
    expect(value.cases[5]?.expected).toMatchObject({
      manifestState: "bootstrap_pending",
      claimRetained: true,
      worktreeRetained: true,
    });
  });
});
