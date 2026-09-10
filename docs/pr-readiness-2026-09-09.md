# Open PR disposition — September 9 review session

Historical snapshot: current dispositions are in
[September 10 reconciliation](pr-reconciliation-2026-09-10.md).

This is a scoped architecture/readiness assessment, not blanket approval or a
complete security review. No PR was merged, closed, or superseded by this review.

## PR 32 — revise and retain the useful separation

Purpose: separate command-agent invocation construction from process execution.
Previously CommandHarnessAdapter both rendered argv and spawned a local process.
The PR extracts AgentInvocation and AgentRuntime and delegates launch/stop.
That motivation remains aligned with the direction record.

Reviewed head: `2397b83`. All three posted platform checks pass. Two read-only
local reproductions nevertheless demonstrate gaps:

- An injected remote runtime with an executable available only remotely cannot
  receive an invocation: invoke calls preflight, which calls the local which
  lookup and local filesystem access. Result: `Harness executable not found:
  remote-agent`. Runtime-specific availability/path checks need the appropriate
  execution context, not unconditional local-host checks.
- An injected runtime whose describe returns no capabilities still yields
  `process_launch: true` from the command adapter when its executable is local.
  Runtime capabilities are not composed into the advertised launch capability.

The argv/cwd boundary is useful for command-based agents, but must not be sold as
the universal T3 session-host contract. T3 accepts structured session requests.
Narrow the claim or revise the interfaces after JWB-488. Do not merge as-is or
throw away the implementation merely because its original ticket is Done.

## PR 34 — hold and reconcile the state model

Purpose: durable lane events, authorized state transitions, restart replay, and
SQLite storage. Useful foundations, but source adds a fixed LaneState including
validating, reviewing, approved, human_ready and a global policy.set event.
These require reconciliation with configurable workflow stages and map-scoped
orchestration. The relationship to existing run/claim storage remains unresolved.

The failed Windows job identifies `laneStorePath resolves under the platform
data directory`: LOCALAPPDATA is missing in its supplied test environment.
Do not equate that failure with proof the whole storage approach is wrong, or
fix the test and assume the architecture is thereby approved.

## PR 33 — retain research; verify before treating as support policy

Purpose: Docker Sandbox platform and capability research. Current CI is green.
Not superseded by choosing T3 first. Its platform and command claims require
current primary-source verification before adoption; this review did not perform
that verification. A research merge would not mean Docker integration ships.

## PR 36 — defer product-readiness approval; preserve useful code

Purpose: Docker Sandbox environment implementation. CI is green, but fake-provider
tests are not proof of a usable installed runtime. Source probeDockerSandbox
returns osQualified:false pending an explicit version/architecture probe. There
is real unfinished qualification work. Review live provider behavior, agent-in-
sandbox execution, workspace preparation, and recovery against the selected host
before advertising support. Do not merge solely to clear the PR queue.

## PR 37 — reviewable record, not implementation approval

Records discussion direction and unresolved conflicts. It deliberately does not
supersede all older ADRs. Review wording and distinctions; it is not a request to
approve every proposed subsystem.

## Decisions that can progress alongside JWB-488

1. Select the first demonstrable release boundary: managed single-ticket pickup
   or unattended map progression. Keep the map-scoped contract either way.
2. Define session-host minimum capabilities after the T3 evidence arrives.
3. Define workflow stage ownership versus agent progress prose; decide whether
   the optional PR workflow is a separate integration.
4. Resolve setup authorization/retry semantics and project requirement versus
   personal override behavior with concrete examples.

Technical work that does not need speculative product decisions: reproduce and
fix PR 32's capability/preflight defects, investigate claim concurrency, and
identify the minimum run/lane-store integration. Do not open competing
implementations on the same interfaces while JWB-488 is establishing evidence.
