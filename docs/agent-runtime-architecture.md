# Agent runtime and lane architecture

Status: design direction for Wayfinder CLI.

This document captures the intended architecture for long-running, multi-lane agent development. It extends the existing ownership, environment, workspace, lifecycle, and adapter boundaries without replacing them.

The goal is to make a command such as `wayfinder pickup <ticket>` sufficient to create a safe, durable development lane using the user's preferred tracker, agent, session host, workspace strategy, isolation policy, credentials, project setup recipe, resource limits, validation pipeline, and review policy.

## Design goals

Wayfinder should:

- remain portable across macOS, Linux, and Windows;
- support multiple issue trackers and agent runtimes without making any vendor part of core;
- support interactive and unattended agent work;
- survive UI, terminal, session-host, and agent-process restarts;
- make strong isolation easy for users who do not understand sandbox internals;
- default to least privilege for network and credentials;
- avoid unnecessary local resource use, especially on 8-core / 16 GB developer machines;
- make parallel lanes explicit and resource-admitted rather than blindly concurrent;
- preserve a human review path for live diffs, running services, and final changes;
- let repositories declare how a fresh workspace becomes runnable;
- support local-only, hybrid local/hosted, and future remote development topologies;
- keep implementation agents disposable while preserving durable coordination state; and
- expose structured state and receipts so any UI or orchestrator can observe work reliably.

## North-star architecture

```text
                    Human
                      |
          T3 Code / Herdr / terminal / UI
                      |
                      v
              Orchestrator agent
                      |
              high-level decisions
                      |
                      v
+------------------------------------------------+
|              Wayfinder control plane           |
|                                                |
|  durable ledger / event log                    |
|  lane state machine                            |
|  scheduler and resource admission              |
|  policy/config resolver                        |
|  tracker coordination                          |
|  validation/review coordination                |
|  runtime/environment manager                   |
|  service/port registry                         |
|  recovery and supervision                      |
+----------------------+-------------------------+
                       |
            scoped authenticated channels
                       |
       +---------------+----------------+
       |               |                |
       v               v                v
   Lane A           Lane B          Review lane
   sandbox          sandbox           sandbox
      |                |                 |
 implementer       implementer         reviewer
      |                |                 |
      +------ structured events ---------+
```

The key separation is that an orchestrator conversation may be the user's primary control surface, but the conversation itself is not durable coordination state. Wayfinder owns the durable control plane underneath it.

If T3 Code, a terminal, a browser tab, or an agent session disappears, active lanes remain recoverable and observable from Wayfinder state.

## Core ownership

Wayfinder core owns portable coordination semantics:

- ticket, claim, run, and lane identity;
- lane state transitions;
- tracker-backed claim and lease behavior;
- scheduling and resource admission;
- layered configuration and policy resolution;
- credential handles and least-privilege policy;
- workspace and project-environment requirements;
- validation and review requirements;
- service declarations and host-visible endpoints;
- structured lane communication/events;
- durable receipts, observations, and audit history;
- supervision, stop, resume, and recovery; and
- the decision that unsupported behavior fails explicitly.

Adapters own vendor mechanics. They do not redefine Wayfinder lifecycle semantics.

## Adapter boundaries

Wayfinder should converge on five meaningful integration seams.

### Tracker adapter

Answers: "How do I read and mutate work in this tracker?"

Examples:

- GitHub Issues
- Linear
- Jira

Tracker adapters normalize vendor records and perform capability-checked mutations requested by core. Frontier eligibility, claims, leases, recovery, and transaction ordering remain Wayfinder concerns.

### Workspace adapter

Answers: "Where does the editable source tree for this lane come from?"

Examples:

- `host-worktree`
- `sandbox-clone`
- future remote workspace providers

The existing deterministic Git worktree adapter remains valuable for host-mode execution. Strong sandbox clone mode should be a separate workspace strategy rather than an unconditional layer on top of a host worktree.

### Environment/runtime adapter

Answers: "Where and under what isolation boundary does this lane execute?"

Examples:

- `host`
- `docker-sandbox`
- future remote machine / microVM providers

A runtime implementation owns environment preflight, planning, start, readiness, logs, resume, stop, network realization, credential realization, service exposure, and resource limits.

