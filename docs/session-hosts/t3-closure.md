# JWB-489 post-merge closure handoff

JWB-489 is **not complete**. PR #39 delivered an adapter foundation. Verified
agent stop and live adapter acceptance remain outstanding. Keep Jira open;
JWB-492 owns safe pickup recovery and standalone command composition.

## Reconciled baseline

- PR [#39](https://github.com/JarenKempton/wayfinder-cli/pull/39) merged at
  `2026-09-10T02:24:57Z` as `7ee3403039d8920c25a2a8ad2f76e4e9dd740b16`.
  `origin/main` was that commit when inspected. Its tree equals the final reviewed
  `task/JWB-489` commit `fe07f350099390f5ca5fe19f463712859f50f82b`.
- The original worktree/branch is preserved. This handoff is in the new isolated
  worktree `/home/jaren/Development/wf-worktrees/wayfinder-cli/JWB-489-closure`,
  branch `task/JWB-489-closure`, based on that main commit. No runtime code changed.
- Re-read the runtime contract, AGENTS.md, merged `t3-code.md`, September 9 direction,
  and `first-release-acceptance.md` in the direction worktree. The latter's JWB-489
  dependency row predates PR #39. Jaren's current instruction assigns pickup
  composition to JWB-492. Neither stale status text nor merge changes acceptance.
- Reconnect reads the recorded session without dispatch. Unknown outcomes preserve
  workspace and claim. Stop must stop the agent and verify the outcome; release
  and cleanup remain separate. Finished turns do not mean completed work.
- The merged adapter advertises `process_launch`, `session_create`, `session_status`.
  Managed `session_interrupt` and `visible_multi_session` remain unadvertised.
  Its low-level stop request always ends unverified; the lifecycle bridge rejects
  managed stop before dispatch. There is no standalone pickup integration.
- The earlier feedback's software-version limitation is stale: before merge,
  version gating was removed. The actual server version is diagnostic evidence;
  runtime identity and wire shape are validated. This does not qualify termination
  semantics on any version or prove all provider/platform combinations work.

## Non-mutating evidence collected

The installed T3 remains `0.0.41-nightly.20260909.1426`. One unauthenticated GET to
`http://127.0.0.1:3773/.well-known/t3/environment` returned environment
`ba2e9684-35d3-4155-8c13-327fc80aec8e` and that version. The origin was validated
as literal loopback, proxies and redirects disabled. Its capabilities contain no
termination-confirmation feature. No credentials were issued/revoked, no session
snapshot/conversations read, and no live dispatch, thread/turn change, or restart
was performed in this investigation. Capability absence alone is not the proof;
the source trace below explains the gap.

Installed sources were read from `sourcesContent`, not from live runtime state:

| Artifact under the installed `node_modules/t3/dist/` | SHA-256 |
| --- | --- |
| `bin.mjs.map` | `3eca191f249234f5429f63e897ed70d20cf3608691820f2478688af8d1b2dab7` |
| `NodeServices-BOg0EHBo.mjs.map` | `e0a882ea4656133c8d456e5c3ea291afb4facef929cb66e266b6f9ff24de26d5` |

The installed root is
`/home/jaren/.t3/runtime/versions/0.0.41-nightly.20260909.1426/`.
Line numbers below refer to the embedded source, except where explicitly marked
as bundled JavaScript. App paths are relative to `apps/server/src/`.

| Source | Finding and consequence |
| --- | --- |
| `provider/Layers/CodexSessionRuntime.ts:1217–1244` | T3 owns a spawned Codex app-server child in the runtime scope, with a two-second force-kill delay. Wayfinder has no corresponding process handle. |
| Same, `2232–2256` | An internal `child.exitCode` watcher observes process exit, but returns without an event when `closedRef` is true. The watcher itself lives in the scope being closed. |
| Same, `2300–2318` | Intentional close sets `closedRef`, publishes closed state and `session/closed`, then closes the scope. Waiting for another exit event cannot repair this ordering: intentional close suppresses that event. |
| `provider/Layers/CodexAdapter.ts:1476–1483,2663–2688` | Normalizes synthetic close and actual exit alike; marks stopped/removes the session before runtime cleanup, ignores cleanup failures, and treats missing sessions as successful no-ops. List absence cannot prove termination. |
| `provider/Layers/ProviderService.ts:1939–1992` | Stop returns no termination evidence. It may skip inactive sessions, then persists stopped status. |
| `orchestration/Layers/ProviderCommandReactor.ts:1634–1695` | If the projection is already stopped, bypasses provider stop and enters the success path. A later stopped projection/timestamp is still insufficient. |
| `orchestration/Layers/ProviderRuntimeIngestion.ts:1573–1607`; `ProjectionPipeline.ts:91–93,1311–1347` | Synthetic exit can supply stopped session, cleared active turn, null error and interrupted turn before cleanup succeeds. |
| `provider/Layers/CodexSessionRuntime.ts:2360–2374,2385–2417` | Follow-ups may queue behind an active turn. Turn interruption fans out to child threads with timeouts and ignored errors. Interrupt acknowledgment cannot establish whole-agent termination. |
| `orchestration/http.ts:90–106`; `packages/contracts/src/orchestration.ts:1909–1912` | Dispatch acknowledges orchestration acceptance with a sequence, not completed provider termination. |
| `packages/contracts/src/environmentHttp.ts:509–538` | Snapshot/thread reads and dispatch are exposed. These inspected HTTP contracts provide no independent provider termination result. |

There is a further dependency-level issue. Embedded
`@effect/platform-node-shared/dist/NodeChildProcessSpawner.js` in the NodeServices
map (version `4.0.0-rc.112`) shows:

- Lines 350–363: automatic scope cleanup ignores kill errors itself. Removing
  only T3's `Effect.ignore` calls does not make scope closure a reliable barrier.
- Lines 394–407: explicit `handle.kill(...)` waits for the child's exit signal and
  can propagate failure. This is the smallest existing internal termination
  primitive worth using. `exitCode` represents signal termination as an error;
  treating every such error as failure or success would both be wrong.
- Group termination can fall back to killing only the parent. The completion wait
  covers the parent exit, not every descendant. The timeout can cease once the
  parent exits even if another group member remains. An already-exited child may
  also bypass group cleanup. These paths cannot certify ongoing tools are gone.

These findings are source evidence, not a live kill experiment. They establish
that the inspected public T3 stop path is insufficient. They do not establish that
every possible provider has the same internals or that an arbitrary future T3
build will have this limitation.

Current upstream was also checked at immutable commit
[`0f602b3372b300ae94084bd3fe7dbaadaa58ba3a`](https://github.com/pingdotgg/t3code/commit/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a),
dated `2026-09-10T02:26:51Z`. The relevant behavior persists in
[CodexSessionRuntime](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2307),
[CodexAdapter](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/provider/Layers/CodexAdapter.ts#L2664),
and [ProviderCommandReactor](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1634).
An upgrade alone is not an evidenced fix. No upstream changes or messages were sent.

## Precise upstream proposal

Proposed upstream change: **make Codex session stop return durable, command-correlated
termination evidence only after the provider and its owned execution have ended**.
This is a technical requirement with a concrete implementation seam, not an
unresolved product choice. The following is a proposal, not an existing API.

1. In `CodexSessionRuntime`, separate stop-requested from termination-confirmed.
   Retain the child handle and one shared termination result outside the scope
   whose shutdown cancels event consumers. Run explicit termination with a bounded
   deadline and propagate errors; do not rely on automatic scope cleanup alone.
   Join the actual exit result, including signal termination, and complete cleanup
   before returning evidence. Concurrent stop callers await the same result.
2. Establish termination of owned execution, including queued turns, child agents
   and active tool subprocesses. The present parent-exit primitive is necessary
   but insufficient. Start with a fake parent that exits while a tool child survives,
   including a child in a separate process group. Use provider-owned shutdown/join
   handles or a proven process-tree termination barrier; fail closed when ownership
   or termination cannot be established. Do not assume sending a group signal,
   `Scope.close`, zero exit code, or a short quiet interval proves this. Qualify each
   provider/platform separately; do not claim global support from a Linux Codex test.
3. In `CodexAdapter`/`ProviderService`, retain a stopping context until that barrier
   succeeds. Remove success-path error suppression. Return typed confirmed versus
   failed/unknown evidence; no active entry or an already-stopped projection without
   saved proof is unknown. A failed attempt must not lose the handle required for
   explicit recovery. Do not start a replacement provider while stopping is pending.
4. In `ProviderCommandReactor`, consume that result, tied to the original stop
   command ID and the exact provider-session generation captured at dispatch.
   Reject a generation mismatch; a thread ID can outlive several provider processes.
   Persist the result through existing orchestration events/read-model seams before
   publishing confirmation. Do not synthesize confirmation from the existing
   stopped-state shortcut. If the server dies before durable proof, outcome is unknown.
5. Smallest wire addition: use a documented, server-produced termination activity
   in the existing thread activity projection, rather than a new workflow service
   or endpoint. Existing activity `kind` and `payload` are extensible
   (`orchestration.ts:565–575`), and event envelopes already carry command and
   correlation IDs (`1674–1683`). Define and validate the payload fields: original
   command ID, thread ID, provider instance, provider-session generation, terminal
   outcome, completion time, and the verified termination mechanism/scope. Environment
   identity comes from the bound host. Failed/unknown results carry a sanitized reason.
   Preserve proof across reconnect/replay; windowed/truncated or missing evidence
   remains unknown. A new generation must invalidate any old proof for current state.
   Advertise this semantic contract explicitly with provider/platform coverage;
   absence means unsupported. Do not gate it on an application-version allowlist.
6. Wayfinder then journals the original command and expected generation before one
   dispatch, validates the returned proof through its adapter, and enables
   `session_interrupt` only for qualified support. An HTTP timeout never generates a
   replacement command or automatic retry. Reconnect/inspect may read the original
   operation's result without dispatch. A transport error, stale proof or unprovable
   termination preserves workspace, receipt and claim and remains unknown.

Upstream conformance must fail with the current implementation and cover early
closed notification, delayed exit, signal exit, kill rejection, cleanup error,
surviving tool/child agent, already-missing session, concurrent stop, wrong generation,
and server failure between termination and durable recording. Verify no queued turn
or replacement provider starts after confirmation. The required outcome is whole
agent stop; if a reliable owned-execution barrier requires a provider change, retain
unsupported status and carry that specific failing test upstream as well.

**Actionable next step:** prepare an isolated upstream patch with those fake runtime
and process-handle regressions first, beginning with the surviving-tool and suppressed
cleanup cases. Implement the explicit termination result through the existing runtime,
adapter and reactor; add the documented activity contract. Do not change the installed
T3 or enable Wayfinder stop until this is reviewed and passes. This investigation
prepares that work; it does not pretend a T3 patch or containment guarantee exists.

## Closure checklist and ownership

| Owner / evidence | Status and exact completion condition |
| --- | --- |
| JWB-489: merged foundation | Delivered by #39. Identity collision, exact model/options, reconnect without dispatch, ambiguous command identity and resource-preserving failure behavior have fake coverage. Merge is evidence for this row only. |
| JWB-489: verified-stop host contract | OPEN. Upstream termination barrier and durable correlation described above are implemented, reviewed and covered by failing-before/passing-after tests. Record the source commit and qualified provider/platform scope. |
| JWB-489: adapter stop conformance | OPEN. Add positive proof validation plus pending/failed cleanup, surviving execution, stale generation, wrong command/environment, absent proof, lost acknowledgment and unavailable server cases. Exercise the existing lifecycle/ledger seam; successful stop retains workspace and claim, uncertainty never becomes stopped. Reconnect sends zero messages/turns. |
| JWB-489: required local checks | Baseline checks recorded below. Repeat `bun test`, `bun run typecheck`, `bun run check` on the actual stop implementation; paste exact output in its review artifact. Fake-only success does not close the live row. |
| JWB-489: live host acceptance | OPEN, approval required. Execute the separately approved disposable packet below only after the host and adapter barrier are qualified. Record thread creation, exact provider/model/options readback, inspect, reconnect with zero dispatch, one follow-up, independently observed active stop and durable proof, and retained resources. `adapter test t3` must report pending until it actually exercises approved lifecycle acceptance. |
| JWB-489: visible multi-session capability | OPEN against the original ticket's capability list. Do not advertise it from session creation or snapshots. A separate approved two-disposable-session visibility test is required if retaining this capability in ticket closure; the one-session packet below cannot prove it. The coordinator must record any explicit scope disposition, not silently mark this satisfied. |
| JWB-492: pickup recovery and composition | SEPARATE. Prevent claim restoration/release or duplicate launch after uncertain dispatch, persist/reconcile the original operation, enforce one writer, and wire structured T3 into standalone pickup/inspect/reconnect using existing seams. Verify these through fake transaction tests before live use. This is not a reason to represent #39 as a finished first release. |
| Coordinator: tracker closure | Keep JWB-489 open until its stop and live acceptance rows (and capability scope disposition) are evidenced and the completion implementation is merged by Jaren. Link artifacts and acceptance evidence; only the coordinator may close and append exactly one map context pointer afterward. This session performs no Jira writes. |

The concrete JWB-492 blocker remains `PickupCoordinator.#compensate`: a timed-out
launch can restore the tracker claim even with no receipt; with a receipt it attempts
stop and then restoration. A committed-but-unacknowledged `thread.turn.start` could
therefore continue while ownership is released. Preserve the pending operation and
claim, refuse duplicate pickup, and require explicit recovery. Do not force structured
provider instance/model/options through raw argv or depend on unmerged PR #32.

## Disposable live acceptance proposal — NOT authorized or executed

This supersedes the earlier draft packet. It is an exact proposed mutation budget,
not a runnable acceptance claim. Before approval, attach the reviewed host source
commit/build, Wayfinder commit, test-runner file/hash, final proof activity schema,
and precise assertion for owned-execution termination. Those do not exist yet;
do not fill them with guesses or approve an unspecified future implementation.
Installation/server restart is not included and would need separate authorization.

Proposed scope once those prerequisites exist:

1. Environment must equal `ba2e9684-35d3-4155-8c13-327fc80aec8e` at the validated
   loopback origin above. Record actual version and explicit termination capability.
   Use at most one two-minute in-memory auth credential for the packet; revoke it
   in `finally`. Expiry or revocation failure ends the run and is reported; never
   print/persist the token. Do not inspect unrelated thread content.
2. Create only `/tmp/wayfinder-JWB-489-acceptance-b713cd89`, branch
   `acceptance/JWB-489-b713cd89`, from the frozen implementation commit. Refuse an
   existing path/branch/identity. Use it as both workspace root and worktree path,
   disable setup scripts, create a sentinel plus a local SQLite run/fake claim.
3. Project `b713cd89-8bf2-4851-9a5b-0e781eb6f200`; thread
   `b713cd89-8bf2-4851-9a5b-0e781eb6f201`; title
   `Wayfinder JWB-489 disposable acceptance`. Exact model selection:
   `{"instanceId":"codex","model":"gpt-6-astra","options":[{"id":"reasoningEffort","value":"high"}]}`;
   runtime mode `full-access`, interaction mode `default`. Abort rather than
   substitute unavailable provider/model/options.
4. Mutation budget: one `project.create`, one bootstrap `thread.turn.start`, one
   follow-up `thread.turn.start`, one `thread.session.stop`, each with a distinct
   command ID journaled before dispatch and retained unchanged after uncertainty.
   No retries/replacement commands. Initial prompt:
   `Reply exactly T3_ACCEPTANCE_READY. Do not use tools, edit files, or access the network.`
   Inspect exact identity/model/options and turn state. Recreate the adapter from
   the saved receipt and reconnect; assert no POST and no additional turn.
5. One follow-up prompt:
   `Use the shell tool to run sleep 120 in the current directory. Do not edit files or access the network. After it finishes, reply T3_ACCEPTANCE_WAIT_FINISHED.`
   Wait at most 30 seconds for this exact turn and its owned sleep process to be
   observed active by the reviewed harness. If not observed, end as unverified.
   Dispatch the single stop while active. Wait at most 30 seconds for the qualified
   proof tied to this command/provider generation. Require the disposable provider
   and owned sleep execution to have ended before accepting proof. Process identity
   must include start identity/ownership, not an unscoped PID. Do not signal any
   process directly as part of this packet. An early finish, timeout, ambiguous
   dispatch or failed proof ends mutations and preserves resources for review.
6. Read back the proof with a fresh adapter to establish durable reconnection, then
   check sentinel, workspace, fake claim, receipt and thread history remain. Record
   only scoped evidence and sanitized command IDs/outcomes. No deletion, release,
   cleanup, additional turn, Jira change, notification, merge or server change.
   Preserve the disposable thread/worktree afterward.

If `visible_multi_session` remains in scope, prepare a **separate** exact packet
with a second disposable thread, specified titles/identities and UI observations.
Neither approval of the packet above nor the original delete-based ticket criterion
authorizes that second session or any deletion. Showing an existing session in the
CLI and focusing a desktop pane must be distinguished in the evidence.

## Validation of this handoff

Installed lockfile dependencies locally with `bun install --frozen-lockfile`
(Bun `1.4.2`, no lockfile change). All commands below exited 0 in the isolated
worktree. These validate the unchanged merged implementation; they do not qualify
the proposed upstream behavior or any live lifecycle action.

```text
$ bun test
322 pass
0 fail
999 expect() calls
Ran 322 tests across 25 files. [229.00ms]

$ bun run typecheck
$ tsc --noEmit

$ bun run check
$ biome check .
Checked 66 files in 18ms. No fixes applied.

$ git diff --check
(no output)
```

No Jira changes, GitHub comments, pushes, merges, releases, additional agents or
live lifecycle actions were made. The handoff and stale-status correction are local
documentation changes on `task/JWB-489-closure`.
