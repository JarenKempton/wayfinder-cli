# T3 adapter — JWB-489

This is an incomplete adapter foundation for the API documented in the merged
[T3 source/evidence record](t3-code.md), on top of main containing PR #38.
The selected behavior comes from the coordinating September 9 direction and
first-release acceptance records: reconnect reads the recorded session without
sending a message; missing/unreachable sessions require explicit recovery;
stop verifies the provider outcome and preserves workspace and claim.

`src/t3-adapter.ts` implements structured project registration, bootstrap,
snapshot inspection, reconnect, explicit follow-up, a low-level session-stop request,
and an observation-only `RunLifecycleAdapter` bridge. Verified termination is blocked
by T3's currently known evidence limits, documented below. `src/platform/t3.ts` owns local runtime
discovery, HTTP, and Bun credential subprocesses. No public protocol or generic
runtime abstraction changes, lane store, daemon, or tracker mutations are added.
The copied handler MOVE rules and absent `docs/action-layer-plan.md` do not apply
to this repository, as clarified by the coordinating user. Merging this foundation
does not complete JWB-489 or the first-release milestone. The remaining engineering
work is verified termination, safe pickup recovery, and CLI pickup/inspect/reconnect composition.

## Behavior and evidence

- Receipts bind `environmentId` plus `threadId`, project,
  repository/worktree paths, branch, runtime/interaction modes, and exact provider
  **instance**/model/options. A branch match never authorizes adoption of a thread.
  Duplicate, partial, deleted, malformed, or mismatched identities fail closed.
- `serverVersion` is recorded evidence, not a compatibility gate. A server update
  does not prevent reconnect to the same environment/thread. Each response still
  must satisfy the adapter's consumed wire contract; unknown or contradictory state
  remains unknown. Reconnect observations and command evidence record the current
  reported version; original receipts retain their creation version. Bootstrap records
  the actual version observed at dispatch. Version changes never enable stop capability.
- Explicit model selection is mandatory. The adapter preserves reported options;
  it accepts neither omitted requested options nor extra/conflicting options as
  verified. It does not alias provider instances to driver names or substitute models.
- Bootstrap accepts caller-resolved project/thread IDs and a prepared workspace.
  If necessary it registers that project with `createWorkspaceRootIfMissing: false`.
  Registration must settle before the single bootstrap turn dispatch. Workspace
  preparation remains the caller's responsibility; this adapter creates no files.
- Every dispatch awaits a durable journal write with the receipt, original command
  ID/type/target, and a SHA-256 digest of the exact intent. Prompts and credentials
  are excluded. A lost/invalid acknowledgement records that same evidence and
  does not dispatch again. There is no replay API: recovery uses observations and
  the original evidence, not a reconstructed command with a new ID.
- The old Python broad Nightly fallback, npx installation fallback, and deletion
  compensation are deliberately excluded. Only a missing primary runtime file permits
  discovery to try `dev`; unreadable or invalid files fail without switching environments.
  The `version: 1` discovery-file format is still validated; it is not a software-version pin.
  Development auth is
  explicitly unqualified, so the adapter stops before issuing credentials there.
- Inspection/reconnect fetch the snapshot, select only the intended identity, and
  expose state metadata. Reconnect opens the recorded session in the read model;
  it does not activate a desktop pane. It dispatches no message or turn. An absent
  or unreachable recorded thread never triggers bootstrap/replacement.
- `latestTurn: completed` plus `session: ready` is reported with those exact fields.
  The existing portable observation enum has no idle state, so its `state` remains
  `unknown` with detail `turn_finished`. This is not stopped, accepted work, or Jira
  Done. Contradictory state, unknown enums, missing instance readback, or provider
  errors require recovery. Snapshot timestamps are not agent heartbeats.
- Explicit `stopSession` requests `thread.session.stop` for the scoped thread and
  reads subsequent state. It always rejects with `stop_unverified` after dispatch
  and journals `t3_stop_unknown`: this build supplies no verified termination outcome.
  Even `session.status: stopped`, null active turn/error, and an interrupted latest
  turn remain `state: unknown`, `recoveryRequired: true`, detail `termination_unverified`.
  An already-stopped projection is recorded as unknown without another dispatch.
  Lost acknowledgements retain their original command evidence without retry.
  Managed lifecycle stop is disabled before dispatch, including direct bridge calls.
- Follow-up is explicit, requires a ready session, and observes a different turn
  after acknowledgement. That is host-state evidence, not proof of prompt compliance
  or work completion. Concurrent external writers are not fenced by this API.
- Polls are bounded to 50 attempts with a five-second scheduling window and a
  30-second per-request timeout. An in-flight request can extend the window.
  Incomplete readback remains uncertain. Snapshot sequence watermarks fence
  post-dispatch observations; unrelated sequence advances never prove stop.

