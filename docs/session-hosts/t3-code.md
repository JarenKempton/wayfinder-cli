# T3 Code local orchestration API — JWB-488

Evidence date: 2026-09-09. Installed CLI, package metadata, and running server
descriptor all report **`0.0.41-nightly.20260909.1426`**, on Linux x64.
Authenticated reads were captured at `2026-09-10T00:53:07.602614+00:00`
(2026-09-09 in America/Phoenix).

T3 has an addressable local orchestration HTTP API. This supersedes the
“no session-control API” interpretation of the T3 findings in
[JWB-278 research](../research/JWB-278-session-surfaces.md). It does **not**
establish a stable cross-version third-party API or a qualified Wayfinder host
adapter. The coordinator's JWB-278 supersession comment linking this document
is **pending**; this task makes no Jira changes.

[ADR 0001](../adr/0001-lanes-environments-and-session-hosts.md) separates host,
agent runtime, environment, workspace, and durable lane coordination. The local
`wayfinder-cli-direction/docs/direction-2026-09-09.md` direction record preserves
that separation and leaves host qualification and workflow design unresolved.
Neither record is proof of an implemented adapter. This document describes T3's
existing surface; it introduces no Wayfinder protocol or configuration schema.

## Evidence and reproducibility

Three evidence levels are used below:

- **Live read:** local runtime file, unauthenticated descriptor, authenticated
  snapshot and JWB-534 detail reads, and HTTP access checks against the running
  server. No orchestration dispatch was sent.
- **Installed source:** contracts and implementation recovered in memory from
  the installed package's source map. These specify this build's behavior,
  without establishing a vendor compatibility promise or exercising mutations.
- **Historical receipt:** the existing JWB-534 Wayfinder manifest. It records a
  successful earlier launch and model readback, without a dispatch transcript.

Verification record for this task:

| Check | Result |
| --- | --- |
| `t3 --version` | `t3 v0.0.41-nightly.20260909.1426` |
| Installed `package.json` version | `0.0.41-nightly.20260909.1426` |
| Runtime discovery + descriptor GET through `T3Client.runtime()` | Success; descriptor `serverVersion` matches installed CLI/package |
| Snapshot GET through `_request()` without credentials | HTTP 401 |
| Auth issuance through `T3Client._session()` | Success; two-minute credential captured only in memory |
| Authenticated snapshot and `threads/:threadId?turnLimit=1` GETs through `_request()` | Success; both sequences 3421; manifest thread, branch, worktree, model, and options matched |
| Credential revocation | CLI exit 0; subsequent snapshot GET with the revoked credential returned HTTP 401 |
| Dispatch, interruption, deletion, restart, reconnect | Not performed; installed-source evidence only, with the historical launch receipt below |

Source locators (line numbers refer to embedded original source, not the bundle):

| Evidence | Exact locator |
| --- | --- |
| Installed T3 package | `~/.t3/runtime/versions/0.0.41-nightly.20260909.1426/node_modules/t3/` |
| Source map | `dist/bin.mjs.map`; SHA-256 `3eca191f249234f5429f63e897ed70d20cf3608691820f2478688af8d1b2dab7` |
| Discovery and environment identity | `apps/server/src/serverRuntimeState.ts`, `apps/server/src/environment/ServerEnvironment.ts`; `packages/contracts/src/execution/environment.ts` |
| HTTP routes, scopes, errors | `packages/contracts/src/environmentHttp.ts`; `apps/server/src/orchestration/http.ts` |
| Commands and response schemas | `packages/contracts/src/orchestration.ts`: `ModelSelection` (67–126), session/turn/thread/read model (512–672), detail snapshot and create/delete (876–941), turn start/interrupt (1069–1141), `DispatchResult` (1909–1912); `packages/contracts/src/model.ts` (`ProviderOptionSelection`, `ProviderOptionSelections`) |
| Authentication | `apps/server/src/cli/auth.ts` (`sessionIssueCommand`), `cliAuthFormat.ts` (`formatIssuedSession`), `auth/EnvironmentAuth.ts` |
| Commit and asynchronous effects | `apps/server/src/orchestration/Layers/OrchestrationEngine.ts` (`processEnvelope`), `ProviderCommandReactor.ts`, `ThreadDeletionReactor.ts`; `orchestration/decider.ts` |
| Projection and restart recovery | `apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts` (`getCommandReadModel`, `getThreadDetailSnapshot`); `apps/server/src/serverRuntimeStartup.ts` (`reconcileProviderSessions`) |
| Existing Python transport | `/home/jaren/Development/agent-skills-wf-linux/scripts/wfcli/t3.py`, with `catalog.py` and `manifest.py`, inspected at Git commit `57a2eeec057ebea5132f475e77d778f502a773ad` (these files clean) |
| Earlier launch | `/home/jaren/Development/responsibid/business-metrics/.git/wf/pickups/JWB-534.json` (read only; session untouched) |

