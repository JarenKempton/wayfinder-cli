# Claim, lease, reclaim, and compensation semantics

This document records the decision accepted in JWB-277. It is the behavioral
contract for later tracker adapters, pickup transactions, supervisors, and
recovery commands.

## Identity and durable truth

Tracker assignment names the human responsible for a ticket. It is not an
agent-session identifier. Each execution attempt receives a globally unique
`wayfinder-run:<uuid>` reference, and each claim receives a globally unique
`wayfinder-claim:<uuid>` reference. The retired pre-release `nav-run:*` and
`nav-claim:*` formats are invalid and have no migration guarantee.

The tracker is authoritative shared coordination state. Its claim metadata must
identify the ticket, human owner, run, claim, lease expiration, and version used
for conditional updates. The local ledger retains exact tracker snapshots,
transaction steps, receipts, errors, workspaces, and run history. Local state
alone never establishes ownership.

## Claim lifecycle

| State | Meaning | Tracker mutation caused by entering it |
| --- | --- | --- |
| `active` | The claim is current and its lease has not expired. | A verified conditional claim or reclaim. |
| `stale` | The current time is at or after the recorded lease expiration. | None; readers derive this state. |
| `released` | An authorized human explicitly returned the ticket to its pre-claim state. | Guarded exact-snapshot restoration. |
| `superseded` | An authorized human explicitly replaced a stale claim. | Guarded reclaim that names the stale claim. |

A claim defaults to a 15-minute lease. A live supervisor renews it every five
minutes. Renewal updates machine-readable metadata and is verified by reading
the tracker. Lease expiration never unassigns, releases, or reassigns a ticket.

The supervisor is a per-user runtime service protected by a heartbeat-refreshed,
fenced local lock that is released after every tick. Each run is isolated so a
missing claim, adapter error, or observation failure cannot abort later runs.
Only an active run with an active claim and a session observed as running may
renew. Claim state is derived from `leaseExpiresAt` at the final pre-renewal
check: a persisted `active` value is stale at or after expiry and requires an
explicit reclaim. Released, superseded, expired, and restart-after-downtime
claims never renew. Missing, stopped, unknown,
or unverifiable sessions become `attention_required`; they are never silently
stopped, released, or reassigned. Verified reconciliation of both the running
session and matching active claim is the explicit path back to `active`.

Before a remote renewal, the ledger persists a renewal intent. The verified
tracker version, lease, run observation, step, and intent deletion then commit
in one SQLite transaction. On restart, the supervisor verifies pending intents
against the tracker and either commits the observed renewal or requires human
attention. This closes the crash window between remote success and local state.

Reclaim requires an authenticated human who may assign the tracker ticket. It
must name the stale claim, re-read current state, and conditionally install new
claim and run identities. A version or claim mismatch is a collision, not an
invitation to retry over the concurrent change. The new claim keeps the original
pre-claim snapshot and records its predecessor, so a later release can still
return the ticket to the state that first made it frontier-eligible.

## Stop and release are different

`wayfinder stop <run>` stops execution and marks the local run stopped only
after the lifecycle adapter observes termination. It
preserves tracker assignment, claim metadata, workspace, and history. Since a
stopped run no longer renews its lease, readers eventually observe its claim as
stale.

A bare PID is never sufficient process identity because operating systems reuse
PIDs. The built-in fallback therefore never probes or signals PID-only receipts;
a lifecycle adapter must provide a verifiable session/process identity and
advertise both interrupt and status capabilities.

`wayfinder claim release <claim>` means the human is giving up ownership. It
conditionally restores the original claim-related tracker snapshot and verifies
the result. The ticket can return to the frontier only when that restored state
is open, available, unassigned, and unblocked. Workspace deletion is always a
separate explicit operation.

Run exports include the run, claim snapshot, ordered transaction steps, and
append-only recovery evidence. Recovery changes a `recovery_required` run only
after a configured verifier accepts the supplied evidence; a flag is not proof.
Failed or unavailable verification is recorded and leaves the run unchanged.

## Pickup and compensation

