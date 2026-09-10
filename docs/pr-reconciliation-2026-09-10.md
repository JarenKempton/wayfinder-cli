# Open PR reconciliation — September 10, 2026

Scope: all six open PRs in JarenKempton/wayfinder-cli at this audit. No PR was
merged by this cleanup. No branch, worktree, sandbox or implementation code was
deleted. This index supersedes the September 9 PR-status assessment, while
preserving its reproduced findings.

Main observed: `597e40b5f70aae3263d21bf6a23fb4402b858295` (includes #38, #39, #40).
The #41 head below is a snapshot; its existing implementation lane may advance it.

## Current queue

| PR | Disposition | Next action / owner | Preserved audit head |
| --- | --- | --- | --- |
| [#41](https://github.com/JarenKempton/wayfinder-cli/pull/41) | Active implementation | Existing JWB-491 lane is addressing review feedback; retain draft until revised evidence and human review. | `d222f6c53ef39da834909faabc94dd5fe76dbad9` |
| [#37](https://github.com/JarenKempton/wayfinder-cli/pull/37) | Decision / release-plan review | Coordinator maintains current decisions, release gates and this index. Review docs before merging; not runtime approval. | `25cdeab2e46cf2b96acf704fb4da44d9d9e6a518` |
| [#32](https://github.com/JarenKempton/wayfinder-cli/pull/32) | Retained proposal (draft) | Fix local-preflight/capability defects when command-runtime work is scheduled; no current implementer. | `2397b83be81abcf6cdb3298d065bece3339ee196` |
| [#33](https://github.com/JarenKempton/wayfinder-cli/pull/33) | Retained research (draft) | Reverify primary sources when Docker work is scheduled; not current support policy. | `42f1c7504dbedcd243eb25615fbb4240ead904ec` |
| [#36](https://github.com/JarenKempton/wayfinder-cli/pull/36) | Retained proposal (draft) | Qualify real provider/OS/agent execution before resuming; depends on verified research, not a current release gate. | `6ea2e2f69a8d77ab849cd18a3d973c5ca3733265` |
| [#34](https://github.com/JarenKempton/wayfinder-cli/pull/34) | Closed, superseded implementation shape | Preserve replay/event/concurrency work for scoped reuse; no equivalent replacement implementation exists. | `dd514f5a62bf743f29fb26b83cf7189a1d49ca4f` |

## What is intentionally preserved

- #32: command-agent invocation versus execution separation, runtime delegation
  and tests. T3 structured sessions in #39 do not make this code a duplicate.
- #33: Docker research and citations. No current external support claims were
  verified by this cleanup; source verification is a future adoption gate.
- #36: environment isolation boundaries, private-clone preparation, ownership and
  recovery checks. `osQualified:false` and fake-provider tests do not establish
  usable Docker support. Keeping a proposal is not committing to a release date.
- #34: append-only event/replay and transactional concurrency tests. Its fixed
  review states and separate global lane-policy store are not the agreed core
  workflow. Closure rejects that integration shape, not the need for durability.
  Future reuse needs map scope and one explicit run/claim/storage authority model.

Original PR bodies remain in collapsed historical sections so prior acceptance
claims are not mistaken for today's readiness. Original metadata and a verified
Git bundle of all six heads are also retained locally in the shared Git directory
under `pr-reconciliation-2026-09-10/`; local refs are
`refs/archive/pr-reconciliation-20260910/<PR number>`. Remote branches remain.

## Operating meaning of the queue

- Active implementation: a named lane is working it; the PR states remaining work.
- Retained proposal: draft, not scheduled and not a merge recommendation; explicitly
  records why to retain it and what must happen before resuming.
- Superseded: closed with the reason, preserved head and reusable parts. Never
  claim a replacement is merged unless there is actual implementation evidence.
- Ready for human merge review: current code review, checks and scoped acceptance
  evidence are available. CI alone does not establish this state.

JWB-326/JWB-327's previously observed Done statuses do not establish that #34/#32
were integrated. This cleanup changes PR disposition, not Jira completion status;
tracker reconciliation remains an explicit item in release-next-steps.md.

See [release next steps](release-next-steps.md) for the T3 first-release path and
[first-release acceptance](first-release-acceptance.md) for the agreed behavior.
