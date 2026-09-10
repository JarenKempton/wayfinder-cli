# CLI library evaluation for JWB-491

Evaluated September 10, 2026 against PR #41 at `0ccd91a`, with the accompanying
Zod configuration change. **Recommendation: keep Zod, and use Optique as the
leading candidate to replace the custom CLI mechanics before merging them.**
Commander is viable but needs more adaptation for our existing syntax and
discovery surfaces. Neither CLI candidate has been installed in production.

Bun is not blocking library adoption. Both candidates ran the real configuration
actions and compiled into standalone executables on this Linux machine, using
local Bun 1.4.2 and CI's Bun 1.3.11. We do not need to own an argument parser to
retain typed actions or discovery based on actual service bindings.

## Evidence against the actual application

The [probe](../research/cli-libraries/probe.ts) connects each library to
`createApplication()` from copied current source. It exercises real init/show/edit
operations against temporary project files and SQLite, checking:

- Init rejects an existing file and preserves its contents.
- Initial inspection creates no database; later inspection preserves database bytes.
- `config edit --set model "chosen model"` persists a choice; `--follow model`
  removes it. Spaces and `--path=FILE` work.
- Missing/extra pair values, unknown settings/options and conflicting operations
  fail before performing the requested operation.
- Unbound `stop` is unavailable. Optique discovery gains `stop` when its actual
  lifecycle binding is supplied, without invoking that binding.
- Optique derives human help, man output, shell scripts and completion candidates
  from the same composed parser. Discovery creates no store.
- Compiler-negative examples reject invented Commander handler fields and invalid
  Optique/Zod setting keys. The typed example shares our real setting schema.
- Identical assertions pass from source and a compiled executable.

No tracker, agent, host lifecycle, setup recipe or production workspace is
contacted or executed. Pinned research packages: Commander/extra-typings 15.0.0;
Optique core/Zod/man 1.2.6; Zod 4.6.2; TypeScript 5.9.3 and Bun types 1.3.14,
matching the checkout's compiler/type versions. Only Zod is added to Wayfinder's
production dependencies; the candidate libraries are installed in temporary
research directories.

## Fit against our requirements

“Verified” means exercised by the local probe. “Integration” means work remains
to adapt the library to Wayfinder's contract.

| Requirement | Commander | Optique |
| --- | --- | --- |
| Bun source execution and standalone compile | Verified on 1.3.11 and 1.4.2 | Verified on 1.3.11 and 1.4.2 |
| Subcommands, spaces, equals syntax, generated help | Verified | Verified |
| Existing `--set KEY VALUE` | Native two-placeholder declaration fails; variadic option plus tuple validation works in bridge | Ordered `seq(option(...), argument(...))` works; usage shows two values |
| Duplicate flags rejected | Default accepts duplicates; additional policy check needed | Default rejects duplicates; verified |
| Types inferred from argument declarations | Verified with `@commander-js/extra-typings` | Verified with native inferred parser values |
| Shared Zod choices and value completion | Needs integration | Verified with official Zod adapter |
| Unavailable commands omitted and blocked | Verified by registering actual available actions | Verified by composing actual available actions |
| Generated manual and Bash/zsh/fish completion | Needs integration beyond the tested API | Man generation, script generation and runtime candidates verified |
| Typed `app.config.show.execute(...)` calls | Existing action boundary remains; not automatically supplied by Commander | Existing action boundary remains; parsing alone does not create this API |
| Existing JSON help/results protocol | Integration needed | Integration needed; structured docs are available, not our exact JSON shape |
| Diagnostics that never repeat untrusted input | Integration needed; native errors can echo input | Integration needed; native errors can echo input |
| Requirements/defaults/personal precedence, authorization, completion gates | Wayfinder policy | Wayfinder policy |

Both bridges consume the actual action tree, without another command-name list.
They retain today's field validation and typed direct API to measure transport
compatibility. **They are incomplete migration prototypes, not replacements for
the production dispatcher.** Aliases, the `completions --at` protocol, exact JSON
compatibility and all legacy command forms still need conformance checks.
Interactive shell installation and Tab behavior were not tested; script generation
and candidate queries were. The research probes are not qualified on macOS/Windows
or every Bun version permitted by `>=1.3.0`.

## Concrete differences

Commander does not treat this as a fixed two-value option:

```ts
new Command().option("--set <KEY> <VALUE>");
```

