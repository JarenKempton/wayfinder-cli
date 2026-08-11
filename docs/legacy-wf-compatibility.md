# Legacy `wf` compatibility baseline

JWB-293 freezes the observable behavior of the Python `wf` pickup helper that
predates this TypeScript CLI. The machine-readable fixtures live in
`test/fixtures/legacy-wf/` and cover:

- `wf frontier <map> [--json]` and ordered, read-only frontier selection;
- direct-ticket and `--frontier` pickup, `--dry-run`, `--resume`, and `--t3`;
- the map-to-repository configuration lookup;
- `<role>/<ticket-key>` branches, `<worktree-root>/<ticket-key>` worktrees, and
  the `ticket-key-v1` policy marker;
- stable success/error envelopes and idempotent resume behavior.

Dynamic identifiers in golden output use deterministic fixture values. They
stand for values generated at runtime; compatibility consumers must preserve
identity across resume, not reproduce the literal UUID, commit, comment, or T3
thread identifiers.

## Migration boundary

The primary executable for this repository is `wayfinder`. The existing `wf`
command is currently a separate skill/MCP-side launcher and pickup bridge; it is
not an alias for the TypeScript executable. These fixtures are therefore an
input to migration and conformance work, not a promise that every legacy flag
will become a top-level `wayfinder` flag.

Whether `wf` becomes a temporary alias remains an explicit unresolved map
decision. Until that decision is made, installers must not replace `wf`, and
the TypeScript CLI must not advertise an alias. A future migration may map a
legacy form to a versioned `wayfinder` command only when it preserves the
fixture's safety properties or returns an explicit incompatibility.

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

The fixtures were transcribed from the canonical implementation in
`agent-skills/scripts/wfcli` and its tests as observed for JWB-293 on
2026-08-11.
