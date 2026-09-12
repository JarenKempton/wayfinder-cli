# T3 session-host integration

[The adapter](../../src/adapters/session-hosts/t3/adapter.ts) owns structured
session operations and receipt validation.
[The connection module](../../src/adapters/session-hosts/t3/connection.ts) owns
runtime discovery, HTTP, and credential subprocesses. The consumed wire shapes
live in those modules; [adapter tests](../../test/t3-adapter.test.ts) and
[connection tests](../../test/t3-platform.test.ts) exercise their boundaries.

## Identity and dispatch

A receipt binds environment and thread identity, project, workspace, branch,
runtime/interaction modes, and exact provider instance/model/options. Titles,
paths, branches, and PIDs alone cannot authorize session adoption. Duplicate
or contradictory matches fail closed.

Server versions are diagnostic evidence, not compatibility allowlists.
Response validation and verified semantics determine support. A configured
provider instance is not necessarily the name of its underlying agent driver.

Before each dispatch, the adapter awaits a durable journal write containing
the receipt, command identity, target, and intent digest. Prompts and credentials
are excluded. An acknowledgement records orchestration acceptance, not completed
provider work. Lost acknowledgements retain the original command identity;
they do not cause a replacement dispatch or bootstrap fallback.

Bind one adapter journal to one run and persist its receipt unchanged as
`run.execution`. The existing execution ledger owns recovery evidence; a
separate session-state store would introduce competing ownership.

## Observation and recovery

Reconnect reads the recorded session without sending a message or starting a
turn. A missing or unreachable session requires recovery; it never triggers
replacement. Reconnect does not imply desktop pane activation.

A completed turn with a ready session is reported as `turn_finished`, not
verified stop or ticket completion. Unknown enums, contradictory fields,
missing requested model options, or provider errors cannot become success.
Snapshot timestamps are not agent heartbeats, and sequence advances may belong
to unrelated threads.

An uncertain launch must preserve its claim, workspace, and original operation
evidence and block duplicate launch. The generic pickup compensation path can
restore a claim after a failed launch; it must not be composed with T3 while
that launch may still be executing. See [pickup compensation](../claim-semantics.md#pickup-and-compensation).

## Stop verification

The adapter withholds managed interruption because it cannot verify termination.
Its low-level stop request can dispatch once but returns `stop_unverified`;
the lifecycle bridge rejects managed stop before dispatch. Neither path releases
ownership or deletes resources.

A stopped projection, cleared active turn, interrupted turn, dispatch
acknowledgement, or absent provider entry is insufficient proof. The inspected
upstream implementation can publish closed state before cleanup and ignore
cleanup failures. The relevant immutable source is
[CodexSessionRuntime](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/provider/Layers/CodexSessionRuntime.ts#L2307),
[CodexAdapter](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/provider/Layers/CodexAdapter.ts#L2664),
and [ProviderCommandReactor](https://github.com/pingdotgg/t3code/blob/0f602b3372b300ae94084bd3fe7dbaadaa58ba3a/apps/server/src/orchestration/Layers/ProviderCommandReactor.ts#L1634).

Enabling managed stop requires durable termination evidence correlated with the
original command, environment, thread, and provider-session generation. It must
cover owned execution, including tools and child agents, and surface cleanup
failure. Parent-process exit alone does not prove descendants stopped.
Stale, absent, or uncertain proof must preserve resources and remain unknown.
Conformance must distinguish pending cleanup, failed cleanup, surviving
execution, stale generations, and lost acknowledgements before support is enabled.

## Local probe

```sh
bun run src/cli.ts adapter test t3 --read-only
```

This probes discovery, authentication, and snapshot reading. It issues a
short-lived credential in memory and revokes it afterward; it does not dispatch
agent work or qualify a live lifecycle. The connection validates literal
loopback origin and environment identity before sending credentials, rejects
redirects, and excludes raw response bodies and tokens from diagnostics.

Discovery does not silently switch away from an invalid runtime file.
Credentials and conversation snapshots must never be copied into documentation
or fixtures. The [sanitized fixture](../../test/fixtures/t3-snapshot.json) is
test input, not an installed-server inventory.
