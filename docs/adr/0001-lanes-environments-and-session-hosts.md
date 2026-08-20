# ADR 0001: Lanes, environments, and session hosts

Status: Accepted design direction

Date: 2026-08-19

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

Wayfinder will evolve toward a durable per-user supervisor/daemon that owns active lane state, scheduling, observations, event subscriptions, resource admission, and recovery.

T3 Code, Herdr, a terminal, or another client can act as a control surface over that state, but closing that surface must not implicitly terminate or forget active lanes.

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

### 5. `host` is an explicit environment

Host execution is modeled as an environment implementation, not as the absence of an environment. This keeps environment selection uniform and avoids special-case logic throughout the core.

### 6. Autonomous lanes prefer sandbox-private clone isolation

For strong autonomous isolation, the preferred endpoint is a private repository clone inside the lane's sandbox with no writable access to the host repository.

When sandbox clone mode is selected, Wayfinder should not also create a host worktree for the same lane. Host worktrees and sandbox clones are alternative workspace strategies.

Host worktrees remain supported for trusted/manual execution and systems without strong sandbox support.

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
2. Add a durable supervisor/daemon mode.
3. Separate agent invocation from execution.
4. Implement `host` as an explicit environment.
5. Add a Docker Sandbox environment with sandbox-private clone mode.
6. Add a provider-neutral project recipe.
7. Add T3 Code as a session-host integration against a stable programmatic API.
8. Add deterministic validation and optional independent review lanes.

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
