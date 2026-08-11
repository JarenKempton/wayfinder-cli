# Architecture

Nav separates policy from vendor mechanics.

The ownership boundary between the shared Wayfinder MCP/skill experience and
this portable runtime is normative and documented in
[`ownership-boundary.md`](ownership-boundary.md).

```text
CLI
 ├── resolver and configuration
 ├── frontier engine
 ├── pickup transaction coordinator
 ├── local SQLite ledger and supervisor
 └── adapter registry
      ├── tracker adapters
      ├── workspace adapters
      ├── environment adapters
      └── harness adapters
```

## Qualified references

The accepted entity and identifier contract is documented in
[Portable domain model and capability vocabulary](domain-model.md).

```text
tracker   <adapter>:<instance>
workspace <tracker-ref>:<workspace-id>
group     <workspace-ref>:group:<native-id>
map       <workspace-ref>:map:<native-id>
ticket    <workspace-ref>:ticket:<native-id>
run       nav-run:<uuid>
claim     nav-claim:<uuid>
```

References are globally qualified now so a later protocol can represent
cross-tracker links without changing identifiers. V1 rejects evaluation when
the two tickets do not share a workspace.

## Frontier

The tracker adapter returns normalized ticket and dependency inputs. Core owns
eligibility: a frontier ticket is open, in an available state, unassigned,
inside the requested scope, and has no unresolved blocker. Core preserves the
adapter's stable order.

## Pickup transaction

Pickup progresses through `planning`, `claimed`, `workspace_prepared`,
`launched`, and `committed`. A post-claim failure enters `compensating`, then
either `compensated` after verified restoration or `recovery_required` when the
result is ambiguous. Local steps and receipts are persisted before moving to
the next state.

## Persistence

The per-user SQLite database enables WAL and foreign keys. It records runs,
claims, transaction steps, tracker snapshots, workspaces, adapter capabilities,
receipts, and errors. JSON export is an inspection format, not a coordination
store.

## Runtime boundary

Portable entities, frontier rules, routing, and transaction coordination are
ordinary TypeScript. Bun-specific filesystem, subprocess, SQLite, executable
build, and update behavior remains isolated in platform-facing modules. Release
binaries embed Bun, so consumers install a single executable without a runtime.

Application development lifecycle behavior crosses the separate environment
adapter boundary defined in [Development environment boundary](environment-boundary.md).

## Capability honesty

Adapters advertise fine-grained capabilities. Core derives presentation tiers
but checks individual capabilities before every operation. A missing feature is
an explicit unsupported error, never an inferred success.
