# Prototype — JWB-329: Prove an isolated agent lane in Docker Sandbox

> **Throwaway code that answers one question.** Not production. The only part worth
> lifting is the pure state machine in `lane-machine.ts`; the rest is a driver shell.

## The question

Can Wayfinder drive **one** isolated agent lane end-to-end where:

1. the host source stays unchanged until an explicit review/import step;
2. the worker cannot reach unrelated host files or Wayfinder-global credentials;
3. a dev server is reachable from the host at a recorded, collision-free lane endpoint;
4. lane state survives an orchestrator/session reconnect;
5. failure modes and cleanup are recorded well enough to productize the adapter?

## Run it

```bash
bun run prototype:jwb-329      # needs a running docker daemon; alpine:3 image
```

One command. It drives three scenarios against a **real docker container**, prints the
full lane state after every transition, and ends with a machine-readable evidence block.

## Verdict — PROVEN (12/12 checks)

The lane topology and lifecycle hold. Every acceptance criterion is demonstrated by a
physical fact observed at runtime, not asserted on paper:

| # | Acceptance criterion | How it is proven | Result |
|---|----------------------|------------------|--------|
| 1 | Host source unchanged until explicit import | `worktreeSignature()` (HEAD + `status --porcelain` + `ls-files -s`, hashed) is byte-identical before/after; the lane's edit is retrievable only via an explicit `docker cp` out, and the host signature is still equal afterward | PASS |
| 2 | Worker cannot access unrelated host files / global creds | The agent probes `$HOST_SECRET_PATH`, a fake `~/.wayfinder/credentials`, `/root/.wayfinder/credentials`, and an unrelated host path **from inside** the sandbox: 0 `leak` lines, 4 `absent` probes. No host bind-mount exists, so the container structurally cannot see the host FS | PASS |
| 3 | Dev server reachable at recorded endpoint | One container port published to a collision-free `127.0.0.1:<port>` (reserved via `net.listen(0)`); host `fetch` gets `HTTP 200 {"status":"serving"}`; the endpoint is stored in durable lane state | PASS |
| 4 | Lane state survives reconnect | A **fresh** `ControlPlane` re-reads the append-only log and folds it with `project()`; `durableFingerprint()` equals the live state, then the live sandbox + endpoint are re-verified (never recreated) | PASS |
| 5 | Failure modes & cleanup recorded to productize | Start-time failure compensates (sandbox + clone removed, host untouched, `compensated:true`); stop is idempotent + receipt-scoped; teardown removes exactly the 2 owned resources and never the worktree; failed readiness → `attention_required`, never silent success; illegal transitions are guarded | PASS |

## Architecture (faithful to ADR 0001)

- **§6 sandbox-private clone, no writable host-repo access.** The clone is materialized
  *from* the worktree's git *into* the container via `git clone file://…/.git` → `docker cp`.
  No bind-mount. The lane writes only inside `/workspace`; the host repo is never writable.
- **§7 agent runs inside the sandbox.** The agent program is baked as the container's
  command (`agentScript`), so it runs *in* the sandbox on start. The host never
  `docker exec`s agent work — it observes through **one narrow stdio bridge**
  (`docker logs`, structured JSONL) plus the **one** published dev-server port.
- **§15 workspace handle is a sandbox-frame path.** `/workspace` is a path in the
  sandbox's frame of reference, materialized by the adapter — not a host path.
- **Control plane = append-only log.** `ControlPlane` is JSONL on disk; `lane-machine.ts`
  is a pure fold over it. Any fresh orchestrator process re-derives byte-identical state.
  That is the entire reconnect proof, and the one liftable artifact.

## Failure modes & cleanup (the productization ledger)

| Failure mode | Detected by | Compensation | Host worktree |
|--------------|-------------|--------------|---------------|
| Clone/stage fails | non-zero `git clone` | throw before any container exists | untouched |
| Agent fails to launch | `sandboxRunning() === false` after start | `teardown()` removes container + staging clone; `lane_failed{compensated:true}` | untouched |
| Readiness never comes up | `endpointAnswers().ok === false` | lane → `attention_required` (retains evidence); **never** auto-promoted to `ready` | untouched |
| Orchestrator dies / reconnects | fresh process re-reads log | `project()` re-folds; live sandbox re-verified, not recreated | untouched |
| Stop called twice | `sandboxRunning()` guard | second call is a no-op (`changed:false`); scoped to owned ids only | untouched |
| Teardown | `docker rm -f` + `rm` staging | removes exactly the 2 owned resources | **never** deleted |

Cleanup is verified: the run leaves **0** `jwb329-*` containers and **0** `/tmp/jwb329-*`
staging dirs behind.

## Substitution note — why a container stands in for `sbx`

The intended strong-isolation adapter is **Docker Sandbox `sbx`** (a microVM with its own
kernel — JWB-328). `sbx` is **not provisioned** in this environment, so the prototype's
preflight **fails closed**: it records `strongIsolation:false` with boundary
`docker-container (shared-kernel stand-in)` and **does not silently downgrade** an explicit
strong-isolation requirement. What is proven here is the **lane topology and lifecycle** —
private clone, in-sandbox agent, narrow bridge, one published port, durable/reconnectable
control plane, receipt-scoped teardown — against a container that is a *peer*
EnvironmentAdapter sharing that topology.

**Remaining productization gap** (for the real adapter, tracked beyond this ticket):
microVM-strength kernel isolation, `sbx`-native clone provisioning, and `sbx` egress/network
policy. The container boundary shares the host kernel and does not enforce network egress —
adequate to prove the shape, not to be the shipped isolation.

### The JWB-328 `--clone`-from-worktree tension, resolved

JWB-328 found `sbx --clone` is rejected when invoked from a **linked git worktree**, and
Wayfinder lanes *are* linked worktrees. Resolution proven here: don't ask the sandbox tool
to clone the worktree. Instead the **host** clones the worktree's git into private staging
(offline, `file://`), then copies it into the sandbox's `/workspace`. The lane still gets a
private, writable clone; the host repository is never writable from inside.

## What lands in production vs. what is thrown away

- **Lift:** the pure lane state machine — `LaneEvent` vocabulary, `reduce`/`project` fold,
  `transitionError` guards, `durableFingerprint`. This is the durable-lane + reconnect core.
- **Throw away:** `docker-lane.ts` (the real docker/git I/O shell) and `run.ts` (the driver).
  When the real `EnvironmentAdapter` for `sbx` is built, these are the reference for its
  `preflight/plan/start/verifyReady/logs/resume/stop` behaviour, not shippable code.
