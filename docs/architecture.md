# Architecture

Wayfinder CLI separates policy from vendor mechanics.

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
The claim transaction and recovery contract is documented in
[Claim, lease, reclaim, and compensation semantics](claim-semantics.md).

```text
tracker   <adapter>:<instance>
workspace <tracker-ref>:<workspace-id>
group     <workspace-ref>:group:<native-id>
map       <workspace-ref>:map:<native-id>
ticket    <workspace-ref>:ticket:<native-id>
run       wayfinder-run:<uuid>
claim     wayfinder-claim:<uuid>
```

References are globally qualified now so a later protocol can represent
cross-tracker links without changing identifiers. V1 rejects evaluation when
the two tickets do not share a workspace.

## Frontier

The tracker adapter returns normalized ticket and dependency inputs. Core owns
eligibility: a frontier ticket is open, in an available state, unassigned,
inside the requested scope, and has no unresolved blocker. Core preserves the
adapter's stable order. The normalized input is one complete workspace graph:
every dependency is owned by its blocked ticket and every referenced blocker
must be present, even when the requested frontier scope would filter that ticket
out of the result.

## Pickup transaction

Pickup progresses through `planning`, `claiming`, `claimed`, `workspace_prepared`,
`launched`, and `committed`. A post-claim failure enters `compensating`, then
either `compensated` after verified restoration or `recovery_required` when the
result is ambiguous. Local steps and receipts are persisted before moving to
the next state.

## Configuration and execution routing

Core resolves execution configuration in a fixed least-to-most-specific order:
harness defaults, user, repository, workspace, group, map, ticket, then CLI. Scalar
settings (`harness`, `model`, `effort`, and `context`) use the most specific non-empty
value and retain source provenance. Required capabilities accumulate across layers so a
more specific scope cannot silently weaken a lower-level requirement.

The selected harness must advertise every explicitly required capability. Model, effort,
and context requests additionally require `model_selection`, `reasoning_selection`, and
`context_selection`, respectively. These checks and adapter preflight complete before
the tracker snapshot or claim mutation.

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

## Git workspaces

The Git adapter consumes one explicit repository mapping. It injectively base64url-encodes
the ticket's tracker, instance, workspace, and native ID components into a qualified
identity, then derives the canonical `<worktreeRoot>/<qualified-identity>` path and
`wayfinder/<qualified-identity>` branch. Preparation recomputes this mapping from the
ticket reference and rejects caller-altered plans before any Git operation.

Preparation resumes only an already-registered exact path/branch pair. An occupied path,
branch checked out elsewhere, detached or ambiguous worktree, or mismatched repository
mapping fails closed. SSH URL, HTTPS URL, and scp-style remotes normalize to a shared
host/path identity; other URL schemes are unsupported. Resume preserves dirty work.
Deletion requires the exact prepared-workspace record, verifies the canonical real path
under the configured root and unambiguous Git registration, and refuses dirty work. Git
is always invoked with an argument array so native paths, including paths containing
spaces, are not shell-interpreted.

## Capability honesty

Adapters advertise fine-grained capabilities. Core derives presentation tiers
but checks individual capabilities before every operation. A missing feature is
an explicit unsupported error, never an inferred success.
