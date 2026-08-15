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
frontier ordering and pickup compensation through production code, plus an
offline golden for the historical command and receipt surface.

## Status

Wayfinder CLI is a TypeScript/Bun pre-release. This repository currently defines and implements the stable
foundation: qualified references, portable ticket and capability types, frontier
evaluation, adapter protocol discovery, layered execution routing, SQLite run,
claim, lease, observation, and recovery state, and the lifecycle CLI. Bundled
Linear and GitHub Issues adapters normalize
native map children and blockers and exhaust provider pagination. Their hosted
assignment APIs do not satisfy mutating pickup's capability gate, so they remain
read-only in pickup coordination. Product-specific session lifecycle adapters
must pass their conformance suites before being advertised as supported. The
[command harness adapters](docs/harness-adapters.md) provide only executable-qualified
prepare/launch integration; their documented richer session protocols are not yet claimed.

## Tracker credentials

The Linear adapter accepts a scoped API token and the GitHub adapter accepts a
token with repository Issues access. Tokens are passed in request headers and
are never placed in process arguments or logs. The registry leaves both adapters
unavailable until credential validation and CLI composition are proven; merely
setting an environment variable does not advertise a usable adapter.

Both adapters intentionally omit `conditional_update`, `atomic_assignment`, and
`lease_metadata` from their advertised capabilities. Their public assignment APIs
do not provide a verified compare-and-swap, durable claim identity, or native
expiring lease. Mutating pickup requires all of those capabilities and fails
before snapshot or mutation when they are absent. Direct compensation helpers
retain the persisted claimed-owner guard and never overwrite a concurrent owner.

The GitHub adapter uses the documented REST API version `2026-03-10`, pins
authenticated pagination to the configured API origin, and rejects
cross-repository sub-issues or blockers at the v1 workspace boundary.

## Develop from source

```sh
bun install
bun run src/cli.ts doctor
```

## Install a prerelease

GitHub Releases contain checksum-listed standalone binaries for macOS, Linux, and Windows,
along with an SPDX SBOM, build provenance, shell completions, and a man page. To install a
specific prerelease without Bun or Node:

```sh
WAYFINDER_VERSION=0.1.0-beta.1 sh scripts/install.sh
```

```powershell
.\scripts\install.ps1 -Version 0.1.0-beta.1
```

The installers verify the selected binary against the release checksum before installing it.
Interactive release builds check for a newer release at most once every 24 hours and print a
notification only; set `WAYFINDER_NO_UPDATE_CHECK=1` to opt out.

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
wayfinder claim show <claim-id>
wayfinder supervisor status
```

The standalone binary advertises only those local/read commands because it does
not yet compose a mutating tracker adapter, managed lifecycle adapter, or
recovery verifier. A host that explicitly injects conforming runtime services
also exposes `claim release`, `stop`, `recover`, `supervisor tick`, and
`supervisor reconcile`; invoking those commands without the required service
fails before opening or mutating the local store.

Bare PIDs are explicitly insufficient process identity and the standalone
fallback advertises no observe/stop capability. Claim release requires both an
authorizing actor and a tracker adapter capable of guarded mutation plus
read-after-write verification. The bundled hosted tracker adapters remain
read-only for pickup unless their advertised capabilities prove the stronger
mutation contract.

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
