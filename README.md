# Wayfinder CLI

Wayfinder CLI is portable work orchestration for agents. It discovers unblocked work from
Wayfinder maps, lets a person select one ticket, and coordinates a deterministic
claim, workspace, and harness launch without making the tracker, model, or
harness part of the core domain.

Wayfinder CLI is designed to integrate with the map-based Wayfinder workflow popularized
by Matt Pocock. See [NOTICE.md](NOTICE.md) for attribution and project lineage.
The normative [ownership boundary](docs/ownership-boundary.md) defines what
stays in the MCP/skill layer and what belongs to this CLI runtime.
The [compatibility fixtures](docs/compatibility-fixtures.md) exercise durable
frontier ordering and pickup compensation behavior through production code.

## Status

Wayfinder CLI is a TypeScript/Bun pre-release. This repository currently defines and implements the stable
foundation: qualified references, portable ticket and capability types, frontier
evaluation, adapter protocol discovery, layered execution routing, SQLite run
state, and the initial CLI. Hosted tracker mutations and product-specific
session lifecycle adapters must pass their conformance suites before being
advertised as supported.

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
