# Wayfinder direction record — 2026-09-09

Status: conversation decision record for review; not an implemented specification.

Source: Jaren's design discussion on 2026-09-09 under JWB-150 and JWB-470.
Baseline inspected: standalone wayfinder-cli main at `1f31a96`. The Python `wf`
launcher in agent-skills is a separate implementation. No runtime changes are
made by this document. Existing ADR conflicts below require explicit reconciliation;
this record does not silently supersede them. Example field names and CLI verbs
discussed in chat are illustrative, not frozen public contracts.

## Agreed direction

### Selected first-release milestone

Jaren explicitly selected reliable single-ticket pickup, inspection, and
reconnection through T3. Automatic map progression follows in a later milestone.
Preserve map-scoped architecture, but do not make an unattended map controller
a prerequisite for this release. This selection resolves the single-ticket
versus automatic-map-progression question below; Docker timing remains open.

### Product boundary and integration

- Ship a local TypeScript/Bun CLI first. MCP is a future interface, not a required
  first-release server. Do not introduce internal RPC or hosted infrastructure
  just to support a possible future MCP wrapper.
- Define actions explicitly in a typed catalog: descriptions, input/output
  validation, CLI mapping, and application handlers. Generate help/reference
  material from that catalog. Future MCP exposure wraps the same operations;
  it must not duplicate orchestration logic or automatically expose every action.
- Keep tracker, workspace, environment, agent/harness, and session host distinct.
  T3 is the first supported session host. Other hosts must qualify against an
  explicit behavioral contract, not merely provide a terminal or executable.
- Docker Sandboxes are desired. Their inclusion in the first release is not
  settled; preserve the environment boundary without blocking all delivery on them.
- Human-readable status must work without an agent. Show each map's frontier,
  active work, and attention requests. A TUI/GUI may follow; it is not yet selected.
- Prefer ticket/map references in user-facing commands. Internal run identifiers
  support precise recovery and history; users should not have to memorize them.

### Orchestration scope

- A map owns its frontier and orchestration scope. Multiple maps may run in
  parallel with separate controllers and state. Do not merge them into one
  undifferentiated frontier.
- A ticket execution may span multiple sessions and revisions. Session completion
  is not ticket completion. Observed session state, workflow stage, and agent
  progress prose are distinct.
- SQLite persists execution identity, operations, observations, and recovery
  evidence. Tracker facts remain tracker-owned; host observations remain
  host-owned. Storing a state does not itself execute or verify an operation.
- The exact process topology is unresolved: logical map isolation does not
  necessarily require a separate operating-system daemon for every map.

### Instructions and workflow

- Markdown provides agent guidance, role instructions, and writing conventions.
  Deterministic operations enforce mechanical requirements and verified transitions.
  Avoid encoding the entire preferred PR workflow deeply into core orchestration.
- Keep workflow definitions identifiable and versioned. A workflow stage must
  belong to its definition; arbitrary agent prose must not trigger transitions.
- New sessions use updated shared instructions. Active sessions adopt changes at
  an explicit checkpoint with the change recorded.
- Make the instructions supplied to an execution inspectable. A receipt of loaded
  instructions is evidence of input, not proof that an agent obeyed them.
- PR behavior should be consistent under project configuration, including initial
  draft/ready state and title/body conventions. The actual initial state has NOT
  been chosen. Templates guide content; they do not prove prose quality.

### Project setup and personal choices

- Version-control project setup as ordered commands/scripts. Environment-file
  copying and secret-manager fetching belong in these steps. Do not require a
  duplicate inventory of individual environment variables in Wayfinder config.
- Invoke executables using argument arrays. A project may explicitly invoke a
  shell script; Wayfinder must not implicitly interpolate shell command text.
- Setup has documented context, including source checkout and destination
  workspace, and an explicit execution location. Container/remote paths must not
  be assumed to be local-host paths.
- Report failed steps and readiness. Do not launch work after failed preparation
  or blindly repeat partially completed setup after a crash.
- Jaren selected approval once per setup recipe and referenced script versions;
  recipe or script changes require renewed approval. A setup failure preserves
  the workspace and identifies the failed step; the human explicitly retries
  that step and subsequent steps. No automatic retry or workspace recreation.
- Separate project requirements, overridable project defaults, and personal
  choices. Store explicit personal overrides in local SQLite, not permanent
  copies of every project default.
- A setting may follow the current project default or retain an explicit local
  choice. Required setup must not become stale because a developer initialized
  before the project changed.
- Persist a resolved configuration and source/configuration identity for each
  execution. Existing work does not silently change when defaults change.
- Secret values stay out of committed config, process arguments, logs, and
  ordinary execution records. Recipes may refer to files or credential sources.

## Recorded PR workflow preferences — placement still unresolved

These preferences do NOT authorize putting a PR-review subsystem in the CLI core.
Jaren explicitly questioned that scope and prefers external reviewers.