The package names its upstream repository as `https://github.com/pingdotgg/t3code`
and directory as `apps/server`; it has no `gitHead` field. An upstream `main`
page is therefore not a substitute for this installed version and source hash.
In the source map, `../src/…` resolves under `apps/server/`, and
`../../../packages/contracts/src/…` under `packages/contracts/`.

To reproduce source inspection without executing the T3 server or writing files:

```sh
t3 --version
t3 auth session issue --help
python - <<'PY'
import hashlib, json, pathlib, shutil
bundle = pathlib.Path(shutil.which("t3")).resolve().parent
source_map = bundle / "bin.mjs.map"
raw = source_map.read_bytes()
print("source-map SHA-256:", hashlib.sha256(raw).hexdigest())
data = json.loads(raw)
for name, source in zip(data["sources"], data["sourcesContent"]):
    if name == "../../../packages/contracts/src/orchestration.ts":
        print(source)
PY
```

This assumes the executable resolves to the packaged `dist/bin.mjs`, as on the
inspected machine. It prints installed code only, not runtime data or credentials.

## Runtime discovery and authentication

`T3Client.runtime()` reads `~/.t3/userdata/server-runtime.json`, then tries
`~/.t3/dev/server-runtime.json` if discovery fails. It probes the file's `origin`
with `GET /.well-known/t3/environment` and merges the descriptor into its result.
The runtime file schema is:

```ts
{ version: 1, pid: number, host?: string, port: number,
  origin: string, devUrl?: string, startedAt: string }
```

`version: 1` versions the discovery file, **not** the server software or HTTP
protocol. Observed origin was `http://127.0.0.1:3773`; do not hardcode the port.
The descriptor is unauthenticated and supplies `environmentId`, `label`,
`platform: { os, arch, machine? }`, `serverVersion`, and `capabilities`.
Live discovery returned Linux/x64 and the version above. The descriptor reports
`threadRestartContinuation: true` and `serverUpdateThreadContinuation: true`;
these flags do not prove successful recovery of any particular thread.

The existing transport runs this **argument array**, capturing stdout in memory:

```text
["t3", "auth", "session", "issue", "--json", "--ttl", "2m",
 "--label", "wfcli", "--subject", "wfcli", "--base-dir", "<T3 home>"]
```

The CLI JSON output schema contains `sessionId`, `token`, `method`, `scopes`,
`subject`, `client`, and `expiresAt`. The formatter emits
`method: "bearer-access-token"`. The inspected CLI grants
`AuthAdministrativeScopes`; its flags do not include a read-only scope selector.
The two-minute TTL is the Python transport's choice, not the server default.

`_request()` puts the token only in `Authorization: Bearer …`, uses JSON bodies
with `Content-Type: application/json`, and sets a 30-second HTTP timeout.
It decodes JSON responses. `_revoke(sessionId)` runs
`["t3", "auth", "session", "revoke", sessionId, "--base-dir", "<T3 home>"]`
in `finally`. The revocation argument is a credential record ID, not its token.
Auth issuance/revocation changes credential state, even when all HTTP requests
are GETs. An auth session is distinct from an agent conversation/thread.

