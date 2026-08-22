# Compatibility fixtures

JWB-293 records repository-owned scenarios for two production behaviors:

- `evaluateFrontier` filters and orders open, unassigned, unblocked tickets;
- `PickupCoordinator` claims for a human owner, prepares a workspace, launches
  through a harness, and compensates the exact tracker snapshot after failure.

The machine-readable inputs and expected outcomes live in
`test/fixtures/compatibility/`. Tests feed those inputs through the production
frontier evaluator and pickup coordinator. The fixtures contain no dependency
on a particular tracker, workspace provider, harness, command-line client, or
session product.

The legacy golden additionally freezes these historical command forms and
their Python receipt contract:

- `wf frontier JWB-232 --json`;
- `wf pickup JWB-233 --t3`;
- `wf pickup JWB-232 --frontier --t3`;
- `wf pickup JWB-233 --dry-run --json`.

The test parses every legacy flag combination, asserts the JSON receipt keys,
checks deterministic `task/JWB-233` and `<worktree-root>/JWB-233` identity, and
normalizes the Python frontier golden through production `evaluateFrontier`.
This is offline parity data, not a runtime dependency on the historical Python
implementation.

## Covered contract

1. Frontier evaluation is read-only, honors map scope, excludes assigned,
   closed, unavailable, and blocked tickets, and returns stable production
   ordering.
2. Pickup records the human owner and tracker version in the claim request and
   creates the default 15-minute lease.
3. The workspace adapter owns branch and path planning; the coordinator passes
   the resulting plan through preparation and launch.
4. A definite claim collision ends in `collision` without compensation.
5. An ambiguous claim result, workspace preparation failure, or harness launch
   failure attempts exact-snapshot compensation. Successful restoration and
   verification ends in `compensated`.
6. Ambiguous or unverifiable restoration ends in `recovery_required`.

Lease renewal, explicit release, and human-authorized stale reclaim are outside
these pickup fixtures because they are separate production contracts. Their
human ownership, expected-version, original-snapshot, and authorization
requirements are exercised in `test/claim.test.ts`.

## Live boundary

The read-only legacy frontier command was attempted on 2026-08-11 and returned
the captured `map_config_missing` receipt because JWB-232 is no longer present
in the machine-local map configuration. Live pickup was not executed: it would
claim tracker work, create or reuse a worktree, and start a harness session.
Those effects require an explicitly configured disposable tracker/repository
and credentials. Until such a target is provided, command parsing, success
receipt shape, deterministic identity, and Python-to-TypeScript normalization
remain deterministic offline goldens; live mutation parity is intentionally
unproven.

JWB-295 closes this boundary against the credential-free Markdown reference
tracker as the disposable target. See `docs/disposable-tracker-acceptance.md`
and `test/disposable-tracker-acceptance.test.ts`, which drive the production
pickup, supervision, lifecycle, and generic-harness paths through live tracker
mutation without external services.