The native probe accepts `--set model` and rejects `--set model chosen` as an
extra argument. The bridge uses `<VALUES...>` and the existing action tuple
validator to enforce exactly two values. This works for today's edit command,
but advertises a variadic option and needs care if positional arguments are
added. Commander also accepts repeated flags/options by default, unlike our
current CLI. These are fixable compatibility costs, not Bun failures.
[Commander documentation](https://github.com/tj/commander.js),
[extra-typings](https://github.com/commander-js/extra-typings).

Optique expresses the existing syntax without our token-counting loop:

```ts
const setting = zod(personalSettingsSchema.keyof(), {
  placeholder: "model" as const,
});
const value = zod(z.string().min(1), { placeholder: "example" });
const set = seq(option("--set", setting), argument(value));
```

This parses a typed pair and shares the real configuration setting keys. The
[typed example](../research/cli-libraries/typed-zod.ts) uses `or` for set/follow/editor
alternatives, rejects conflicting operations and suggests `model` for
`--follow mo`. Optique provides these compositions and discovery surfaces.
[Constructs](https://optique.dev/concepts/constructs),
[Zod integration](https://optique.dev/integrations/zod),
[completion](https://optique.dev/concepts/completion),
[man generation](https://optique.dev/concepts/man).

The `as const` matters in the tested version: a placeholder widened to `string`
also widened the inferred setting type. Our negative typecheck caught that.
Parser mappings/refinements can also run during discovery. The bridge returns a
deferred invocation instead of executing handlers inside mappings; validators
must remain free of external effects. Optique documents repeated validation
during completion/deferred resolution. [Zod adapter behavior](https://optique.dev/integrations/zod).

The current Optique bridge displays the pair's second value as a separate entry
in detailed help, while usage correctly includes two values. Help labels/layout
need review in a migration; another handwritten help list would defeat the goal.

## Zod now validates production configuration

[`configuration/schema.ts`](../src/configuration/schema.ts) uses strict Zod
schemas for project configuration, personal settings and persisted snapshots.
Types and `SETTING_KEYS` derive from those schemas, replacing separate interfaces,
the key inventory and structural validation loops. Unknown keys are rejected,
not silently stripped. Precedence, requirement conflicts, snapshot consistency
and explicit availability selection remain Wayfinder logic. Zod supplies strict
objects, inferred types and refinements for these boundaries.
[Zod schema API](https://zod.dev/api).

The module decreased from **351 to 248 lines**. Version 1 and the public
string-valued settings API remain. Malformed `null` sections now fail instead of
being treated as absent. Diagnostics follow actual schema paths, such as
`project.t3.runtime_mode`. Dynamic record keys and input values are omitted;
raw Zod errors are not attached as causes. New tests cover these diagnostics,
inferred types and forged snapshot provenance. Existing precedence, persistence
and non-overwrite tests continue to pass.

Using the same Bun 1.4.2 minified JS build command, the application bundle grew
from 79,622 to 166,457 bytes: **86,835 bytes added**. This measures application
JavaScript, not Bun's embedded runtime or startup performance. The compiled
production executable builds successfully. Library adoption has a measurable
dependency cost; it does not remove every custom rule.

`actions/input.ts` has not yet moved to Zod. That should happen with the selected
CLI integration: input schemas become authoritative, with CLI metadata attached
to or derived from them. A second independently maintained schema/option list
would recreate the drift risk.

## What to replace and what to retain

The current input, command-line, catalog, completion and manual modules total
374 lines. Not all are removable: composition, availability, JSON compatibility
and application invocation still need an owner. The experimental bridges are
56 lines for Optique and 61 for Commander, **excluding outstanding compatibility
work**. These are not promises of final migration size.

Replace token parsing, primitive validation, usage assembly and shell script
generation with library functionality. Preserve the small typed action boundary,
actual service bindings, configuration policy, side-effect boundaries and output
contract. The intended dependency direction is:

```text
actual action + Zod input schema + CLI metadata
  -> available action composition
  -> library parser / help / completion / manual
  -> validated, explicitly invoked handler
```

A migration must prove one new action appears across discovery surfaces without
edits elsewhere, and removing its binding removes availability. Direct calls and
CLI calls must pass the same schema. Existing argument forms, redaction and JSON
fixtures must pass before switching dispatchers. Optique is the strongest
functional fit in this bounded evaluation; adoption still needs that migration
and review of its dependency/maintenance fit. These probes do not establish
long-term reliability or an ecosystem-wide ranking.

## Other tools screened

TanStack CLI creates/manages TanStack applications; its own implementation
depends on Commander, Zod and Clack. It is not the reusable argument parser this
project needs. [TanStack reference](https://tanstack.com/cli/latest/docs/cli-reference),
[dependencies](https://github.com/TanStack/cli/blob/main/packages/cli/package.json).

`node:util.parseArgs` works under Bun; our probe confirms equals syntax. It does
not by itself replace routing, help, completion or structured application
validation. Bun's own guide recommends it for argument parsing.
[Bun guide](https://bun.com/guides/process/argv).

Citty documents declarative arguments, subcommands and generated usage; Clerc
documents a completion plugin. Both remain plausible alternatives, but neither
received a runtime/compile spike here. The hands-on comparison focused on
Commander as the reference and Optique for its direct Zod/discovery fit.
[Citty](https://github.com/unjs/citty),
[Clerc completion](https://clerc.js.org/official-plugins/plugin-completions).

## Reproduce the evidence

From this checkout:

```sh
bun run research/cli-libraries/run.ts
bunx --package bun@1.3.11 bun run research/cli-libraries/run.ts
```

The runner copies current source into a temporary directory, installs pinned
research dependencies there, typechecks, runs probes, compiles and runs them
again, then removes that directory. Only normal package-manager caches are
shared; no global config is edited. The research lockfile was generated with
Bun 1.3.11: that version cannot read a fresh Bun 1.4 lockfile version 2. The
production lockfile remains version 1.

- [Bun 1.4.2 transcript](cli-library-evidence.txt)
- [Bun 1.3.11 transcript](cli-library-evidence-1.3.11.txt)
- [Commander bridge](../research/cli-libraries/commander.ts)
- [Optique bridge](../research/cli-libraries/optique.ts)
- [Typed Zod example](../research/cli-libraries/typed-zod.ts)

Production verification: **383 tests pass**, typecheck and lint/format checks
pass; all 383 tests also pass locally under Bun 1.3.11. Pickup, setup execution,
verified claims/stop and live release acceptance remain assigned integration
work. This research does not advance or close any Jira ticket.