Do not print issuance stdout, interpolate the token into a shell/curl command,
persist it in fixtures, or log raw response/error bodies. The Python helper
captures HTTP error bodies in `PickupError.details`, so printing that exception
data wholesale is unsafe. Its revocation helper also ignores revocation failure.
Its `npx --yes t3` fallback may install software and was not used here.

Discovery must identify the intended local runtime before sending credentials.
The inspected Python helper does not validate a loopback-only origin, bind a
prior `environmentId`, or prohibit redirects; its development discovery and
auth `--base-dir` choices are not proof that every dev/remote combination works.
A stale file or living PID alone cannot establish the intended server identity.

## HTTP operations and response schemas

The following routes are installed-source contracts. A route's presence does
not mean that every operation or provider has been live-tested in this task.

| Request | Success body | Authorization / meaning |
| --- | --- | --- |
| `GET /.well-known/t3/environment` | Environment descriptor above | Unauthenticated; live verified |
| `GET /api/orchestration/snapshot` | `{ snapshotSequence, projects, threads, updatedAt }` | `orchestration:read`; authenticated read succeeded; unauthenticated and revoked-credential access returned 401 |
| `GET /api/orchestration/threads/:threadId` | `{ snapshotSequence, thread, page? }` | `orchestration:read`; windowed JWB-534 detail/model readback succeeded |
| `POST /api/orchestration/dispatch` | `{ sequence: nonnegative integer }` | `orchestration:operate`; accepted orchestration events, not provider completion |

Snapshot sequence is a nonnegative integer, dates are ISO datetime strings,
and IDs are branded nonempty strings. UUIDs are the Python client's convention,
not an exclusive wire format. The snapshot is a command read model: this build
leaves messages, activities, and checkpoints empty, while still loading proposed
plans. **It is not safe to dump the whole snapshot.** Detail reads can include
conversation content. `?turnLimit=N&beforeCursor=…` optionally windows detail
history; `page` has `beforeCursor`, `hasMore`, `snapshotSequence`, and optional
`threadSequence`. The cursor is opaque. Filtering output does not reduce the
data returned by an unwindowed request.

Relevant thread fields, copied from the installed schema (a projection of the
schema, not a complete JSON fixture):

```ts
{
  id: ThreadId, projectId: ProjectId, title: string,
  modelSelection: ModelSelection,
  runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
  interactionMode: "default" | "plan",
  branch: string | null, worktreePath: string | null,
  createdAt: IsoDateTime, updatedAt: IsoDateTime,
  archivedAt: IsoDateTime | null, deletedAt: IsoDateTime | null,
  latestTurn: null | {
    turnId: TurnId, state: "running" | "completed" | "error" | "interrupted",
    requestedAt: IsoDateTime, startedAt: IsoDateTime | null,
    completedAt: IsoDateTime | null, assistantMessageId: MessageId | null,
    sourceProposedPlan?: SourceProposedPlanReference
  },
  session: null | {
    threadId: ThreadId,
    status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error",
    providerName: string | null, providerInstanceId?: ProviderInstanceId,
    runtimeMode: RuntimeMode, activeTurnId: TurnId | null,
    lastError: string | null, updatedAt: IsoDateTime
  }
}
```

Projects include `id`, `title`, `workspaceRoot`, `defaultModelSelection`,
`createdAt`, `updatedAt`, and `deletedAt`, plus other project metadata.
The Python client excludes projects/threads whose `deletedAt` is non-null;
do not equate a filtered result with a hard deletion of all stored history.

The HTTP error schemas include `_tag`, `code`, and `traceId`: 400
`invalid_request` with a reason (including `invalid_command`); 401
`auth_invalid` with a reason and optional `dpopFailureReason`; 403
`insufficient_scope` with `requiredScope`; 404 `not_found` for missing thread
detail; and 500 `internal_error` with a reason such as
`orchestration_dispatch_failed`. Request schema decoding may reject a request
before normalization. Do not assume every error has the same body or that 500
means no mutation occurred.

