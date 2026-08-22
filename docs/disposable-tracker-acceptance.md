# Disposable-tracker and cross-platform acceptance

JWB-293 froze frontier and pickup behavior as offline goldens but explicitly
left live mutation parity unproven "until an explicitly configured disposable
tracker/repository is provided" (`docs/compatibility-fixtures.md`, _Live
boundary_). JWB-295 closes that boundary.

The disposable tracker is the credential-free Markdown reference adapter
(JWB-290). Because it needs no external service and stores its state in a
temp-directory `.md` file, it is the concrete, throwaway target that lets the
real runtime mutate a tracker end to end. `test/disposable-tracker-acceptance.test.ts`
drives the production `PickupCoordinator`, `Supervisor`, `LifecycleCoordinator`,
and `CommandHarnessAdapter` against it with a deterministic, injected harness
platform — no real processes, credentials, or network.

## Verified behaviors

| Behavior | What the acceptance test proves |
| --- | --- |
| Equivalent normalized frontiers | The adapter's native `frontier()` equals the portable `evaluateFrontier` over the same normalized tickets. |
| Cross-map blockers | A dependent on `map-2` blocked by a ticket on `map-1` stays off the frontier until the blocker closes, then becomes eligible. |
| Single-winner concurrent pickup | Two full pickups race the same ticket; exactly one commits and the source of truth holds one active claim. The conditional-update guard rejects a stale-version claim as a collision. |
| Generic harness launch | The argv-only `CommandHarnessAdapter` launches with `{workspace}` resolved to the real path and no shell text. |
| Lease observation | `claimStatusAt` reads the lease as active before expiry and stale after; the supervisor renews it on the disposable tracker. |
| Explicit stale reclaim | A reclaim is refused before lease expiry and, once expired, an authorized reclaim supersedes the stale claim and records it in claim history. |
| Exact post-claim compensation | A launch failure after the claim restores the tracker's exact pre-claim snapshot; the ticket is fully released. |
| Stop/release separation | `stop` tears down execution while leaving the claim active; `release` is a separate authorized operation that returns the tracker claim. |
| Crash recovery | SQLite WAL preserves run and claim identity across a supervisor restart; a session observed as gone is marked `attention_required`, never renewed. Unverifiable restoration escalates to `recovery_required`. |
| JSON receipt parity | The committed `PickupReceipt` round-trips through JSON and equals the receipt persisted in the ledger's ordered transaction steps. |

## Cross-platform stance

The runtime is TypeScript/Bun, so cross-platform correctness is about
path handling and platform-qualified probes, not OS-specific binaries. The
acceptance suite:

- exercises the generic harness against `linux`, `darwin`, and `win32` platform
  descriptors, asserting identical argv rendering and capability probing;
- uses `node:path` and `node:os` temp directories throughout, so no path
  assumption is platform-specific;
- records portable evidence (`process.platform`, `process.arch`, `Bun.version`)
  as a JSON-stable block printed by the run.

The Markdown tracker's durable-replacement guarantee (atomic rename, no stray
temp files) is independently covered on the running platform by
`test/markdown-tracker.test.ts`.

## Running it

```sh
bun test test/disposable-tracker-acceptance.test.ts
```

The final test logs a one-line JSON evidence block enumerating all ten verified
behaviors alongside the platform, architecture, and Bun version of the run.
