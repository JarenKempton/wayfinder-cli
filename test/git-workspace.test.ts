import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import type { RepositorySpec, Ticket, TicketRef } from "../src/domain.ts";
import {
  DirtyWorkspaceError,
  type GitCommandExecutor,
  GitWorkspaceAdapter,
  parseWorktrees,
  WorkspaceConflictError,
} from "../src/git-workspace.ts";

class FakeGit implements GitCommandExecutor {
  readonly calls: { argv: readonly string[]; cwd: string }[] = [];
  worktrees = "";
  branchExists = false;
  dirty = false;

  async run(argv: readonly string[], cwd: string) {
    this.calls.push({ argv, cwd });
    const command = argv.join(" ");
    if (command === "git rev-parse --show-toplevel") return ok(cwd);
    if (command === "git rev-parse --verify origin/main") return ok("abc");
    if (command === "git remote get-url origin") return ok("git@example.test:team/repo.git");
    if (command === "git worktree list --porcelain") return ok(this.worktrees);
    if (command.startsWith("git show-ref")) return this.branchExists ? ok("") : fail();
    if (command.includes(" status --porcelain")) return ok(this.dirty ? " M owned.txt\n" : "");
    if (command.startsWith("git worktree add")) {
      const path = this.branchExists ? argv.at(-2) : argv.at(-2);
      const branch = this.branchExists ? argv.at(-1) : argv.at(-3);
      this.worktrees = `worktree ${path}\nbranch refs/heads/${branch}\n`;
      return ok("");
    }
    if (command.startsWith("git worktree remove")) {
      this.worktrees = "";
      return ok("");
    }
    return fail("unexpected command");
  }
}

const repository: RepositorySpec = {
  name: "repo",
  remote: "git@example.test:team/repo.git",
  path: "/source/repo",
  worktreeRoot: "/worktrees",
  baseBranch: "origin/main",
};
const repositoryPath = resolve(repository.path);
const worktreePath = resolve(repository.worktreeRoot, "ABC-123");
const ticket: Ticket = {
  ref: "jira:example:TEAM:ticket:ABC-123" as TicketRef,
  map: "jira:example:TEAM:map:ABC-1" as Ticket["map"],
  kind: "task",
  state: "open",
  status: "To Do",
  order: 0,
};

function ok(stdout: string) {
  return { exitCode: 0, stdout, stderr: "" };
}
function fail(stderr = "not found") {
  return { exitCode: 1, stdout: "", stderr };
}
function subject(git = new FakeGit()) {
  return { git, workspace: new GitWorkspaceAdapter(repository, git) };
}

describe("Git workspace adapter", () => {
  test("maps a ticket to canonical native paths and branch names", async () => {
    const { workspace } = subject();
    expect(await workspace.plan(ticket)).toEqual({
      ticket: ticket.ref,
      path: worktreePath,
      branch: "task/ABC-123",
    });
  });

  test("preflight verifies the mapped repository, base branch, and origin", async () => {
    const { workspace, git } = subject();
    await workspace.preflight(ticket);
    expect(git.calls.map((call) => call.argv)).toEqual([
      ["git", "rev-parse", "--show-toplevel"],
      ["git", "rev-parse", "--verify", "origin/main"],
      ["git", "remote", "get-url", "origin"],
    ]);
  });

  test("resumes an exact registered worktree without mutating dirty work", async () => {
    const { workspace, git } = subject();
    git.worktrees = `worktree ${worktreePath}\nbranch refs/heads/task/ABC-123\n`;
    expect(await workspace.prepare(await workspace.plan(ticket))).toEqual({
      path: worktreePath,
      branch: "task/ABC-123",
    });
    expect(git.calls).toHaveLength(1);
  });

  test("fails closed on path or branch collisions", async () => {
    const first = subject();
    first.git.worktrees = `worktree ${worktreePath}\nbranch refs/heads/task/OTHER\n`;
    await expect(
      first.workspace.prepare(await first.workspace.plan(ticket)),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);

    const second = subject();
    second.git.worktrees = `worktree ${resolve("/somewhere/else")}\nbranch refs/heads/task/ABC-123\n`;
    await expect(
      second.workspace.prepare(await second.workspace.plan(ticket)),
    ).rejects.toBeInstanceOf(WorkspaceConflictError);
  });

  test("creates and verifies a deterministic worktree", async () => {
    const { workspace, git } = subject();
    expect(await workspace.prepare(await workspace.plan(ticket))).toEqual({
      path: worktreePath,
      branch: "task/ABC-123",
    });
    expect(git.calls.some((call) => call.argv[2] === "add" && call.argv[3] === "-b")).toBeTrue();
  });

  test("uses an existing branch without recreating it", async () => {
    const { workspace, git } = subject();
    git.branchExists = true;
    await workspace.prepare(await workspace.plan(ticket));
    expect(git.calls).toContainEqual({
      argv: ["git", "worktree", "add", worktreePath, "task/ABC-123"],
      cwd: repositoryPath,
    });
  });

  test("explicit deletion refuses dirty work", async () => {
    const { workspace, git } = subject();
    git.worktrees = `worktree ${worktreePath}\nbranch refs/heads/task/ABC-123\n`;
    git.dirty = true;
    await expect(workspace.delete(worktreePath)).rejects.toBeInstanceOf(DirtyWorkspaceError);
    expect(git.calls.some((call) => call.argv[2] === "remove")).toBeFalse();
  });

  test("explicit deletion removes a verified clean worktree", async () => {
    const { workspace, git } = subject();
    git.worktrees = `worktree ${worktreePath}\nbranch refs/heads/task/ABC-123\n`;
    await workspace.delete(worktreePath);
    expect(git.calls.at(-1)?.argv).toEqual(["git", "worktree", "remove", worktreePath]);
  });

  test("parses CRLF porcelain output and preserves paths containing spaces", () => {
    const nativePath = "C:\\Users\\Jaren\\Wayfinder Worktrees\\ABC-123";
    expect(parseWorktrees(`worktree ${nativePath}\r\nbranch refs/heads/task/ABC-123\r\n`)).toEqual([
      { path: resolve(nativePath), branch: "task/ABC-123" },
    ]);
  });

  test("passes a path with spaces as one argv element", async () => {
    const git = new FakeGit();
    const workspace = new GitWorkspaceAdapter({ ...repository, worktreeRoot: "/work trees" }, git);
    await workspace.prepare(await workspace.plan(ticket));
    expect(
      git.calls.some((call) => call.argv.includes(resolve("/work trees", "ABC-123"))),
    ).toBeTrue();
  });
});
