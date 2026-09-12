# Claim and recovery semantics

[Pickup](../src/execution/pickup.ts), [lifecycle coordination](../src/execution/lifecycle.ts),
and [claim types](../src/domain/model.ts) implement these transitions.
[Claim tests](../test/claim.test.ts), [pickup tests](../test/pickup.test.ts),
and [lifecycle tests](../test/lifecycle.test.ts) exercise failure paths.

## Identity and leases

Tracker assignment names the responsible human. A run identifies one execution;
a claim binds that run, ticket, and owner to an exact pre-claim snapshot.
Local state alone never establishes ownership.

| Claim state | Meaning |
| --- | --- |
| `active` | Current claim with an unexpired lease |
| `stale` | Lease expired; derived by reading time, with no mutation |
| `released` | Explicit, verified restoration of the pre-claim fields |
| `superseded` | Explicit stale reclaim installed a successor identity |

Renewal requires a matching active claim and a session observed running.
Expiry never authorizes automatic renewal, release, or reassignment.
The supervisor checks expiry immediately before renewal, isolates failures per
run, and uses a fenced local lock. Missing or unverifiable sessions require
attention. Verified reconciliation of session and claim is the path back to active.

A renewal intent is persisted before the remote write. The verified version,
lease, observation, and intent deletion commit together locally. Restart
reconciles pending intents with the tracker instead of assuming the write failed.

Reclaim requires authorization, the stale claim identity, a fresh read, and a
conditional write. A mismatch is a collision. The successor retains the original
pre-claim snapshot and predecessor identity for later restoration and audit.

## Stop and release

Stop marks a run stopped only after verified termination. It preserves claim,
assignment, workspace, and history. PID-only receipts cannot establish ownership;
an adapter must verify the actual session or process identity.

Release explicitly returns ownership by conditionally restoring and verifying
the original claim-related fields. The ticket re-enters the frontier only if
the restored state is eligible. Workspace deletion is a separate operation.

Recovery requires a configured verifier to accept the supplied evidence.
Failed or unavailable verification is appended to history and leaves the run
unresolved. A flag or human assertion is not itself proof of the remote outcome.

## Pickup and compensation

Pickup persists each transition before beginning the next side effect:

| From | Operation | Verified result | Failure path |
| --- | --- | --- | --- |
| `planning` | Complete preflights; capture snapshot | `claiming` | No tracker mutation |
| `claiming` | Conditional claim and readback | `claimed` | Definite collision ends `collision`; ambiguous result enters compensation |
| `claimed` | Prepare workspace | `workspace_prepared` | Compensation |
| `workspace_prepared` | Launch harness | `launched` | Compensation, including a partial launch receipt |
| `launched` | Persist active run and receipt | `committed` | Compensation |

The generic coordinator persists `compensating`, attempts to stop a recorded
launch, then attempts guarded restoration and readback of the original tracker
snapshot. It attempts restoration even if stop fails. Only verified side-effect
resolution permits `compensated`; uncertain stop, restoration, or persistence
produces `recovery_required`.

That compensation behavior is unsafe for a host that may commit a launch
without returning a receipt or cannot verify stop. Such an adapter must not
be connected to generic pickup without a recovery path that retains ownership
and prevents duplicate launch. The [T3 contract](session-hosts/t3-adapter.md)
describes this boundary.

## Tracker guarantees

Restoration concerns owned fields and metadata, not the tracker's revision
counter or immutable history. A reread followed by an unconditional write is
not compare-and-swap. Neither an assignment API, timestamp, nor structured
claim property alone proves exclusive ownership.

Adapters must prove collision handling, verification, compensation, and
ambiguous-failure behavior before enabling live writes. Verification must cover
each restored field when assignment, metadata, and workflow status use separate
operations. Concurrent human changes must not be overwritten.

The generic pickup capability requirements include `claim_comments`; that is
an implementation constraint, not authority to narrate work into a tracker.
[Tracker write policy](adr/0002-tracker-write-minimalism.md) keeps ownership in
structured storage and makes resolution comments optional. Capability checks
and conformance must reflect an adapter's actual behavior.
