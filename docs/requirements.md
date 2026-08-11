# Wayfinder CLI requirements

## Decided scope

Wayfinder CLI is a local-first, MIT-licensed TypeScript CLI compiled with Bun. It will ship
standalone macOS, Linux, and Windows binaries; users do not need Bun or Node.
Common adapters are bundled; custom adapters are separate executables using the
versioned Wayfinder Adapter Protocol.

V1 tracker targets are Jira Cloud, Linear, and GitHub Issues. A Markdown adapter
is the credential-free conformance implementation. One tracker instance owns a
workspace in v1. Dependencies may span maps and groups in that workspace;
cross-tracker dependency evaluation is deferred.

V1 harness targets are T3 Code, Pi, Claude Code, Codex, Cursor, OpenCode, and a
generic command adapter. Support is capability-tiered (`prepare`, `launch`,
`managed`, `lifecycle`) and may differ by operating system. Wayfinder CLI does not use UI
automation to pretend a product has a stable session API.

## Required invariants

1. Interactive pickup selects exactly one ticket from a stable frontier.
2. Noninteractive pickup requires an exact ticket or explicit selection policy.
3. All capability and workspace preflights finish before the tracker claim.
4. Human assignment and Wayfinder run identity remain distinct.
5. Claims use a 15-minute lease and a 5-minute heartbeat by default.
6. Lease expiry never automatically unassigns or reassigns a ticket.
7. A failure after claim attempts verified restoration of the exact snapshot.
8. Ambiguous restoration produces `recovery_required`, never success.
9. `wayfinder stop` preserves assignment, workspace, and local history.
10. Tracker mutations produce structured receipts and support dry-run planning.
11. Product Pipeline receives no Wayfinder CLI session telemetry in v1.
12. Secrets are referenced through credential providers and never stored in
    ordinary TOML or SQLite fields.

## Planned stable command surface

```text
wayfinder init
wayfinder config show|edit
wayfinder doctor
wayfinder resolve <ref>
wayfinder frontier [scope] [--json]
wayfinder pickup [ticket-or-scope] [--select policy] [--dry-run] [--json]
wayfinder claim show|renew|release|reclaim
wayfinder runs list|show|export
wayfinder resume <run>
wayfinder stop <run>
wayfinder recover <run>
wayfinder workspace status|archive|delete
wayfinder supervisor status|start|stop
wayfinder adapter list|describe|test
```

Commands remain unavailable until their safety contract is implemented. This
document is a requirements baseline, not a claim that every command ships now.

## Explicitly deferred

- Cross-tracker dependency graphs.
- Heuristic model/cost routing.
- Product Pipeline execution telemetry.
- Automatic stale-claim reassignment.
- Desktop UI automation as a lifecycle integration.
- Any behavior not listed in this document or the architecture contract.

## Distribution and updates

GitHub Releases are the canonical binary source. A public Homebrew tap provides
the primary macOS/Linux install path, with checksum-verifying shell and
PowerShell installers as fallbacks. GitHub Packages and npm are not required.
Wayfinder CLI will check for updates at most once per 24 hours in interactive mode and
notify rather than silently update. Homebrew installations use `brew upgrade`;
direct installations may use the future `wayfinder update` command.