### Dispatch bodies used by the Python transport

These are the installed field names. Every command has a `type` and
client-generated `commandId`; commands below also carry their target ID.
Optional fields are identified explicitly. No command was sent during JWB-488.

| Type | Body fields beyond `type` / `commandId` | Behavior and evidence boundary |
| --- | --- | --- |
| `project.create` | `projectId`, `title`, `workspaceRoot`, `createdAt`; optional `createWorkspaceRootIfMissing`, `defaultModelSelection` | Registers the project. Python sets directory creation false. This build **ignores** the default model seed and records null; explicit defaults use a separate metadata operation. |
| `thread.create` | `threadId`, `projectId`, `title`, `modelSelection`, `runtimeMode`, `branch`, `worktreePath`, `createdAt`; `interactionMode` defaults to `default`; optional `historyImport: true` | Creates an addressable thread. A thread record alone does not prove a running provider turn. |
| `thread.turn.start` | `threadId`, `message: { messageId, role: "user", text, attachments }`, `runtimeMode`, `interactionMode`, `createdAt`; optional `modelSelection`, `titleSeed`, `bootstrap`, `sourceProposedPlan` | Starts a user turn or sends a follow-up to an existing thread. Python sends text and an empty attachment array. Dispatch acknowledgement does not prove delivery or successful inference. |
| `thread.delete` | `threadId` | Records `thread.deleted` / `deletedAt`. The deletion reactor asynchronously stops the provider and closes thread terminals with history deletion; cleanup can fail after acknowledgement. |

`bootstrap.createThread` carries `projectId`, `title`, `modelSelection`,
`runtimeMode`, `interactionMode`, `branch`, `worktreePath`, and `createdAt`.
`bootstrap` also permits `prepareWorktree` and `runSetupScript`. The Python
transport uses an already prepared worktree and `runSetupScript: false`.
The installed normalizer canonicalizes command timestamps on receipt.

Python first tries `thread.turn.start` with `bootstrap.createThread`. On a
`PickupError`, it falls back to explicit `thread.create`, snapshot polling,
an extra 0.5-second settlement delay, then plain `thread.turn.start`. A comment
attributes the workaround to nightly 0.0.32 dropping bootstrap information for
an externally prepared worktree. That comment is historical evidence, not a
reproduced defect in 0.0.41. JWB-534's manifest does not identify which path ran.

### Interrupt, stop, deletion, and visibility

Installed source additionally accepts `thread.turn.interrupt` with `threadId`,
optional `turnId`, and `createdAt`, and `thread.session.stop` with `threadId`,
`createdAt`, and optional `onlyIfSettled`. Both require `commandId` as usual.
The interrupt reactor calls the provider by **thread**, explicitly because
orchestration turn IDs differ from provider turn IDs. The optional turn ID is
not proof of a compare-and-interrupt guard against a concurrently started turn.
These operations have not been exercised live here.

Interruption requests cancellation of work while preserving the conversation.
Session stop ends its provider session; deletion removes the thread from normal
use and starts additional cleanup. They are not interchangeable, and deletion
is not a safe default implementation of Wayfinder stop. The inspected deletion
reactor does not remove a worktree; workspace preservation across all failure
paths still needs conformance proof. Wayfinder must never remove a workspace
as a side effect of stopping a run.

A visible T3 pane establishes presentation only. Pane visibility, thread
existence, provider liveness, durable recovery, and ticket completion are distinct.
The API offers useful management primitives; an implementation must verify its
own supported lifecycle before advertising a managed host. Closing a pane or
losing the client connection is not evidence that an agent stopped.

## Stable identity and model readback

The installed environment contract defines `ScopedThreadRef` and
`ScopedThreadSessionRef` as `{ environmentId, threadId }`. T3 persists its
environment identity independently of the runtime PID/port. Thread identity is
the caller-selected `threadId` within that environment; project, command,
message, orchestration turn, provider instance, and auth session IDs have
separate meanings. A title, ticket key, PID, branch, or worktree path alone is
insufficient session identity.

