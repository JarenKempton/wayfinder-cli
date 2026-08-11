# JWB-282 Jira claim-compensation prototype

This throwaway prototype asks whether a verified Jira claim can be restored to
the exact pre-claim assignment, status, Jira revision, and Wayfinder metadata
after an injected post-claim failure.

It is hard-coded to disposable map `JWB-300` and child `JWB-301`. The probe
refuses to run unless the child is unassigned, `To Do`, and carries only the
`wayfinder-jwb-282-baseline` label.

Run it once with:

```sh
bun run prototype:jira-compensation -- --execute
```

The command captures a baseline, performs and verifies a claim, injects a
failure, compensates, verifies the final state, and writes the evidence receipt
to `artifacts/JWB-282-live-receipt.json`.

This is intentionally not production code. The result determines which Jira
capabilities the real adapter may advertise.
