# ADR 0001: Lanes, environments, and session hosts

Status: Accepted

Date: 2026-08-19

Ratified: 2026-08-22 under JWB-324 ("Set the execution model for durable agent lanes").

## Context

Wayfinder is evolving from a portable ticket-to-agent launcher into a durable orchestration layer for parallel coding-agent work.

The product must support multiple trackers, multiple coding agents and model providers, optional strong isolation, persistent sessions and human steering, deterministic workspace preparation, resource-aware parallel lanes, automated validation and independent review, macOS/Linux/Windows, and future execution environments that do not exist yet.

Several concepts are easy to collapse together prematurely:

- a coding agent such as Codex or Claude Code;
- a session host such as T3 Code, Herdr, tmux, or a native process;
- an execution environment such as the host or a Docker Sandbox;
- a workspace strategy such as a host Git worktree or a sandbox-private clone; and
- an orchestrator conversation that makes decisions about active work.

If these concepts become coupled, adding isolation or a new session host would require rewriting agent adapters, and a UI/session failure could orphan active work.

## Decision

### 1. Wayfinder owns durable lane coordination

A **lane** is the durable execution unit for one selected ticket. A lane may include a claim, run, workspace, environment, agent session, session host, services, validation state, review state, and event history.

Wayfinder owns lane state transitions and persists them independently from any individual agent conversation or UI session. An orchestrator agent may decide what should happen next, but its conversation history is never the source of execution truth.

### 2. The host-side Wayfinder control plane survives session-host failure

Durable lane state lives in a re-attachable local store, not in a running process. Wayfinder does **not** require a daemon: any invocation re-attaches to that store, so closing a control surface never terminates or forgets active lanes.

A per-user supervisor process is **optional** and exists for one purpose — driving unattended lanes that must make progress while no control surface is attached. For those lanes it owns scheduling, observations, event subscriptions, resource admission, and recovery. Attended lanes run without it.

T3 Code, Herdr, a terminal, or another client can act as a control surface over the durable store, but closing that surface must not implicitly terminate or forget active lanes.

### 3. Agent runtime, session host, environment, and workspace are separate abstractions

Wayfinder keeps these responsibilities independent:

- **Tracker adapter** — vendor mechanics for issue/project systems.
- **Workspace adapter** — where editable source state comes from.
- **Environment adapter** — where execution occurs and what isolation/policy boundary applies.
- **Agent adapter** — how an agent is invoked and what semantic capabilities it supports.
- **Session-host adapter** — what owns the long-running interactive process/session and how it is observed or steered.

A T3 Code integration therefore does not make T3 synonymous with Codex, Claude, OpenCode, or another underlying agent.

### 4. Agent adapters describe invocation; environments/session hosts execute it

The current direct-process harness pattern should evolve so an agent adapter produces an invocation rather than directly owning host process creation.

```text
AgentAdapter -> AgentInvocation -> Environment/SessionHost -> ExecutionReceipt
```

This allows the same Codex/Claude/OpenCode/Pi adapter to run directly on the host, inside a Docker Sandbox, inside a persistent session host, or on a future remote runtime.

### 5. `local-host` is an explicit environment, and there is no implicit fallback

Host execution is modeled as an environment implementation named `local-host`, not as the absence of an environment. This keeps environment selection uniform and avoids special-case logic throughout the core.

A lane must name its environment. An unnamed or unresolvable environment fails closed; it never silently drops to bare-host execution. This is the same fail-loud rule as §8, applied at selection time rather than only at downgrade time.

### 6. Autonomous lanes prefer sandbox-private clone isolation

For strong autonomous isolation, the preferred endpoint is a private repository clone inside the lane's sandbox with no writable access to the host repository.

When sandbox clone mode is selected, Wayfinder should not also create a host worktree for the same lane. Host worktrees and sandbox clones are alternative workspace strategies.

Host worktrees remain supported for trusted/manual execution and systems without strong sandbox support.

#### The agent process runs inside the sandbox

When a sandbox environment is selected, the agent runtime process itself starts **inside** the container. The environment entrypoint launches the harness, which reads, edits, and runs tests entirely within the container filesystem.

Running the harness on the host and reaching in with per-command `docker exec` is explicitly rejected. That pattern leaves the agent's file access and reasoning on the host and reduces the container to a command runner, which is cosmetic isolation rather than real isolation.

A contained agent reaches the outside world through one narrow channel: a stdio/RPC bridge that the session host attaches to. That bridge is the isolation boundary. Model inference, scoped Git push, and tracker writes are the only outbound traffic a lane needs, and each remains separately grantable under §11.

A session host that cannot launch a process inside the requested container fails loud (§8). It does not fall back to host-side exec.

### 7. Project setup is declarative and provider-neutral

Repositories may declare a Wayfinder-owned project environment contract describing dependency installation, generated/preparation steps, validation checks, runnable services and health checks, network requirements, and resource estimates.

Wayfinder owns the schema. Docker Kits, Compose, devcontainers, shell commands, and future runtime formats are translation targets rather than the normative project contract.

### 8. Resources and security policies are resolved hierarchically

Configuration resolves from low to high precedence:

```text
built-in defaults
user-global configuration
project configuration
map/ticket policy
invocation overrides
```

