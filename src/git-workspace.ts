import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkspaceAdapter, WorkspacePlan } from "./contracts.ts";
import type { RepositorySpec, Ticket, TicketRef } from "./domain.ts";
import { parseRef } from "./reference.ts";

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface GitCommandExecutor {
  run(argv: readonly string[], cwd: string): Promise<CommandResult>;
}

export class BunGitCommandExecutor implements GitCommandExecutor {
  async run(argv: readonly string[], cwd: string): Promise<CommandResult> {
    const process = Bun.spawn([...argv], { cwd, stdout: "pipe", stderr: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  }
}

export class WorkspaceConflictError extends Error {
  readonly code = "workspace_conflict";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceConflictError";
  }
}

export class DirtyWorkspaceError extends Error {
  readonly code = "dirty_workspace";

  constructor(readonly path: string) {
    super(`Refusing to delete dirty workspace: ${path}`);
    this.name = "DirtyWorkspaceError";
  }
}

interface WorktreeRecord {
  path: string;
  branch?: string;
  prunable?: string;
}

/** Git-backed workspaces with deterministic paths and fail-closed resumption. */
export class GitWorkspaceAdapter implements WorkspaceAdapter {
  readonly #repository: RepositorySpec;
  readonly #git: GitCommandExecutor;
  readonly #pathExists: (path: string) => Promise<boolean>;

  constructor(
    repository: RepositorySpec,
    git: GitCommandExecutor = new BunGitCommandExecutor(),
    exists: (path: string) => Promise<boolean> = pathExists,
  ) {
    this.#repository = canonicalRepository(repository);
    this.#git = git;
    this.#pathExists = exists;
  }

