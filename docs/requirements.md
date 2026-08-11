# Nav requirements

## Decided scope

Nav is a local-first, MIT-licensed TypeScript CLI compiled with Bun. It will ship
standalone macOS, Linux, and Windows binaries; users do not need Bun or Node.
Common adapters are bundled; custom adapters are separate executables using the
versioned Nav Adapter Protocol.

V1 tracker targets are Jira Cloud, Linear, and GitHub Issues. A Markdown adapter
is the credential-free conformance implementation. One tracker instance owns a
workspace in v1. Dependencies may span maps and groups in that workspace;
cross-tracker dependency evaluation is deferred.

V1 harness targets are T3 Code, Pi, Claude Code, Codex, Cursor, OpenCode, and a
generic command adapter. Support is capability-tiered (`prepare`, `launch`,
`managed`, `lifecycle`) and may differ by operating system. Nav does not use UI
automation to pretend a product has a stable session API.

## Required invariants

1. Interactive pickup selects exactly one ticket from a stable frontier.
2. Noninteractive pickup requires an exact ticket or explicit selection policy.
3. All capability and workspace preflights finish before the tracker claim.
4. Human assignment and Nav run identity remain distinct.
5. Claims use a 15-minute lease and a 5-minute heartbeat by default.
6. Lease expiry never automatically unassigns or reassigns a ticket.
7. A failure after claim attempts verified restoration of the exact snapshot.
8. Ambiguous restoration produces `recovery_required`, never success.
9. `nav stop` preserves assignment, workspace, and local history.
10. Tracker mutations produce structured receipts and support dry-run planning.
11. Product Pipeline receives no Nav session telemetry in v1.
12. Secrets are referenced through credential providers and never stored in
    ordinary TOML or SQLite fields.

## Planned stable command surface

```text
nav init
nav config show|edit
nav doctor
nav resolve <ref>
nav frontier [scope] [--json]
nav pickup [ticket-or-scope] [--select policy] [--dry-run] [--json]
nav claim show|renew|release|reclaim
nav runs list|show|export
nav resume <run>
nav stop <run>
nav recover <run>
nav workspace status|archive|delete
nav supervisor status|start|stop
nav adapter list|describe|test
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
Nav will check for updates at most once per 24 hours in interactive mode and
notify rather than silently update. Homebrew installations use `brew upgrade`;
direct installations may use the future `nav update` command.
