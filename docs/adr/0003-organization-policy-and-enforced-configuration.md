# ADR 0003: Organization policy and enforced configuration

Status: Accepted

Date: 2026-08-22

Ratified under JWB-387. Amends the configuration precedence chain in ADR 0001 §8.

## Context

ADR 0001 §8 defines one linear precedence chain in which every layer overwrites the one below it. The only implemented resolver, `resolveEnvironmentSettings` in `src/execution/environment.ts`, is a naive last-wins fold with no notion of a value that cannot be overridden.

That model is correct for preferences and wrong for policy, and the chain already contradicts a rule ADR 0001 asserts. §8 states that "an explicit requirement for strong isolation must never silently downgrade to host execution", but `invocation overrides` sits at the top of the chain, so any individual invocation can override precisely that. The chain cannot express the rule it claims to enforce.

The same defect appears the moment more than one person contributes. If comment behavior, required isolation, or privilege grants resolve from each contributor's own configuration, the organization's tracker history and safety posture vary by whoever happened to run the lane. That divergence is silent and is only discovered afterwards.

Configuration therefore holds two kinds of setting that want opposite behavior:

- **Preferences** — agent, model, reasoning effort, editor, concurrency, local paths. These *should* vary per person. Last-wins is correct.
- **Policy** — whether tracker comments are written, what isolation a lane requires, which privileges a lane receives. These must *not* vary per person. Last-wins is exactly wrong.

An earlier draft of this ADR proposed a dedicated policy repository referenced by a pointer file committed into every other repository, plus a machine-level organization declaration to prevent redirection. That was rejected during review: it invents a second identity and distribution system alongside one Wayfinder already has, it puts a policy artifact in every repository when policy is not a property of a repository, and it forces a new and unexplainable step into onboarding.

## Decision

### 1. An organization-policy layer sits above invocation overrides

The precedence chain gains a top layer, listed highest first:

```text
enforced organization policy
invocation overrides
map/ticket policy
project configuration
user-global configuration
built-in defaults
```

The organization layer may contribute a key in one of two modes:

- **default** — the organization's recommended value. Lower layers may override it.
- **enforced** — the organization's pinned value. No lower layer may override it.

Whether a key is a preference or a policy is decided by how the organization declares it, not by a hardcoded list in Wayfinder core. Core takes no position on which settings a given organization considers negotiable.

### 2. An override of an enforced key fails loud

Attempting to override an enforced key is an error, not a silently discarded value. The error names the key, the enforced value, and the policy source, so an operator can see what decided it and where to change it.

Silently ignoring the override would be worse than allowing it, because the operator would believe the run used their value.

This is the mechanism that lets ADR 0001 §8's isolation rule finally hold.

### 3. Policy is served by the tracker adapter

Wayfinder cannot operate without a tracker connection, and that connection already establishes the organization whose work is being touched. `adapter.initialize` already carries the scope as `workspace`.

Organization policy is therefore **served by the tracker adapter**, through a new `organization_policy` capability and a corresponding policy method in the Adapter Protocol. An adapter that can serve organization policy advertises the capability; core requests policy and never learns how the adapter obtained it.

Consequences of using the existing adapter seam rather than a new one:

- A Product Pipeline adapter serves policy from Product Pipeline settings, gated by Product Pipeline's own permissions.
- A Jira adapter may serve policy from a project or organization property.
- A Markdown adapter may serve policy from a file alongside its tickets.
- Linear and GitHub adapters may use whatever those platforms provide.

Core has no knowledge of Product Pipeline, or of any other specific system. Product Pipeline is one implementation of a generic capability, not a dependency. An organization on a different tracker is governed by that tracker's adapter with no change to core.

Policy governs how Wayfinder writes to a given tracker, so the tracker owning that policy is the correct coupling. An organization working across two trackers is governed per tracker, which is the intended behavior rather than a limitation.

### 4. An adapter without the capability yields built-in safe defaults

Not every tracker can serve policy, and the shipped Jira, Linear, and GitHub adapters do not today.

When the resolved tracker adapter does not advertise `organization_policy`, Wayfinder uses built-in defaults with nothing enforced, and `doctor` states plainly that this tracker serves no organization policy.

This is safe because the built-in defaults are already the conservative behavior: comments off, nothing narrated. Divergence remains possible only on keys no one has pinned. The remedy is to implement the capability on that adapter, not to block work.

Wayfinder does not fall back to any other policy source in this case. There is exactly one place policy can come from.

### 5. Onboarding is connecting a tracker

There is no organization identifier to obtain, no URL to locate, and no policy artifact to install. Onboarding asks for the tracker connection that Wayfinder requires regardless, and policy arrives with it.

The `init` flow must then show the resolved result before it completes: which keys the organization enforces, and which remain the operator's choice. This is the moment the preference/policy distinction is legible, and showing it prevents an operator later fighting an enforced key and concluding that their override is broken.

Because a tracker connection is mandatory, policy resolution needs no separate gate. No tracker means no policy and also no tickets, so there is no work to run.

### 6. Policy resolves host-side and is handed to the lane

Policy is resolved on the host at pickup and passed to the lane as part of its resolved configuration.

A lane running under strong isolation therefore does not need tracker access in order to be governed, which preserves the least-privilege rule in ADR 0001 §11. An isolated lane is bound by policy it cannot read, modify, or reach around.

### 7. Host applications are adapter implementations, never sources

A host application may render and edit organization policy for the tracker it backs. It does so as that tracker's adapter, through the same capability every other adapter uses.

Core never depends on such an application being present or reachable.

## Consequences

### Positive

- One organization, one behavior, for every key the organization pins.
- ADR 0001 §8's isolation guarantee becomes enforceable rather than aspirational.
- Onboarding gains no new step; the tracker connection already required now also carries governance.
- Policy is edited where the work is managed, by people with the permissions to manage it, rather than by whoever can push to a repository.
- No policy artifact is added to any product repository.
- Core stays decoupled from Product Pipeline and from every other specific system.
- Isolated lanes are governed without being granted tracker access.

### Costs

- The Adapter Protocol gains a capability and a method, which is an additive but permanent surface.
- `resolveEnvironmentSettings` and every future resolver must carry per-key provenance and enforcement rather than a merged value.
- Until an adapter implements the capability, that tracker's organization has no enforceable policy and relies on safe defaults.
- An organization spanning two trackers must configure policy on each.
- Policy availability is now coupled to tracker availability, which is acceptable because work availability already is.

## Summary

> Preferences are personal and may differ. Policy belongs to the organization, is served by the tracker that already defines that organization, and cannot be argued with at the command line.
