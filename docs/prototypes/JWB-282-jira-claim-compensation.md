# JWB-282 — Jira claim compensation verdict

## Decision question

Can a conditional Jira claim be verified and then restored to the exact
pre-claim assignment, status, version, and Wayfinder metadata after an injected
post-claim failure?

## Live fixture

- Disposable map: [JWB-300](https://responsibid.atlassian.net/browse/JWB-300)
- Disposable claim target: [JWB-301](https://responsibid.atlassian.net/browse/JWB-301)
- Probe: `bun run prototype:jira-compensation -- --execute`
- Machine-readable evidence: `artifacts/JWB-282-live-receipt.json`

## Observed result

The claim target began unassigned, `To Do`, with only the
`wayfinder-jwb-282-baseline` label. The probe reread that snapshot, assigned the
ticket to the active human, replaced the label with
`wayfinder-jwb-282-active-claim`, transitioned the ticket to `In Progress`, and
verified the claimed state. It then injected the planned failure and compensated
in reverse, returning the ticket to unassigned, `To Do`, and the baseline label.

The reversible business state matched the snapshot exactly. The Jira revision
did not: the baseline `updated` value and post-compensation `updated` value were
different. The Jira CLI also exposes no server-enforced expected-version input
for assignment plus transition; the pre-write reread is a client-side check,
and status remains a separate mutation.

## Verdict

**No.** Jira compensation can restore assignment, status, and Wayfinder-owned
metadata and verify those values, but it cannot restore the exact pre-claim Jira
revision or erase the mutation history. This experiment also does not prove an
atomic conditional claim across assignment, metadata, and status.

The Jira adapter therefore must not advertise exact rollback or a server-side
conditional multi-field claim. It may advertise verified compensation only when
it records each owned mutation, restores reversible fields, rereads them, and
reports `recovery_required` for any ambiguity or intervening change.