  async preflight(ticket: Ticket): Promise<void> {
    this.#ticketId(ticket.ref);
    const topLevel = resolve(await this.#gitChecked(["git", "rev-parse", "--show-toplevel"]));
    if (topLevel !== this.#repository.path) {
      throw new WorkspaceConflictError(
        `Repository path mismatch: expected ${this.#repository.path}, found ${topLevel}`,
      );
    }
    await this.#gitChecked(["git", "rev-parse", "--verify", this.#repository.baseBranch]);
    const remote = (await this.#gitChecked(["git", "remote", "get-url", "origin"])).trim();
    if (remote !== this.#repository.remote) {
      throw new WorkspaceConflictError(
        `Repository origin mismatch: expected ${this.#repository.remote}, found ${remote}`,
      );
    }
  }

  async plan(ticket: Ticket): Promise<WorkspacePlan> {
    const ticketId = this.#ticketId(ticket.ref);
    return {
      ticket: ticket.ref,
      path: resolve(this.#repository.worktreeRoot, ticketId),
      branch: `${ticket.kind}/${ticketId}`,
    };
  }

  async prepare(plan: WorkspacePlan) {
    const expectedPath = resolve(plan.path);
    const expectedBranch = plan.branch;
    if (!expectedBranch) throw new Error("Git workspace plans require a branch");
    requireSafeGitRef(expectedBranch);
    const records = await this.#worktrees();
    const atPath = records.find((item) => item.path === expectedPath);
    if (atPath) {
      if (atPath.prunable !== undefined || !(await this.#pathExists(expectedPath))) {
        throw new WorkspaceConflictError(
          `Registered workspace is missing or prunable: ${expectedPath}`,
        );
      }
      if (atPath.branch !== expectedBranch) {
        throw new WorkspaceConflictError(
          `Workspace path is registered to ${atPath.branch ?? "a detached HEAD"}, not ${expectedBranch}`,
        );
      }
      return { path: expectedPath, branch: expectedBranch };
    }
    const branchElsewhere = records.find((item) => item.branch === expectedBranch);
    if (branchElsewhere) {
      throw new WorkspaceConflictError(
        `Branch ${expectedBranch} is already checked out at ${branchElsewhere.path}`,
      );
    }
    if (await this.#pathExists(expectedPath)) {
      throw new WorkspaceConflictError(`Unregistered path already exists: ${expectedPath}`);
    }

    const branchExists =
      (
        await this.#runGit([
          "git",
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${expectedBranch}`,
        ])
      ).exitCode === 0;
    const argv = branchExists
      ? ["git", "worktree", "add", expectedPath, expectedBranch]
      : ["git", "worktree", "add", "-b", expectedBranch, expectedPath, this.#repository.baseBranch];
    await this.#gitChecked(argv);

    const prepared = (await this.#worktrees()).find((item) => item.path === expectedPath);
    if (prepared?.branch !== expectedBranch) {
      throw new WorkspaceConflictError(
        "Git did not create the requested workspace deterministically",
      );
    }
    return { path: expectedPath, branch: expectedBranch };
  }

  /** Destruction is never part of prepare/resume and must be requested explicitly. */
  async delete(path: string): Promise<void> {
    const target = resolve(path);
    const record = (await this.#worktrees()).find((item) => item.path === target);
    if (!record) throw new WorkspaceConflictError(`Workspace is not registered: ${target}`);
    const status = await this.#gitChecked(["git", "-C", target, "status", "--porcelain"]);
    if (status.length > 0) throw new DirtyWorkspaceError(target);
    await this.#gitChecked(["git", "worktree", "remove", target]);
  }

  async #worktrees(): Promise<WorktreeRecord[]> {
    return parseWorktrees(await this.#gitChecked(["git", "worktree", "list", "--porcelain"]));
  }

  #ticketId(ticket: TicketRef): string {
    const parsed = parseRef(ticket);
    if (parsed.kind !== "ticket" || !parsed.nativeId)
      throw new Error("Expected a ticket reference");
    if (!isSafeGitComponent(parsed.nativeId)) {
      throw new Error(`Ticket id is not safe for a Git branch or path: ${parsed.nativeId}`);
    }
    return parsed.nativeId;
  }

  #runGit(argv: readonly string[]): Promise<CommandResult> {
    return this.#git.run(argv, this.#repository.path);
  }

  async #gitChecked(argv: readonly string[]): Promise<string> {
    const result = await this.#runGit(argv);
    if (result.exitCode !== 0) {
      throw new Error(`Git command failed (${result.exitCode}): ${result.stderr.trim()}`);
    }
    return result.stdout.trim();
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function canonicalRepository(repository: RepositorySpec): RepositorySpec {
  if (
    !repository.remote.trim() ||
    !repository.baseBranch.trim() ||
    !repository.path.trim() ||
    !repository.worktreeRoot.trim()
  ) {
    throw new Error("Repository remote, base branch, path, and worktree root are required");
  }
  return {
    ...repository,
    path: resolve(repository.path),
    worktreeRoot: resolve(repository.worktreeRoot),
  };
}

export function parseWorktrees(output: string): WorktreeRecord[] {
  return output
    .split(/\r?\n\r?\n/)
    .map((section) => section.split(/\r?\n/))
    .flatMap((lines) => {
      const path = lines.find((line) => line.startsWith("worktree "))?.slice(9);
      if (!path) return [];
      const branch = lines.find((line) => line.startsWith("branch refs/heads/"))?.slice(18);
      const prunable = lines
        .find((line) => line.startsWith("prunable"))
        ?.slice(9)
        .trim();
      return [
        {
          path: resolve(path),
          ...(branch ? { branch } : {}),
          ...(prunable !== undefined ? { prunable } : {}),
        },
      ];
    });
}

function isSafeGitComponent(value: string): boolean {
  return (
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.includes("..") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock")
  );
}

function requireSafeGitRef(value: string): void {
  const hasForbiddenCharacter = [...value].some(
    (character) =>
      character.charCodeAt(0) <= 32 ||
      character.charCodeAt(0) === 127 ||
      "~^:?*[\\".includes(character),
  );
  if (
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock") ||
    value.includes("..") ||
    value.includes("@{") ||
    hasForbiddenCharacter
  ) {
    throw new Error(`Branch is not a safe Git reference: ${value}`);
  }
}