The adapter's implemented capability set is `process_launch`, `session_create`,
and `session_status`. `describe()` first verifies the local
runtime and an authenticated snapshot. These are fake-conformance-qualified API
operations; live lifecycle acceptance is pending. No `session_interrupt` is advertised:
the adapter cannot verify termination. No `visible_multi_session`,
`session_resume`, or `session_close` is advertised: UI activation, provider resume,
and deletion have not been qualified. The synchronous command registry marks T3
bundled but unavailable and advertises no runtime capabilities from executable lookup.

## Termination evidence blocker

The inspected `0.0.41-nightly.20260909.1426` T3 source can produce the entire formerly accepted stop snapshot
before provider cleanup completes, and can hide a failed cleanup. Locators below refer
to embedded source in the same source map recorded in [JWB-488](t3-code.md#evidence-and-reproducibility)
(SHA-256 `3eca191f249234f5429f63e897ed70d20cf3608691820f2478688af8d1b2dab7`):

| Source under `apps/server/src/` | Evidence |
| --- | --- |
| `provider/Layers/CodexSessionRuntime.ts:2307–2316` | Sets closed state and emits `session/closed` before `Scope.close(runtimeScope, ...)`. |
| `provider/Layers/CodexAdapter.ts:1476–1483` | Maps the notification to `session.exited`. |
| `orchestration/Layers/ProviderRuntimeIngestion.ts:1573–1607` | Projects stopped, clears active turn, and preserves the existing null error. |
| `orchestration/Layers/ProjectionPipeline.ts:91–93,1311–1347` | Maps stopped to interrupted and updates running turns, satisfying the remaining snapshot predicate. |
| `provider/Layers/CodexAdapter.ts:2669–2673` | Removes the session before cleanup and ignores errors from runtime/scope close. |

For example, a Codex provider still closing (or whose close failed) is indistinguishable
from successful termination in this HTTP snapshot. More polling, a higher sequence,
or an absent provider session in a list does not establish a termination barrier.
There is no adapter-owned process handle to verify separately. The adapter therefore
withholds `session_interrupt` for this build instead of inventing proof. A supported
termination barrier tied to the scoped session, including failure reporting, must be
qualified before managed stop can be enabled. No upstream/server change is made here.

This source version identifies the evidence; it is not an allowlist in the adapter.
Wire-shape validation alone cannot qualify changed termination semantics in another build.

Regression cases model pending, failed, and completed cleanup with identical wire
snapshots. All remain unknown; inspection, reconnect, and low-level stop emit no
`t3_stop_verified` receipt. Lifecycle capability preflight refuses stop without changing
the active run, workspace, or claim. This replaces the earlier false verified-stop claim.

## Persistence and concrete composition blockers

The mandatory journal callback binds directly to the existing ledger:

```ts
const host = new T3Adapter({
  journal: async (state, evidence) => ledger.recordStep(run.ref, state, evidence),
});
```

Persist the `T3Receipt` unchanged as `run.execution`; existing `execution_json`
preserves its adapter-owned fields without a schema migration. A prepared journal
entry already contains the receipt before a dispatch can become uncertain. Bind
one adapter/journal to its run; do not route evidence for different runs through
the same bound callback. `host.lifecycle()` supplies observation to `LifecycleCoordinator`;
stop fails capability preflight without dispatch because termination cannot be verified.
The bridge maps a missing T3 session to portable `unknown`, because the existing
coordinator otherwise treats `missing` as verified stopped. Fake tests use the
real SQLite store and an actual temporary workspace to verify claim/file retention.

**Pickup is deliberately not wired.** For example, if `thread.turn.start` commits
but its HTTP response times out, `PickupCoordinator.#compensate` currently calls
`harness.stop(receipt)` and then `tracker.restoreClaimState(...)`. A missing launch
receipt still causes tracker restoration. Both violate the selected preservation
behavior. That coordinator needs an explicit noncompensating recovery outcome and
durable pending-operation reconciliation before it can safely compose this host.
It also needs to enforce one writer and reject another pickup while the original
operation is pending; this adapter supplies evidence, not a second coordination store.

Existing `LaunchRequest` only has generic model/effort fields and cannot represent
an exact provider instance plus arbitrary typed options. Structured T3 input is
therefore kept at this adapter boundary, without forcing it through argv or taking
a dependency on unmerged PR #32. CLI pickup/reconnect composition, ticket-oriented
inspection, and desktop pane activation remain work for that composition. The
adapter methods and lifecycle bridge are implemented and tested here.

## Verification

The connection sequence is intentionally small: `discoverLocalServer` reads the
runtime file, `readEnvironment` checks the discovered server's identity, and
`issueCredential` obtains a temporary credential. `connectT3` puts those steps in
order and returns the connection; `close` revokes its credential. Identity is checked
before a credential is issued. The named helpers remain local to the T3 platform module.

The auth argument array represents **one** command, `t3 auth session issue`, followed
by its flags. It is not a list of commands or an acceptance-test chain. The small
`runCommand` wrapper uses `Bun.spawn` with argv, captures secret stdout only in memory,
and bounds execution time. Requests otherwise use the standard Fetch and URL APIs;
there is no custom HTTP protocol implementation or retry framework. The transport
allows only descriptor GET, snapshot GET, and dispatch POST. Method/path mismatches,
path traversal, and unexpected queries are rejected before sending credentials.

The tests were written before implementation. `test/fixtures/t3-snapshot.json` is
a minimal sanitized projection of the JWB-488 recorded snapshot at sequence 3421.
Identity/path/turn identifiers are replaced with fixture values; exact observed
model/options and completed/ready state are retained. Required identity/session
fields use the installed schema. It is not a raw snapshot and contains no conversation
text, titles, provider errors, or credentials. Tests explicitly vary that recording
to model committed-but-unacknowledged commands, projection delays, collisions,
malformed fields, provider failures, early closed notifications, failed cleanup,
and stop/reconnect transitions.

Run:

```sh
bun test
bun run typecheck
bun run check
bun run src/cli.ts adapter test t3 --read-only
```

The read-only command issues a two-minute credential in memory, performs descriptor
and snapshot GETs, and revokes the credential in `finally`. It rejects nonliteral
loopback HTTP origins and redirects, binds expected environment identity before auth
for recorded sessions, ignores raw HTTP/subprocess error bodies, and reports revocation
failure. It neither dumps snapshots nor logs tokens. Discovery/auth/snapshot/revocation
passed against environment `ba2e9684-35d3-4155-8c13-327fc80aec8e`, version
`0.0.41-nightly.20260909.1426`. No live lifecycle commands were sent.

`bun run src/cli.ts adapter test t3` fails closed with the termination-blocker and
pending-approval explanation.
It cannot accidentally pass T3 to the external tracker JSON-lines protocol tester.
Full repository check output is pasted in the draft PR.

## Exact proposed live acceptance packet — pending, not executed

**Blocked on qualified termination evidence as well as separate authorization.**
Do not execute this lifecycle packet until a stronger termination barrier has been
implemented/tested and the exact evidence check added to step 5 for review. A successful
snapshot-only live run cannot qualify verified stop. The resource IDs and prompts below
remain reserved proposal values; no lifecycle step has been executed.

This proposal requires separate disposable-session authorization. It is not a request
to change existing sessions or the server. Freeze the reviewed PR commit as `HEAD`
before executing the packet; if the environment identity differs, stop for review.
Record the server's actual version with the resulting evidence.

1. Prepare one temporary worktree from that commit at
   `/tmp/wayfinder-JWB-489-acceptance-b713cd89`, branch
   `acceptance/JWB-489-b713cd89`. Use this path as both T3 `workspaceRoot` and
   `worktreePath`. No project setup script. Create a local sentinel and SQLite run
   with a fake tracker claim, so workspace and ownership retention can be checked
   without a Jira mutation.
2. Bind the environment above and record the actual server version. Use project ID
   `b713cd89-8bf2-4851-9a5b-0e781eb6f200` and thread ID
   `b713cd89-8bf2-4851-9a5b-0e781eb6f201`; abort on any existing identity/path match.
   Title: `Wayfinder JWB-489 disposable acceptance`. Exact selection:
   `{"instanceId":"codex","model":"gpt-6-astra","options":[{"id":"reasoningEffort","value":"high"}]}`.
   Runtime mode `full-access`, interaction mode `default`.
3. Invoke `bootstrap` once, allowing only the necessary `project.create` and one
   `thread.turn.start` with `runSetupScript: false`. Exact prompt:
   `Reply exactly T3_ACCEPTANCE_READY. Do not use tools, edit files, or access the network.`
   Persist command identity before dispatch. Verify environment/thread, model/options,
   and turn/session readback. Any uncertainty ends mutations and preserves resources.
4. Construct a fresh adapter and reconnect to the saved receipt. Verify its current
   state and that no POST occurred. This proves read reconnection across an adapter
   restart; it does not restart T3 or claim desktop visibility.
5. After observing ready, send exactly one explicit follow-up:
   `Use the shell tool to run sleep 120 in the current directory. Do not edit files or access the network. After it finishes, reply T3_ACCEPTANCE_WAIT_FINISHED.`
   Verify the new running turn. Invoke `stopSession` once while that turn is running;
   require the newly qualified termination barrier, not just the stopped snapshot.
   This check is currently unavailable, so the packet cannot proceed. If it ends too quickly, mark the
   active-stop case unverified; do not send another turn without revised approval.
6. Verify the sentinel, worktree, fake claim ownership, thread history, and saved
   receipt remain. Revoke every auth credential. Preserve the disposable thread and
   worktree for review. No Jira writes, release, merge, notifications, or server changes.

Deletion/cleanup is a **separate** explicit operation after verified stop and review;
this packet does not authorize `thread.delete`, project deletion, or worktree removal.
That supersedes the ticket's older delete-as-interrupt suggestion. This PR remains
draft, live lifecycle acceptance remains pending, and only Jaren's merge can complete
the ticket. The coordinator owns Jira evidence/comments/transitions and the eventual
single map context pointer; this implementation session makes none of those writes.