`host` should itself be modeled as an environment rather than as an absence of environment. This avoids special-case branching throughout the core.

### Agent adapter

Answers: "How do I invoke and steer this coding agent?"

Examples:

- Codex
- Claude Code
- OpenCode
- Pi
- Cursor Agent

The agent adapter should describe the invocation and semantic capabilities of the agent. It should not decide whether that invocation runs on the host, in a Docker Sandbox, or on a remote machine.

This implies a refactor from "harness directly spawns a process" toward "agent adapter produces an invocation; environment/session-host executes it."

### Session-host adapter

Answers: "What owns the long-running interactive session and how can people or orchestrators attach to it?"

Examples:

- native process
- T3 Code
- Herdr
- tmux

This is intentionally separate from the agent runtime. T3 Code, for example, can act as a control surface over multiple underlying agent CLIs. A T3 session should not make T3 itself synonymous with Codex or Claude.

Session-host adapters should exist only where a product exposes a stable automation boundary sufficient to create, observe, steer, and stop sessions. Wayfinder should not screen-scrape or automate arbitrary desktop GUIs.

## Lane model

A lane is the durable unit of one piece of execution work.

Conceptually a lane owns:

```text
Lane
 |- ticket
 |- claim
 |- run
 |- workspace
 |- environment
 |- agent session
 |- optional session host
 |- services
 |- validation state
 |- review state
 `- event history
```

The lane is not merely a process. It survives individual process exits and can move through revision and review cycles without losing identity.

### Proposed lane state machine

```text
queued
  |
  v
preparing
  |
  v
running <---------------------------+
  |                                 |
  +--> blocked                      |
  |                                 |
  v                                 |
ready_for_validation                |
  |                                 |
  v                                 |
validating                          |
  |                                 |
  +--> revision_required -----------+
  |
  v
ready_for_review
  |
  v
reviewing
  |
  +--> revision_required -----------+
  |
  v
approved
  |
  v
human_ready
  |
  v
completed
```

`failed`, `attention_required`, and `recovery_required` remain explicit failure/recovery states rather than inferred success.

## Lane communication protocol

Agents should not coordinate by scraping each other's terminal output or by relying on prose alone.

Every lane should have a small, structured Wayfinder communication channel. A sandboxed worker can expose commands such as:

```text
wayfinder lane report ready
wayfinder lane report blocked --reason <text>
wayfinder lane service announce --name web --port 3000
wayfinder lane artifact add <path-or-reference>
```

The exact transport is implementation-specific, but the protocol should be stable and structured.

A completion report could contain:

```json
{
  "type": "lane.ready_for_validation",
  "lane": "WF-142",
  "commit": "abc123",
  "summary": "Implemented the requested behavior",
  "checks": {
    "test": "passed",
    "typecheck": "passed"
  }
}
```

Prose may accompany the event, but machine lifecycle transitions are driven by typed events.

### Scoped lane authority

Each lane should receive a distinct capability credential. A worker should be able to:

- read its own ticket/context;
- report its own state;
- attach its own artifacts;
- announce its own services; and
- receive revision messages for its own lane.

A worker should not automatically be able to:

- mutate another lane;
- create or destroy arbitrary sandboxes;
- change global policy;
- merge code;
- release another claim; or
- use tracker/GitHub write APIs unless explicitly granted.

## Control plane and orchestrator

The orchestrator agent is a decision-maker, not the durable runtime.

The recommended model is:

```text
T3/Herdr/terminal orchestrator session
              |
              v
        Wayfinder daemon
              |
         active lanes
```

Wayfinder should provide a durable per-user supervisor/daemon process (for example, a future `wayfinder supervisor serve`) that owns:

- the SQLite state store;
- lane scheduling;
- process/environment identities;
- heartbeats and observations;
- event subscriptions;
- resource admission;
- recovery; and
- lifecycle transitions that do not require model judgment.

The orchestrator agent subscribes to this state and makes higher-level decisions such as selecting revision instructions, deciding whether to request another review, or escalating to a human.

## Strong isolation and sandbox clone mode

For autonomous workers, the preferred strong-isolation endpoint is a sandbox-private clone with no writable visibility into the host repository.

Conceptually:

```text
host repository
     |
     | read-only source / clone seed
     v
