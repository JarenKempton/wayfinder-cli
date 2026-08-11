# Compatibility fixtures

JWB-293 records durable behavior for frontier discovery and deterministic
pickup. The machine-readable scenarios live in `test/fixtures/compatibility/`
and cover:

- ordered, read-only frontier selection;
- direct-ticket, first-frontier, plan-only, and resume pickup modes;
- map-to-repository configuration lookup;
- `<role>/<ticket-key>` branches, `<worktree-root>/<ticket-key>` worktrees, and
  the `ticket-key-v1` policy marker;
- stable result/error facts and idempotent resume behavior.

The fixtures belong entirely to this repository. They contain no executable,
filesystem, package, configuration, or runtime dependency on another system.
They specify capabilities and safety properties rather than another tool's
command spelling or implementation-specific wire format.

Dynamic identifiers use deterministic scenario values. Implementations must
preserve identity across resume, not reproduce the literal UUID, commit,
comment, or session identifiers.

## Compatibility rules

1. Frontier reads never mutate tracker, Git, manifest, or T3 state and retain
   native map-child order.
2. Pickup resolves exactly one ticket. A map requires `--frontier`; a direct
   ticket must be a child of a configured map.
3. Dry-run performs resolution and preflight only.
4. Claim happens before worktree creation and launch. A claim race creates
   neither local artifact.
5. Git failure attempts guarded claim rollback. T3 failure retains the claim,
   worktree, and manifest for deterministic resume.
6. Resume reuses the transaction, canonical worktree, branch, and T3 thread and
   does not repeat completed mutations.

These scenarios are a repository-owned acceptance baseline. When the relevant
public commands are available, conformance tests should exercise those commands
directly while retaining the same behavioral assertions.
