# First-release acceptance and decision queue

Status: execution checklist derived from Jaren's September 9 direction discussion.
Unchecked criteria are required outcomes, not claims of implemented behavior.
Proposed command names and schema examples in other notes are not frozen APIs.

## Selected milestone

Reliable single-ticket pickup, inspection, and reconnection through T3.
Automatic map progression follows. Preserve map scope and provider boundaries.

## Acceptance criteria from agreed direction

- [ ] Given a selected ticket, pickup resolves one explicit tracker, repository,
  workspace, environment, session host and agent configuration; the resolved
  plan is human-readable before execution and available as structured data.
- [ ] Given an unsupported execution combination or missing prerequisite,
  preflight explains the unmet requirement without starting an agent.
- [ ] Given a project setup recipe, preparation executes its authorized commands
  in order and their declared execution location. A failed step blocks agent
  launch and is identified in the result. Environment-file copying or secret
  retrieval is owned by project commands, not a duplicate variable inventory.
- [ ] Given a setting that follows project defaults, a new execution resolves
  the current default. An explicit personal override persists. Project-required
  preparation cannot disappear because personal settings were initialized earlier.
- [ ] Given an existing execution, configuration and instruction changes are
  adopted only at an explicit checkpoint with a recorded change; source and
  instruction/configuration identity are inspectable.
- [ ] Given a ticket or map reference, a human can inspect its frontier, active
  work and attention requests without supplying an internal run ID or asking an
  agent to interpret raw records. Multiple executions are distinguished explicitly.
- [ ] Given a managed T3 session, its environment/thread identity and reported
  model selection are verified and retained. Missing or contradictory evidence
  is not converted to success, ticket completion, or permission to duplicate work.
- [ ] Given map-scoped inspection, the result identifies that map's frontier.
  External dependency facts may be read without scheduling another map's work.
- [ ] Given a CLI action, its description and input/output contract have one
  authoritative definition used by command registration and generated help.
  Application handlers remain independent of terminal formatting and future MCP.

## Lifecycle behavior — explicitly selected by Jaren

- [ ] Given an existing recorded T3 session, reconnect opens the existing session
  and shows current state without sending an agent message or starting a turn.
- [ ] Given a missing or unreachable recorded session, preserve workspace and
  claim, explain the problem, and require explicit recovery before replacement.
- [ ] Given a stop request, stop the agent and verify the observed outcome;
  preserve workspace and Jira ownership. Release and cleanup are separate explicit
  actions. An unverified stop must remain uncertain, not reported as stopped.

Next question batches, after those answers: setup trust/failure/retry/cleanup;
project requirements versus override rules; optional PR workflow boundaries.
Ask only product behavior choices. Investigate technical mechanisms separately.

## Concrete work sequence

| Work | Current evidence | Next action |
| --- | --- | --- |
| JWB-488 T3 contract | PR #38 merged as 5cce9353; Jira Done; JWB-278 supersession recorded | Use merged source-qualified evidence |
| JWB-489 T3 adapter | PR #38 merged; lifecycle expectations now selected | Implement typed API validation and conformance against the selected reconnect/recovery/stop criteria; deliver tested draft PR |
| PR #32 invocation/runtime separation | Two capability/local-preflight defects reproduced | Revise existing work; do not assume argv is the universal T3 host interface |
| Jira ownership | Existing adapter rejects mutations; ticket assumes unsupported conditional semantics | Investigate a provable mechanism before enabling claims |
| Setup and action catalog | Direction captured; detailed schema not selected | Define the smallest implementation against this checklist, preserving existing public contract compatibility |
| Map daemon, PR automation, Docker | Not required by selected single-ticket milestone; Docker timing unresolved | Keep outside the immediate task scope |

No live acceptance actions, production changes, PR merges, or automatic ticket
claims are authorized by this checklist itself. Existing user authorization for
specific tasks is tracked in their scoped handoffs.