- Bring the human in when tests, required reviews, and applicable UI evidence are
  ready. Escalate blockers or repeated revisions earlier.
- Jaren approves every merge in the initial workflow.
- Prefer external review services, keeping the provider replaceable. Local
  reviewers are optional possibilities, not a requirement or selected fallback.
- Implementer disagreements require written rationale and reviewer reassessment.
  Escalate unresolved blocking disagreements.
- Escalate after three revision rounds by default, configurable, or sooner if blocked.
- If a required reviewer is unavailable, wait and notify after a configurable
  timeout; do not silently substitute another reviewer. Timing/channel unresolved.
- UI visual changes need screenshots; interactive flows need a short recording.
  Evidence is tied to the reviewed commit and represents implemented behavior.
- Review completion must refer to the current revision. Agreement between agents
  does not establish correctness. Approval, merge, and tracker Done are separate facts.

## Verified implementation gaps and conflicting instructions

1. `src/cli.ts` routes through a switch. pickup, resume, workspace, init, and config
   currently reject execution. A central action catalog is proposed work.
2. `src/lifecycle.ts` has a per-user supervisor lock and iterates active runs; it
   is not a map-scoped workflow orchestrator. `src/frontier.ts` already supports
   scoped selection with dependency facts outside the selected scope.
3. Runtime separation PR #32 (JWB-327) and lane-store PR #34 (JWB-326) remain open
   despite Done tickets. PR #34 has a failed Windows check in the inspected CI.
   Review and integrate existing work before building competing abstractions.
4. Jira mutations in `src/jira.ts` fail closed. JWB-490 assumes a timestamp-based
   conditional claim. Structured property storage alone does not prove exclusive
   ownership. The mechanism needs technical validation before implementation.
5. ADR 0002 turns comments off by default; current Markdown tracker still requires
   a resolution comment, and JWB-493 asks for comments on supervisor transitions.
6. ADR 0003 makes the tracker the exclusive enforced-organization-policy source.
   Repository-owned setup/contribution requirements and their interaction with
   that policy must be distinguished explicitly. Current resolvers lack enforcement.
7. `docs/environment-boundary.md` delegates application setup to opaque profiles;
   ADR 0001 also proposes a provider-neutral recipe. Reconcile application setup
   versus execution isolation and define recipe ownership before inventing a schema.
8. Existing run storage and the proposed lane store need one explicit relationship
   and authority model. Do not create competing session-state authorities.
9. T3 research JWB-278 needs updating through JWB-488. Python wf demonstrated a
   local T3 launch; that is not blanket proof of all managed-host capabilities.
10. JWB-470 children contain copied application-handler refactoring instructions
    that do not apply to CLI work. Proposed task guidance needs cleanup.

## Open decisions — do not fill these in by assumption

| Area | What remains to decide | Next responsibility |
| --- | --- | --- |
| Docker timing | Single-ticket T3 release is selected; whether Docker ships with it remains open | Present qualification evidence and delivery impact for Jaren |
| Review workflow placement | Separate installable integration versus optional built-in workflow | Present tradeoffs for Jaren |
| PR lifecycle | Initial draft/ready state, creation timing, promotion trigger, Done mapping | Jaren preference plus reviewer compatibility check |
| Workflow definition | Minimal structured gates versus Markdown guidance; supported initial stages | Propose small contract with examples |
| Host qualification | Exact minimum operations, observation semantics, follow-up/interrupt guarantees | Verify T3; build conformance criteria |
| Jira ownership/auth | Proven concurrency mechanism and per-developer credential integration | Technical investigation before asking for mechanism choice |
| Setup safety/recovery | Trust authorization, source revision, timeouts, retry/resume, cleanup, host/container step location | Propose deterministic semantics |
| Configuration authority | Project-required versus default keys, allowed overrides, tracker policy conflicts | Reconcile ADRs and propose explicit rules |
| Orchestration process | Map leases, restart recovery, shared machine resource limits, process packaging | Technical proposal preserving map isolation |
| Instruction delivery | Source locations, precedence, packaging, update receipts | Audit current steering files; avoid duplicate authority |
| Attention delivery | Default timeout, destination, notification authorization | Jaren choice when integration is scoped |

## Next implementation-planning artifact

Produce a requirement-to-code/PR matrix with each item marked implemented,
required-for-selected-milestone, deferred, or unresolved. Reconcile ADRs and
ticket dependencies using that matrix. Do not treat Done tickets, proposed
interfaces, or this discussion record as evidence of working capabilities.

References: [JWB-470](https://responsibid.atlassian.net/browse/JWB-470),
[runtime separation PR #32](https://github.com/JarenKempton/wayfinder-cli/pull/32),
[lane state PR #34](https://github.com/JarenKempton/wayfinder-cli/pull/34),
[ADR 0001](adr/0001-lanes-environments-and-session-hosts.md),
[ADR 0002](adr/0002-tracker-write-minimalism.md),
[ADR 0003](adr/0003-organization-policy-and-enforced-configuration.md).