Users may establish defaults for isolation, session host, agent, model, network policy, credentials, resource limits, concurrency, review policy, and editor command.

An explicit requirement for strong isolation must never silently downgrade to host execution.

### 9. Resource admission is a core responsibility

Wayfinder does not blindly start every eligible lane. The scheduler must respect configured concurrency and resource budgets. Excess work remains queued instead of oversubscribing CPU/RAM.

Lane environments should normally be reused through implementation, validation, revision, and review cycles rather than rebuilt for every agent turn.

### 10. Agents communicate through a structured lane protocol

Agent-to-orchestrator coordination uses typed Wayfinder lane events rather than terminal scraping or prose-only messages.

Examples include ready for validation, blocked, service announced, artifact produced, revision requested, and review approved.

Each lane receives only the scoped authority necessary to report and operate on itself.

### 11. Least privilege is the default

Implementation agents should not automatically receive GitHub/tracker mutation authority merely because they need source code.

Git read/fetch, scoped branch push, tracker writes, merge authority, and other capabilities are separately grantable. Privileged tracker actions should remain host-side where practical.

### 12. Editors are optional presentation tools

Wayfinder does not require Zed, VS Code, or another editor.

Human inspection starts with portable lane diff/status/log operations. Editor launching may be a convenience command over a disposable review checkout or provider-supported remote workspace.

### 13. Complex local/hosted service topology is extensible, not core-specific

Wayfinder may support a development-topology provider that describes which services run locally, which remain hosted, routing/environment requirements, credentials, and network allowances.

Product-specific gateway and microservice behavior does not belong in portable Wayfinder core.

### 14. Capabilities are provisioned at onboarding, not negotiated at runtime

Docker sandboxing, each session host, and each agent runtime are capabilities a user provisions during onboarding (the reserved `init` / `config` verbs). A capability that has not been provisioned is not selectable: it does not appear as an option, and configuration naming it is rejected at resolution time.

Runtime capability checks remain as a **backstop** for a provisioned capability that has since become unavailable — Docker daemon stopped, harness uninstalled. That backstop fails loud (§8). It is not the primary gate, and it never silently substitutes a weaker capability.

This puts capability availability in front of the user at setup time, where it is actionable, rather than mid-lane where it is only a failure.

### 15. Workspace handles resolve in the environment's frame of reference

The plan request passes workspace handles to the environment adapter. A handle is a path **in the environment's own frame of reference**, not necessarily a path on the host filesystem:

- `local-host` — the host path (identity).
- `docker` — the mount point inside the container.
- `remote` / `remote+docker` — a path on the remote machine, which that adapter materializes.

This makes local, containerized, and remote execution peer implementations of the same seven-verb environment contract (`preflight`, `plan`, `start`, `verifyReady`, `logs`, `resume`, `stop`) rather than structurally different cases.

No remote adapter ships in the initial MVP. The wording exists now so that adding one later is a new adapter rather than a change to the workspace and environment seams.

## Consequences

### Positive

- Agent integrations remain reusable across host and sandbox execution.
- T3 Code, Herdr, tmux, and future session hosts can coexist.
- UI/session crashes do not become coordination failures.
- Strong isolation does not force every user into the same execution strategy.
- Resource limits can protect small developer machines.
- Project setup stays portable across runtime providers.
- Review and human intervention remain independent from agent runtime implementation.
- New runtimes or remote workers can be introduced without redefining ticket/claim semantics.

### Costs

- A dedicated lane protocol and durable control plane add implementation work before richer multi-agent behavior.
- Separating invocation from execution requires refactoring the current harness adapters.
- Session-host adapters need capability negotiation and reliable lifecycle observation.
- Strong sandbox clone mode complicates live inspection compared with a writable host worktree.
- Resource-aware scheduling adds policy and admission behavior that must be tested across platforms.

## Initial implementation sequence

1. Define the lane state machine and structured lane events.
2. Add the durable re-attachable lane store, plus optional supervisor mode for unattended lanes.
3. Separate agent invocation from execution.
4. Implement `local-host` as an explicit environment.
5. Add T3 Code as a session-host integration against a stable programmatic API, launching against the host filesystem.
6. Add a Docker Sandbox environment with sandbox-private clone mode and in-container agent launch, as a launch mode on an already-working session host.
7. Add a provider-neutral project recipe.
8. Add deterministic validation and optional independent review lanes.

Sandboxing follows the session host rather than preceding it. Under §6 the sandbox launch mode is defined as *the session host starting the agent process inside the container*, so there must first be a session host that can launch a lane process at all. T3 Code currently advertises no `process_launch` and no `visible_multi_session` capability, so step 5 is a prerequisite for step 6 rather than an independent track.

## Non-goals for the initial MVP

- Kubernetes orchestration.
- Deep editor-specific integrations.
- Automation of desktop-only coding-agent GUIs without stable APIs.
- Multi-agent consensus/debate systems.
- Automatic merge.
- Default GitHub/tracker write access for worker agents.
- Sophisticated resource optimization beyond conservative admission/queueing.
- Multiple sandbox providers.
- Automatic local-model provisioning.

## Summary

> Agents decide. Wayfinder coordinates. Environments contain. Session hosts present. Trackers persist product truth. Humans retain authority.
