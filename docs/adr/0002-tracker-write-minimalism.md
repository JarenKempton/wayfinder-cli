# ADR 0002: Tracker write minimalism

Status: Accepted

Date: 2026-08-22

Ratified under JWB-387 ("Decide whether the Wayfinder resolution transaction still requires posting a comment").

Supersedes the comment requirement in Non-Negotiable #12 of the runtime contract.

## Context

JWB-387 was raised on the premise that Non-Negotiable #12 requires a posted resolution comment as a mandatory step of every resolution transaction across all trackers, and that the four shipped adapters implement that today.

Reading the code before deciding showed the premise was inaccurate, in a way that changes the work:

- The Jira, Linear, and GitHub adapters are read-only. `jiraCapabilities()` advertises only `native_maps` and `native_dependencies`; `addComment()` exists but immediately fails closed through `#mutationUnavailable()`. Wayfinder CLI has never written a comment to a hosted tracker and structurally cannot.
- Only the Markdown tracker implements the requirement. It advertises `resolution_comments`, hard-throws `"A resolution comment is required before close"`, and appends `Resolution: <text>` to the ticket's comment list.
- `resolution_comments` and `artifact_links` are already distinct, separately negotiated entries in `CAPABILITIES`. Nothing in the protocol forces a comment, and linking an artifact is already independent from narrating one.

Meanwhile the actual comment volume on the live Jira board came from two sources outside the CLI:

1. The `wf` pickup transaction marker (`wfcli/jira.py`), posted on every claim. This is **load-bearing**: `transaction_owned()` reads the marker back as ownership proof, and `guarded_rollback()` refuses to roll back a claim it cannot prove it owns. It is a workaround for Jira exposing no compare-and-set across assignment, transition, and properties.
2. The lane role prompt instruction `"Post a resolution comment when resolving a ticket."`, which produced multi-paragraph implementation summaries, acceptance-criteria walkthroughs, and test-gate reports on tickets whose pull request already contained all of it.

These are opposite problems. The first is necessary machinery stored in the wrong place. The second is narrative that should not be written at all.

## Decision

### 1. Tracker records are structured state, not narrative

A tracker ticket holds the context of the work: its scope, its acceptance criteria, and its own tracker-native fields — status, priority, assignee, links, dependencies.

An item inside a map describes only its own specific context. Context available from the parent map is inherited and is not restated on the child.

Resolution findings, implementation summaries, progress updates, and test evidence do not belong in ticket descriptions. Wayfinder never rewrites a description to record an outcome.

The auditable record of a resolution is the **linked artifact** — the pull request, prototype, or research document — through the existing `artifact_links` capability. The artifact already contains the detail; duplicating it into the tracker creates two sources that drift.

### 2. Non-Negotiable #12 no longer requires a comment

The resolution transaction requires a resolved state and a linked artifact. It does not require a posted comment on any tracker.

`resolution_comments` remains a valid, protocol-stable capability, but it is **off by default**. An adapter must not advertise it unless configuration enables it. The Markdown tracker's hard requirement that a resolution comment exist before close is removed; a resolution with an artifact and no comment is valid.

This applies to all trackers, not only to adapters lacking a native comment concept. It is not retroactively a change for Jira, Linear, or GitHub, which never implemented the behavior.

### 3. Agents do not narrate into the tracker

Lane role prompts must not instruct an agent to post a resolution comment. A lane links its artifact and closes; it does not summarize itself into the ticket.

Where a lane needs to communicate something the artifact cannot carry — a blocker, an unsafe-to-resolve condition, a question — it does so through the tracker's structured mechanism for that, or it stops and asks a human. That is a different act from narrating a completed resolution.

### 4. Claim ownership moves to structured storage

The claim/transaction marker is machinery, not content, and it is not subject to the comment configuration in decision 5. It must never be stored as a comment.

Claim ownership is recorded in tracker-native structured storage. On Jira this is the issue property already named in `JiraTrackerAdapter` as `wayfinder.claim`. Ownership verification and guarded rollback read that property rather than scanning comment bodies.

This is strictly stronger than the comment mechanism it replaces: an issue property is not editable in the normal ticket UI, so a human cannot accidentally invalidate a claim proof mid-run.

An adapter whose tracker offers no such structured storage must fail closed on claim rather than fall back to writing a comment.

### 5. Comment policy is enforced organization policy, not personal preference

Whether Wayfinder writes tracker comments is an **organization policy key**, not a preference. It must have one value across everyone contributing to that organization's work. If two contributors resolve tickets under different comment settings, the board's history becomes inconsistent for reasons unrelated to the work.

The setting is therefore resolved through the enforced organization-policy layer defined in ADR 0003, not through the ordinary preference chain. The organization pins one value; user-global, project, map, and invocation layers cannot override it, and an attempt to override fails loud.

The built-in default, absent any organization policy, is off.

Per ADR 0003 the value is served by the tracker adapter, so it arrives with the tracker connection Wayfinder already requires and needs no separate configuration step. Where a tracker cannot serve policy, the built-in default of off applies and `doctor` reports that the tracker governs nothing.

A host application — for example Product Pipeline settings — may present a permission-gated surface for editing this key. It does so as that tracker's adapter, not as a source Wayfinder depends on. An admin toggle affecting only one installation would reintroduce exactly the divergence this decision prevents.

## Consequences

### Positive

- Tickets stay scannable. Status, priority, and links carry the state; the artifact carries the detail.
- One source of truth per fact. Resolution detail lives in the pull request, not in a copy that drifts.
- Claim safety improves. A property is stronger ownership proof than a comment a human can edit.
- Organizations that want comments can have them without a protocol change, because the capability already exists.
- No retroactive adapter work for Jira, Linear, or GitHub, which already behave correctly.

### Costs

- The `wf` claim path and its rollback guard must migrate from comment scanning to property reads, with care: this is the mechanism that prevents two lanes claiming one ticket.
- In-flight lanes claimed under the comment marker need a migration or a drain before the property becomes authoritative.
- The Markdown tracker's resolution contract and its tests change.
- Historical claim and resolution comments already on the board remain; this decision governs future writes and does not mandate a cleanup.

## Summary

> Trackers hold state. Artifacts hold detail. Machinery hides in structured storage. Wayfinder writes as little as it can and never narrates.
