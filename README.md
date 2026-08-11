# Wayfinder CLI

Wayfinder CLI is portable work orchestration for agents. It discovers unblocked work from
Wayfinder maps, lets a person select one ticket, and coordinates a deterministic
claim, workspace, and harness launch without making the tracker, model, or
harness part of the core domain.

Wayfinder CLI is designed to integrate with the map-based Wayfinder workflow popularized
by Matt Pocock. See [NOTICE.md](NOTICE.md) for attribution and project lineage.
The normative [ownership boundary](docs/ownership-boundary.md) defines what
stays in the MCP/skill layer and what belongs to this CLI runtime.

## Status

Wayfinder CLI is a TypeScript/Bun pre-release. This repository currently defines and implements the stable
foundation: qualified references, portable ticket and capability types, frontier
evaluation, adapter protocol discovery, layered execution routing, SQLite run
state, and the initial CLI. Bundled Linear and GitHub Issues adapters normalize
native map children and blockers, exhaust provider pagination, and use guarded,
read-after-write assignment and restoration. Product-specific session lifecycle
adapters must pass their conformance suites before being advertised as supported.

## Tracker credentials

The Linear adapter accepts a scoped API token and the GitHub adapter accepts a
token with repository Issues access. Tokens are passed in request headers and
are never placed in process arguments or logs. The registry leaves both adapters
unavailable until credential validation and CLI composition are proven; merely
setting an environment variable does not advertise a usable adapter.

Both adapters intentionally omit `conditional_update`, `atomic_assignment`, and
`lease_metadata` from their advertised capabilities. Their public assignment APIs
do not provide a verified compare-and-swap or native expiring lease. Assignment is
therefore guarded by a pre-write read, verified by an authoritative reread, and
restored only while the adapter-owned assignee is still present; a concurrent
owner is reported as a collision and is never overwritten.

## Develop from source

```sh
bun install
bun run src/cli.ts doctor
```

## Commands

```text
wayfinder doctor
wayfinder resolve <reference>
wayfinder frontier --input tickets.json [--scope <reference>] [--json]
wayfinder adapter list
wayfinder adapter describe <name>
wayfinder adapter test <executable>
wayfinder adapter conformance <fixture>
wayfinder runs list
wayfinder runs show <run-id>
wayfinder runs export <run-id>
```

The planned pickup, claim, supervisor, workspace, and recovery commands are
documented in [docs/requirements.md](docs/requirements.md). Commands that could
mutate a tracker are not exposed until their atomicity and compensation paths
are implemented and tested.

## Principles

- The tracker is the durable source of execution truth.
- A human owns a claim; a Wayfinder run identifies the executing session.
- Frontier discovery is read-only and stable.
- Claims happen only after every local and remote preflight succeeds.
- Unsupported capabilities fail explicitly.
- Stale leases never silently reassign work.
- Product-planning systems may read tracker progress but are not required for
  pickup or execution.

## Development

```sh
bun test
bun run typecheck
bun run check
bun run build
```

Wayfinder CLI is licensed under the [MIT License](LICENSE).
