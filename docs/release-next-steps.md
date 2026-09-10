# Wayfinder first release: next steps

Evidence refreshed September 10, 2026. This is an execution checklist, not a claim
that the release is ready. It supplements first-release-acceptance.md and preserves
the decisions in direction-2026-09-09.md. Coordinator owns keeping this page current.

## What Jaren should do

1. Leave PR #41 unmerged while the remaining review items below are addressed.
2. Review the revised #41 handoff: a short action-definition example, the real
   configuration file, and terminal output from an isolated configuration demo.
   Judge whether you can understand where to add an action and change defaults.
   Engineering must provide these artifacts; you do not need to decode JSON fixtures.
3. Approve or reject #41 after the review checklist has evidence. This approves
   a component, not the release and not ticket completion by itself.
4. Once integration passes fake tests, approve one exact disposable-ticket demo
   with the site, ticket, workspace, model, setup recipe, and expected Jira/T3
   changes shown beforehand. This checklist does not grant that live approval.
5. Watch pickup, inspect, reconnect, and verified stop. Approve release only when
   the agreed acceptance criteria have evidence and remaining limitations are clear.

## Engineering queue, in order

| Step / owner | Concrete deliverable | Pass condition / current gap |
| --- | --- | --- |
| 1. Coordinator + JWB-491 implementer: finish #41 review | Resolve each of Jaren's review comments against the latest commit; show one action definition feeding execution/help/completions and a real config example | Latest d222f6c revises action composition and config structure; CI passes on Linux/macOS/Windows. Review required; passing CI is not architecture approval. |
| 2. JWB-491 implementer: remove implicit completion policy | Correct hardcoded closure/map-update guidance in src/launch-prompt.ts; configurable workflow instructions must respect authorization and completion gates | A generic prompt cannot confer Jira mutation authority or imply acceptance alone permits closing a ticket. Regression coverage and readable rendered prompt required. |
| 3. Coordinator: reconcile Jira handoffs | Replace or explicitly supersede contradictory JWB-489/490/491/492 requirements with linked current decisions and acceptance ownership | Existing descriptions contain unrelated handler rules; JWB-490 assumes Basic credentials and timestamp CAS; JWB-491 requires pickup acceptance that actually depends on JWB-492. Do not hide these gaps by closing tickets on merge. |
| 4. JWB-490 implementer: prove Jira ownership | Personal authenticated transport, claim/verify/renew/release behavior, concurrency and ambiguous-write evidence using fakes before live operations | Verify actual conditional-write guarantees; an updated timestamp alone is not proof of atomic exclusion. No silently shared global actor. |
| 5. Integration implementer, JWB-492: build the usable path | Compose config, Jira, worktree and T3 into ticket-based preview/pickup/inspect/reconnect | Preview shows ticket, actor, repository/base/branch/workspace, host/model, setup and instruction sources. Reconnect sends zero new messages; uncertain launches preserve claim/workspace and block duplicate launches. |
| 6. Setup implementation, ticket owner to assign | Run approved ordered project commands; store recipe/script identity and failed-step evidence | New/changed recipes require approval; failed setup blocks launch, preserves workspace, and explicit retry runs failed and later steps. #41 only describes recipes; a runner is still a named gap. |
| 7. JWB-489 implementer + integration: verified stop | Implement or obtain a verifiable host stop contract and qualify supported provider/platform combinations | PR #40 documents the blocker, not its resolution. Never label an uncertain stop successful; preserve workspace and ownership. |
| 8. Coordinator + Jaren: release demonstration | Reproducible terminal walkthrough and acceptance evidence for the selected release revision | Preview, explicit pickup, inspect, restart/reconnect, missing-session recovery, setup failure/retry, and stop pass. Publish/installable artifact only after release gates are met. |

Steps 4 and 7 are independent of the #41 review. Integrating unknown claim/stop
behavior as success is not an acceptable shortcut. Automatic map progression,
Docker, MCP, TUI/GUI, and PR review automation remain outside this release path.

## Evidence and boundaries

- [PR #39](https://github.com/JarenKempton/wayfinder-cli/pull/39): merged T3 adapter;
  does not complete verified stop or end-to-end CLI integration.
- [PR #40](https://github.com/JarenKempton/wayfinder-cli/pull/40): merged stop-blocker evidence.
- [PR #41](https://github.com/JarenKempton/wayfinder-cli/pull/41): draft configuration,
  ticket context and typed action work. Latest observed commit d222f6c; three CI
  platforms pass. Lane reports 371 tests plus typecheck, Biome and isolated binary
  checks. Coordinator has not independently reviewed that full revision.
- Fake configuration-plan output proves plan construction only. Empty map/repo
  configuration, pending-host-preflight and instructions=[] are not live readiness.
- Every unchecked criterion in first-release-acceptance.md remains unverified at
  release level. A component test may support it but cannot check it off alone.

## PR #41 reviewer checklist

- [ ] Every existing review comment is answered with changed code or an explicit rationale.
- [ ] One typed action definition drives invocation, validation, help and completion.
- [ ] Project template is an inspectable version-controlled asset; configuration modules have clear responsibilities.
- [ ] Explain format choice and persistence tradeoff, including read-only inspection and safe initialization, in the handoff.
- [ ] Project requirements reject personal conflicts; changing defaults does not erase explicit choices.
- [ ] No prompt implicitly authorizes ticket closure, tracker updates, or bypassing human merge approval.
- [ ] Human-readable configuration demo and short developer action example accompany test/CI evidence.
- [ ] Deferred setup execution and pickup acceptance remain visible and assigned before ticket closure.