Python stores `t3ThreadId` in the pickup manifest. It discovers a reusable thread
by worktree path **or** branch and rejects a candidate if both do not match.
It does not prove uniqueness across all matches or store the T3 environment ID
in that manifest. JWB-489 must resolve collision and reconnect identity behavior
before using this heuristic as durable ownership evidence.

The installed wire model selection is:

```ts
{ instanceId: ProviderInstanceId, model: string,
  options?: Array<{ id: string, value: string | boolean }> }
```

The decoder promotes legacy `provider` to `instanceId` when the latter is
absent; explicit `instanceId` takes precedence. Output encodes `instanceId`.
Option IDs and string values must be nonempty after trimming. A legacy options
object is also decoded to the array form; numbers are not valid array option
values. The instance ID identifies a configured provider instance, not necessarily its driver kind.
Current Python `ResolvedSelection.wire()` uses `instanceId`, although historical
manifest evidence uses a `provider` label. Do not blindly copy receipt fields
as HTTP request/response fields or assume custom instances equal driver names.

Python reads `GET /api/orchestration/threads/:threadId` after launch and compares
the reported model/instance to the resolved request. It polls up to 50 times
at 0.1-second intervals, excluding request duration. It accepts omitted option
readback but rejects conflicting reported options. A missing option therefore
does **not** prove the requested reasoning effort or context setting. Reusing
an existing thread bypasses this fresh verification. A model mismatch triggers
deletion compensation in Python; the command acknowledgement alone does not
verify that compensation finished.

Snapshot selections plus Python's static catalog show models previously
selected, not a complete provider availability, credentials, entitlement, or
successful inference probe. Host model readback proves reported configuration,
not the upstream provider's actual execution of every requested option.

Sanitized historical receipt projection (not a live T3 response):

```json
{
  "version": 2,
  "ticket": "JWB-534",
  "state": "ready",
  "branch": "task/JWB-534",
  "worktreePath": "<repository-worktrees>/business-metrics/JWB-534",
  "t3ThreadId": "<recorded-thread-id>",
  "t3Model": {
    "requested": { "provider": "codex", "model": "gpt-6-astra", "reasoningEffort": "high", "contextWindow": null },
    "resolved": { "provider": "codex", "model": "gpt-6-astra", "options": [{ "id": "reasoningEffort", "value": "high" }] },
    "verified": { "provider": "codex", "model": "gpt-6-astra", "options": [{ "id": "reasoningEffort", "value": "high" }], "at": "2026-09-09T23:10:51.485317+00:00" }
  }
}
```

This proves the launcher recorded a ready pickup with matching model evidence.
It lacks server version, environment ID, command IDs, acknowledgement sequences,
and a launch-path transcript. It does not prove turn/ticket completion, restart
recovery, interrupt success, or delete compensation. The session was untouched.

The subsequent authenticated reads matched the manifest's exact thread ID,
branch, worktree, `codex` instance, `gpt-6-astra` model, and
`reasoningEffort=high` option. Snapshot and detail also agreed on project and
model selection. The detail response included window metadata keys
`beforeCursor`, `hasMore`, `snapshotSequence`, and `threadSequence`.
This sanitized projection records only selected observed fields, not a complete
response fixture:

```json
{
  "snapshotSequence": 3421,
  "thread": {
    "modelSelection": {
      "instanceId": "codex",
      "model": "gpt-6-astra",
      "options": [{ "id": "reasoningEffort", "value": "high" }]
    },
    "latestTurn": { "state": "completed" },
    "session": { "status": "ready", "activeTurnId": null, "lastError": null },
    "deletedAt": null
  }
}
```

The verification used the existing Python transport with redirects disabled
and the discovered origin restricted to local `http://127.0.0.1`. It selected
only the manifest's thread from the snapshot and requested one turn of detail;
response bodies remained in memory, with no conversation content emitted.
Revocation ran in `finally` using a captured subprocess result, followed by a
GET proving that the revoked credential was rejected. Only the short-lived auth
credential was created/revoked; no agent thread or turn was created or changed.