Pickup persists each transition before beginning the next side effect:

| From | Operation | Verified result | Failure path |
| --- | --- | --- | --- |
| `planning` | Complete tracker, workspace, and harness preflights; capture exact snapshot. | `claiming` is persisted. | No tracker mutation. |
| `claiming` | Conditionally claim using the captured version. | Read-after-write verification, then `claimed`. | A definite collision ends `collision`; any ambiguous result compensates. |
| `claimed` | Prepare the planned workspace. | `workspace_prepared`. | Compensate. |
| `workspace_prepared` | Launch the harness. | `launched`. | Compensate, including any partial launch receipt. |
| `launched` | Persist the active run and final receipt. | `committed`. | Compensate. |

Compensation first persists `compensating`. If a launch may have created a
session or process, Wayfinder attempts to stop it. Regardless of that outcome,
it conditionally restores the exact original tracker snapshot, guarded by the
claim identity, and reads the tracker back to verify restoration.

The result is `compensated` only when every relevant side effect is proven safe.
An uncertain harness stop, restoration collision, failed restoration, or failed
verification produces `recovery_required` and a
`wayfinder recover wayfinder-run:<uuid>` instruction. Automatic recovery never
overwrites a concurrent human change and never reports ambiguity as success.

## Operation transitions

| Operation | Preconditions | Success | Collision or ambiguity |
| --- | --- | --- | --- |
| Claim | Open, available, unassigned ticket; expected version; completed preflights. | New active claim and human assignment are verified. | Collision makes no compensating write; ambiguity restores or requires recovery. |
| Renew | Matching active claim and expected version. | Lease expiration advances and is verified; no comment. | Claim remains as observed; report collision or recovery evidence. |
| Stop | Identified active run. | Run becomes stopped; tracker and workspace remain intact. | An uncertain stop requires recovery attention. |
| Release | Matching claim, original snapshot, authorizing human, expected version. | Snapshot restoration is verified; claim becomes released. | Never overwrite current state; require recovery when ambiguous. |
| Reclaim | Expired lease, matching stale claim/version, authorized human. | Old claim becomes superseded; new active claim/run inherit the original snapshot. | Collision or ambiguity; never automatic takeover. |
| Recover | A recorded `recovery_required` receipt. | Human-guided verification completes the outstanding side effect. | Remain `recovery_required` with appended evidence. |

## Tracker audit trail

Claim, reclaim, release, and recovery-required boundaries receive concise,
human-readable tracker comments. Heartbeats do not. Audit comments are evidence
and are never erased during exact-state restoration; “exact” refers to the
claim-related fields and metadata captured before mutation, not rewriting the
tracker's immutable history.

### Jira live-conformance boundary

[JWB-282](https://responsibid.atlassian.net/browse/JWB-282) exercised a verified
claim and injected post-claim failure against disposable Jira map JWB-300 and
ticket JWB-301. Compensation restored and reread the original assignment,
status, and Wayfinder-owned label metadata. Jira's revision timestamp advanced,
so compensation did not—and cannot claim to—restore the pre-claim revision or
erase audit history.

The tested Jira CLI surface also required separate assignment/metadata and
status mutations. Its pre-write reread was a client-side guard, not a
server-enforced compare-and-swap spanning the whole claim. A Jira adapter must
therefore advertise verified compensation only after restoring and rereading
each owned field. It must not advertise exact rollback or conditional
multi-field claim until a site-specific capability probe proves those stronger
guarantees.

## Example

JWB-277 begins unassigned and `To Do`. Pickup captures that snapshot, assigns it
to Jaren, marks it `In Progress`, and records `wayfinder-claim:a` for
`wayfinder-run:a`. If the run is stopped, those tracker fields remain and the
claim later reads stale. An authorized human may reclaim it as
`wayfinder-claim:b` / `wayfinder-run:b`. If that work is explicitly released,
Wayfinder restores and verifies the original unassigned, `To Do` snapshot. If it
cannot prove the restoration, it stops at `recovery_required` rather than
placing the ticket back in the frontier.
