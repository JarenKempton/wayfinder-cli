# JWB-281 crash-supervision prototype

This throwaway prototype answers one question: can a single per-user supervisor
and SQLite WAL ledger resume lease renewal and durably expose
`attention_required` after CLI, supervisor, or harness process crashes?

Run it with:

```sh
bun run prototypes/jwb-281/run.ts
```

The runner uses real child processes and `SIGKILL`, with shortened lease timing.
It proves these local-runtime properties:

- CLI exit does not stop renewal by the separate supervisor.
- Supervisor death makes the lease observably stale without changing claim
  ownership; a replacement supervisor reads WAL state and renews the same claim.
- Harness death is detected and persisted as `attention_required`.

It does not prove tracker adapter behavior, distributed leader election, or
cross-host recovery. Those remain outside the decision question and must not be
inferred from this artifact.