## Observation, acknowledgement, and recovery limits

`latestTurn.state: completed` means an agent turn ended successfully in T3's
projection. It does **not** mean acceptance criteria passed, review finished,
a PR merged, or Jira Done. `error` and `interrupted` also end turns without
establishing ticket completion. A later turn may begin on the same thread.
`session.status: ready` can mean a provider is ready for more work; it is not a
workflow gate. T3 settlement/archive metadata is not Wayfinder tracker truth.

Interpret the known thread's latest turn ID/state together with session status,
`activeTurnId`, `lastError`, deletion state, sequence, and observation time.
Null `latestTurn` or `session`, no active turn ID, a missing thread, contradictory
fields, unknown enum values, stale observations, auth failures, and unreachable
servers must remain unknown/attention cases until reconciled. Do not invent a
failure threshold, mark Done, release a claim, or recreate work from an empty
or failed read. Snapshot `updatedAt` describes projection data, not an agent
heartbeat, and a sequence can advance because another thread changed.

The engine persists events, projections, and a command receipt in a database
transaction, then publishes events to asynchronous reactors. `{ sequence }`
is an orchestration acknowledgement. Provider startup, inference, interruption,
and deletion cleanup may still fail. Observe the intended thread after dispatch;
a sequence watermark alone cannot establish all downstream effects.

Command receipts deduplicate by `commandId` and reject reuse against a different
aggregate. They do not establish arbitrary payload equality for reuse against
the same aggregate. Preserve the original command identity and intent when
reconciling a lost acknowledgement. HTTP timeout/500 can follow committed work;
blind retry with a new command ID, Python's broad bootstrap fallback, or deletion
after an ambiguous start can duplicate or destroy work. Those behaviors are
evidence to test, not a transaction recipe to copy into the adapter.

On Wayfinder restart/reconnect, rediscover the endpoint, confirm the expected
environment identity/version, obtain valid credentials for that runtime, and
read the persisted thread identity and relevant state before any new action.
Preserve command/observation evidence in the existing durable store. Do not
depend on an in-memory token, UI pane, old origin/PID, or chat history.

The installed `reconcileProviderSessions` checks live provider sessions,
persisted bindings/resume cursors, continuation markers, and the
`continueThreadsAfterServerUpdate` setting. Eligible work may be continued;
orphaned or failed recovery can be settled as an error. Recovery can use a
provider's promptless continuation capability or send a continuation prompt.
Consequently a restarted server is neither proof of uninterrupted execution
nor permission for Wayfinder to send a duplicate prompt. No restart, reconnect,
setting change, or provider continuation was induced in this task.

The source also defines RPC subscriptions with `afterSequence` replay and an
optional synchronization marker. That is a separate surface from HTTP snapshots;
socket authentication, replay gaps, and reconnect behavior were not qualified.
No cross-platform, remote, container, or multiple-runtime lifecycle was tested.

## JWB-489 prerequisites and handoff

The concrete missing prerequisite is **host adapter conformance evidence** for
this version, especially identity collisions, ambiguous dispatch, model option
readback, interrupt targeting, failed compensation, and restart/reconnect. The
existing launch receipt and source do not establish those guarantees. The host
qualification minimum and durable lane/run-store relationship remain unresolved
in the direction record; this document does not choose new interfaces for them.

Before advertising operations, JWB-489 needs deterministic fake/conformance
cases for those paths and separately authorized lifecycle verification. In
particular, it must avoid copying the Python bootstrap fallback and deletion
compensation without verifying their outcomes, bind environment plus thread
identity, and treat unverified model options as unverified. A matching runtime
version is an input to qualification, not sufficient capability evidence.

Delivery is a tested draft PR with this README-linked document. The coordinator
must review it and post the JWB-278 supersession comment. Jaren approves the
merge; Jira resolution/Done and the single map context pointer remain pending
and are outside this task session's mutation authority.