+--------------------------+
| lane sandbox             |
|                          |
| private clone            |
| wayfinder/<ticket>       |
| agent runtime            |
| local containers         |
+-------------+------------+
              |
              v
      reviewed change/ref
```

When clone isolation is selected, Wayfinder should not also create a host worktree for that lane. Workspace isolation belongs in one strategy or the other.

Host worktrees remain appropriate for:

- no-sandbox mode;
- trusted/manual agent work;
- lightweight local operation; and
- environments where strong sandbox clone support is unavailable.

## Human inspection and editors

Editors are not runtime infrastructure and should remain unopinionated.

Wayfinder should support human inspection without requiring a specific editor.

### MVP inspection

Provide portable commands such as:

```text
wayfinder lane status <lane>
wayfinder lane diff <lane>
wayfinder lane logs <lane>
```

These should work whether the code lives in a host worktree or only inside a sandbox clone.

### Optional editor launch

A later convenience command may materialize a disposable review checkout/snapshot and launch a user-configured editor command:

```text
wayfinder lane inspect WF-142 --editor zed
```

Wayfinder need only understand "run this configured editor command on this review directory." Deep editor-specific APIs are optional integrations, not core dependencies.

## Project environment contract

A fresh checkout/workspace is not useful until it can actually build, test, and run.

The repository should therefore declare a Wayfinder-owned, provider-neutral project environment contract. For example:

```yaml
# .wayfinder/project.yaml
setup:
  install:
    - bun install
  prepare:
    - bun run generate

checks:
  fast:
    - bun run typecheck
    - bun test

services:
  api:
    command: bun run dev:api --host 0.0.0.0
    port: 3001
    health:
      path: /health

network:
  profile: development

resources:
  estimatedMemory: 2GB
  estimatedCpu: 1
```

Wayfinder owns this abstract schema. A runtime adapter translates it into Docker Sandbox primitives, host processes, remote workers, or future providers.

Do not make Docker Kit YAML, devcontainer JSON, Compose, or another provider format the normative Wayfinder contract. Those can be translation targets.

## Development topology providers

Complex monorepos and microservice systems need an additional extension point: a development-topology provider.

This answers:

> For this lane and project, which services must run locally, which may remain hosted, what routing is required, and what credentials/network capabilities are needed?

Wayfinder core should not contain product-specific gateway or microservice knowledge.

A topology provider may return a plan such as:

```json
{
  "localServices": ["payments"],
  "remoteServices": ["users", "orders", "search"],
  "requiredPorts": [3001],
  "environment": {
    "GATEWAY_URL": "<resolved-runtime-value>"
  },
  "credentialHandles": ["dev-environment-session"],
  "networkAllow": ["dev.example.internal"]
}
```

The selected environment adapter then realizes the plan.

This allows a 12-service system to develop only one local service while routing the remaining dependencies to a hosted development environment instead of reproducing the entire stack in every lane.

## Services and host port exposure

Services are first-class lane state.

A project may declare a service at an internal port such as `3000`. The runtime adapter should map it to a collision-free host endpoint and persist the result:

```text
Lane WF-142
  web -> http://127.0.0.1:49318
  api -> http://127.0.0.1:49319
```

Parallel lanes should not need fixed host ports.

Wayfinder should detect and explain the common failure where a server binds only to sandbox loopback rather than an externally reachable interface.

## Credentials and least privilege

Credential policy should be capability-based and default-deny.

Agents often need Git repository content without needing GitHub project-management authority.

Recommended privilege tiers:

```text
Tier 0  local repository only; no remote write
Tier 1  Git fetch/read; no push
Tier 2  scoped push to the lane branch
Tier 3  tracker/GitHub API write capabilities by explicit policy
```

An implementation agent should not receive issue-close, label-edit, merge, or arbitrary repository-write authority simply because it needs to modify code.

Secrets should cross boundaries only through credential-provider handles, scoped environment injection, or host-side credential proxies. Secret values must not appear in ordinary configuration, command arguments, logs, or receipts.

The host-side Wayfinder control plane should perform privileged tracker mutations after policy checks and validation wherever practical.

## Network policy

Network perimeter preferences should be globally configurable and project-overridable.

Example conceptual configuration:

```yaml
networkProfiles:
  locked:
    default: deny

  web-development:
    extends: locked
    allow:
      - github.com
      - api.github.com
      - registry.npmjs.org

  company-development:
    extends: web-development
    allow:
      - dev-api.example.internal

