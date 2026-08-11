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