defaults:
  networkProfile: web-development
```

Wayfinder owns the abstract policy and the environment adapter implements it using the selected runtime's native controls.

## Layered configuration

Configuration precedence should remain explicit and deterministic:

```text
built-in defaults
      |
      v
user-global config
      |
      v
project config
      |
      v
map/ticket policy
      |
      v
invocation overrides
```

Global configuration should allow a user to set defaults once, including:

- preferred tracker/account;
- preferred agent;
- preferred session host;
- preferred environment/isolation provider;
- network profile;
- credential-provider handles;
- concurrency limits;
- default resource policy;
- review policy; and
- editor command.

A project can narrow or extend those defaults, and an explicit invocation remains highest precedence.

The desired UX is that `wayfinder pickup <ticket>` resolves all of these choices without requiring users to understand sandbox proxies, VM internals, port mappings, or credential mechanics.

## Resource model

Strong isolation must not imply unlimited parallelism.

A sandbox/microVM may be more expensive than a plain process or ordinary container because it owns additional runtime/kernel state. Wayfinder should therefore treat resource admission as a core responsibility.

### User-visible limits

Example:

```yaml
resources:
  reserveHostMemory: 4GB
  reserveHostCpu: 2
  maxParallelLanes: auto

  laneDefaults:
    cpu: 2
    memory: 3GB

  reviewLane:
    cpu: 1
    memory: 2GB
```

`auto` should use conservative admission, not optimistic oversubscription.

For an 8-core / 16 GB machine, Wayfinder might reserve host capacity and recommend only one or two heavy lanes rather than launching four sandboxes plus local databases and forcing the machine into swap.

### Queue rather than oversubscribe

If five tickets are available but resources safely permit two active lanes:

```text
2 running
3 queued
```

The scheduler should admit the next lane as resources become available.

### Reuse lane environments

A sandbox should normally persist for the lane's implementation/revision lifecycle:

```text
create sandbox
  -> setup once
  -> implement
  -> validate
  -> revision
  -> validate
  -> review
  -> approve
  -> destroy
```

Do not reinstall the entire project for every agent turn.

### Run the minimum required topology

A lane should not recreate production by default.

For a microservice system, the expected pattern is:

```text
lane sandbox
  local service under development
  optional local database
  local gateway/proxy
       |
       v
hosted development services
```

Project/topology metadata should drive this minimum runnable environment.

## Review architecture

Automated validation and model review are different stages.

### Deterministic validation first

Run project-declared checks such as:

- unit tests;
- type checking;
- linting;
- focused integration tests; and
- service health checks.

These do not require another agent.

### Independent review agent

When configured, a reviewer should receive an immutable/checkpointed version of the implementation and independently inspect it.

The reviewer should not automatically share the implementation agent's mutable environment, secret material, or conversational context.

Review result is structured:

```text
approved
```

or:

```text
revision_required
  findings: [...]
```

A revision result routes back to the original lane while preserving the same lane identity.

## Agent runtime and model endpoint separation

Wayfinder should not assume one hard-coded model provider per coding agent.

Model these concepts separately when supported:

```text
Agent runtime
  Codex
  Claude Code
  OpenCode
  Pi

Model endpoint
  OpenAI
  Anthropic
  OpenRouter
  local inference
  future providers
```

Capabilities determine whether a given agent supports model selection, endpoint selection, reasoning configuration, or other options.

Wayfinder cares whether the requested combination is supported and reachable; it should not care whether inference ultimately runs in a cloud provider or on a local GPU.

## Session-host support policy

### Must support: native process

This is the portable baseline and lowest-complexity execution path.

### High-priority: T3 Code

T3 is valuable as a persistent multi-agent control surface. Integrate through a stable programmatic server/session API, not UI automation.

### High-priority/community-friendly: Herdr

Herdr's long-running process/session model aligns well with Wayfinder where platform support is available.

### Optional: tmux

Tmux can provide persistence, but Wayfinder must still own semantic lane state because tmux only knows process/terminal state.

### Not an initial target: arbitrary desktop apps

Do not build brittle integrations for Codex desktop, Claude desktop, editors, or other GUIs unless they expose stable automation contracts for session lifecycle.

## Cross-platform strategy

Wayfinder core remains portable. Platform-specific behavior is pushed toward adapters and capability probes.

Every environment/runtime must preflight actual capability rather than assuming support from OS name alone.

A Docker Sandbox preflight, for example, may check:

- Docker availability;
- sandbox CLI/runtime availability;
- architecture support;
- virtualization/KVM/WSL requirements;
- authentication state;
- clone-mode capability; and
- required network/credential features.

If strong isolation is unavailable, Wayfinder should either guide installation or explicitly offer a configured fallback such as host execution. It must never silently downgrade an explicitly required security policy.

A sandbox also acts as a useful platform-normalization boundary: project setup commands can target the sandbox's known environment instead of maintaining separate Windows/macOS/Linux build recipes.

## Update policy

Wayfinder should preserve its current conservative distribution behavior:

- standalone signed/checksummed release artifacts;
- update availability notices only;
- no silent binary replacement;
- stable machine stdout;
- explicit opt-out of update checks; and
- an eventual explicit `wayfinder update` command if desired.

Because Wayfinder coordinates code execution, credentials, sandboxes, and tracker mutations, automatic unattended self-update should not be the default.

## MVP sequence

The architecture should be implemented incrementally without prematurely building every integration.

### MVP 1: lane protocol

Add the durable lane state machine and structured lane events.

Initial surfaces:

```text
lane start
lane status
lane report
lane message
lane stop
lane diff
lane logs
```

### MVP 2: durable control plane

Introduce a long-running supervisor/daemon mode that owns lane state, event subscriptions, scheduling, observations, and recovery.

### MVP 3: separate invocation from execution

Refactor current harness launching so an agent adapter describes an invocation and an environment/session-host executes it.

Implement `host` as the first environment adapter with no behavior regression.

### MVP 4: Docker Sandbox environment

Implement:

- doctor/preflight;
- create/start/resume/stop;
- private clone workspace strategy;
- network policy;
- scoped credentials;
- service/port exposure;
- resource limits;
- logs and readiness; and
- cleanup/recovery.

One sandbox per active lane is the initial model.

### MVP 5: project recipe

Add the provider-neutral project environment contract with only:

- setup commands;
- checks;
- services;
- required network policy; and
- resource estimates.

### MVP 6: T3 session host

Add a T3 adapter against its stable programmatic lifecycle boundary after the generic lane protocol is working.

### MVP 7: reviewer

Add deterministic validation first, then optional independent reviewer lanes.

## Explicit non-MVP scope

Design seams for these but do not require them for initial product validation:

- hybrid local/hosted microservice topology implementation;
- Kubernetes;
- arbitrary remote workers;
- deep editor-specific integrations;
- automation of desktop-only agent GUIs;
- multi-agent consensus/debate systems;
- automatic merge;
- default GitHub/tracker write access for worker agents;
- sophisticated dynamic resource scheduling;
- multiple sandbox providers; and
- automatic local-model provisioning.

## North-star user experience

The intended end state should feel simple:

```text
$ wayfinder pickup WF-142

Ticket:          WF-142
Agent:           Codex
Session host:    T3 Code
Isolation:       Docker Sandbox / clone
Network:         company-development
Workspace:       private clone
Resources:       2 CPU / 3 GB
Setup:           bun install
Services:        api
Validation:      test, typecheck
Review:          required

Preparing lane...
✓ sandbox created
✓ credentials configured
✓ dependencies installed
✓ service ready
✓ session created
✓ agent started

Lane WF-142 running
API: http://localhost:49381
```

Later:

```text
WF-142 -> ready_for_validation
✓ tests
✓ typecheck
-> reviewer started
✓ reviewer approved

Ready for human review.
```

The complexity exists, but Wayfinder owns it so the user does not need to understand every runtime primitive.

## Architectural principle

The compact summary is:

> Agents decide. Wayfinder coordinates. Environments contain. Session hosts present. Trackers persist product truth. Humans retain authority.
