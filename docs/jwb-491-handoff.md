# JWB-491 developer handoff

PR #41 supplies configuration commands, typed action composition, and ticket
context for prompts. The generic prompt now requests evidence without granting
tracker mutation, closure or map-update authority. Project/workflow instructions
own completion policy; passing tests cannot bypass required human approvals or
configured gates. This is prompt guidance, not a new gate-enforcement subsystem.

Subsequent requested research: [CLI library evaluation](cli-library-evaluation.md).
Zod now owns configuration schemas; Commander and Optique are tested prototypes,
with the CLI replacement decision still pending. New PR review comments were not
read as part of that research.

## Try the implemented path

From this checkout:

```sh
bun run examples/configuration.ts
```

Read the [actual example TOML](../examples/wayfinder.toml),
[project task instructions](../examples/task.md), and
[captured output, including the complete rendered prompt](configuration-demo.txt).
The script uses the real CLI dispatcher and configuration actions with temporary
project files and SQLite. It asserts non-overwrite initialization, no database
creation during initial inspection, persistence of personal choices across a
project-default edit, automatic source identity changes, following updated
defaults, rejection of required-setting conflicts, and unchanged project/database
bytes after typed inspection. It removes only its own temporary directory.

Config results are summarized by the demo; ordinary config CLI output is JSON.
The injected demonstration editor changes only the staged temporary file, passing
through the production validation and rename path. No external editor is needed.
Example model names and supplied host/agent availability are illustrative; they
are not discovered or verified. The prompt uses an explicit fake ticket and a
real loaded task template. Its T3 block remains `pending-host-preflight`.

For normal project setup, run `wayfinder init`, edit `wayfinder.toml` with
`wayfinder config edit --editor vi`, then inspect with `wayfinder config show`.
The starter has commented repository/map examples; configure these and the Jira
site explicitly. `init --from FILE` copies an explicitly selected validated file.
This is a scaffold-and-editor flow; an interactive setup wizard is not implemented.

## Where a developer adds an action

Here is the real `config.show` definition inside
[`configurationActions`](../src/actions/configuration.ts):

```ts
show: defineAction({
  description:
    "Read project configuration and explicit personal choices without changing durable state.",
  input: showInput,
  dependencies: { read: dependency(operations.show, "project configuration reader") },
  handler: ({ read }, input) => read(input),
  output: validateConfigurationOutput,
}),
```

`showInput = { path }` uses the optional `FILE` field defined in the same file.
Those parsers infer the input type; the handler infers the result. The `read`
binding is the actual configuration reader, not a second capability declaration.
To add a configuration action, add a sibling definition here and its underlying
operation where appropriate. The existing group registration in
[`createApplication`](../src/application.ts) already includes it. A new group
needs one registration there. No edits to CLI dispatch, help, manual or completion
lists are needed. This example is shipped product code, not the test greeting.

```ts
const app = createApplication({ configuration: { cwd, statePath } });
const result = await app.config.show.execute({ path: "wayfinder.toml" });
// result.configuration.settings is inferred; misspelled actions/fields fail tsc.
```

The runnable demo includes that call and these derived CLI views:

```text
$ wayfinder config show --help
wayfinder config show [--path FILE] [--json]
  Read project configuration and explicit personal choices without changing durable state.
$ wayfinder completions bash --at "config show"
--path
--help
--json
```

Missing required bindings remove an action from discovery and prevent invocation.
Discovery proves composed code and services, not target credentials, authorization,
connectivity or successful execution. Those need request-specific preflight.
[Action tests](../test/actions.test.ts) cover adding/removing bindings across typed
calls, CLI, help, JSON, manual and completions; negative type examples are checked
by `bun run typecheck`. See [action architecture](actions.md) for boundaries.

## Format, persistence and safety

TOML preserves the existing configuration shape and allows comments beside static
settings. JSON would also work but lacks comments; TypeScript would turn data into
executable configuration; YAML adds another format without a requirement here.
This keeps one validated data format rather than multiple config loaders. It is
not a claim that TOML provides TypeScript types: runtime validation supplies the
trusted shape. No values intended as secrets belong in any config field.

`version = 1` is the schema compatibility version, not a counter users update
when editing settings. The reader automatically hashes exact source content.
Instruction files are also hashed. A resolved execution snapshot retains its
project, settings and provenance; new resolutions read new defaults. Only explicit
personal choices are stored in the existing SQLite database, scoped by absolute
project config path. `--follow` deletes the choice instead of copying today's
default. Required settings reject conflicting personal choices.

SQLite writes use the existing parameterized StateStore operations and explicit
transactions. This revision does not introduce Drizzle or migrate unrelated SQL;
the stable storage boundary allows a separate typed-schema decision. Read-only
inspection neither initializes nor migrates the database. SQLite may create WAL
coordination sidecars when reading an existing store; durable data is unchanged.
Init uses exclusive creation, rejecting files and symlinks. Project edits stage,
validate and check for concurrent changes before rename; failures preserve the
original. This is optimistic conflict detection, not an external-editor lock.
See [configuration semantics and limits](configuration.md) and
[regression coverage](../test/configuration.test.ts).

## Jaren's review comments

Each link identifies the original comment; dispositions include intentionally
deferred work. They do not claim reviewer approval or resolve GitHub threads.

| Comment | Disposition and evidence |
| --- | --- |
| [Starter embedded in TS / setup walkthrough](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982275164) | Starter moved to [version-controlled TOML](../src/configuration/default.toml), embedded at build time. Real init/edit walkthrough above. Interactive wizard deferred; scaffold is not advertised as connected readiness. |
| [Why TOML?](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982288503) | Compatibility and static, comment-friendly data; tradeoffs explained above. One loader and validator, no executable user config. |
| [Drizzle instead of raw SQL?](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982299050) | Deferred ORM migration. [Local reads](../src/configuration/local-settings.ts) and parameterized [StateStore writes](../src/state.ts) remain explicit; rationale above. |
| [Ambiguous configuration filenames](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982307239) | Split into [schema](../src/configuration/schema.ts), [files](../src/configuration/files.ts), [local-settings](../src/configuration/local-settings.ts), [project-files](../src/configuration/project-files.ts), and [actions](../src/actions/configuration.ts); removed duplicate configuration.ts entrypoints. |
| [Why safety/idempotency/read-only?](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982313299) | Repeated init cannot replace project work; inspection cannot create/migrate durable state; failed edits preserve originals. Actual demonstration and safety limits above, tested in [configuration tests](../test/configuration.test.ts). |
| [Single-concern organization over explanatory comments](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982325261) | Configuration concerns split as above; [CLI](../src/cli.ts) delegates to composition/dispatch, and [action groups](../src/application.ts) own their implementations. No repository-wide service framework added. |
| [Untyped action switches and duplicated help](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982329377) | Replaced with [typed composition](../src/application.ts) and [shared dispatch/help](../src/actions/command-line.ts). Actual show definition and call above. |
| [actions.find / first-class callable actions](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982349708) | `app.config.show.execute(...)` preserves inferred inputs/results. [Definition](../src/actions/definition.ts) owns validation and required bindings; no string lookup at typed call sites. |
| [Hand-pushed help and CLI structure](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982353746) | [Help projects available definitions](../src/actions/command-line.ts); [catalog](../src/actions/catalog.ts) derives usage from fields. CLI entrypoint no longer lists actions or assembles help. |
| [Derive completions](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982360537) | [Shell scripts query the running application](../src/completions.ts); candidates come from currently available definitions. Example output above. |
| [Manual version counters?](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982369464) | Format major stays 1; [content hashing](../src/configuration/files.ts) automatically identifies edits. Demo asserts source identity changes and earlier resolution remains intact. |
| [Handlers shoehorned into a parallel action layer](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982375380) | Each [action definition](../src/actions/definition.ts) owns handler, input, descriptions and actual dependencies; [composition](../src/application.ts) yields typed callable members and runtime discovery together. No parallel handler registry or availability flags. |
| [Adapter help contains text that will rot](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982750861) | [Adapter help](../src/actions/adapters.ts) now states what this command supports, removing session-approval/release-status narrative. Existing T3 refusal coverage checks that boundary without launching T3. The existing `liveLifecycleAcceptance: pending` output is preserved for compatibility; discovery cannot prove lifecycle acceptance. Release blockers live in the coordinator checklist. |
| [Is adapter test production CLI or internal fixture?](https://github.com/JarenKempton/wayfinder-cli/pull/41#discussion_r3982762077) | It is a public diagnostic registered by [createApplication](../src/application.ts), included in generated help/completions. `adapter test EXECUTABLE` starts that executable for protocol initialization; `adapter test t3 --read-only` reads T3 discovery/authentication/snapshot; `adapter conformance FIXTURE` runs the explicitly supplied fixture. These are not automatically run by help/config, and were not invoked live here. Their existence does not authorize lifecycle acceptance or certify production readiness. |

## Release path and acceptance ownership

The coordinator's `wayfinder-cli-direction/docs/release-next-steps.md` owns the
release checklist. This PR is one component; merging it cannot alone close
JWB-491 or establish release acceptance.

1. **Jaren + coordinator:** review this handoff and PR #41; reconcile contradictory
   Jira handoffs with selected direction. Keep Jira unchanged in this lane.
2. **JWB-490:** prove personal authenticated claim/verify/renew/release and
   concurrency/ambiguous-write behavior using fakes. Timestamp comparison alone
   is not proof of atomic exclusion.
3. **JWB-492:** compose the [documented integration points](configuration.md#jwb-492-integration-points-and-pending-acceptance)
   into preview/pickup/inspect/reconnect, using actual actor/repository/base/branch/
   workspace/host/model preflight, resolved snapshots and instruction identities.
   `pickup` remains unregistered; the requested Jira pickup dry-run is pending.
4. **Setup owner still to assign:** execute approved recipe/script versions;
   failed setup must block launch and preserve workspaces for explicit retry.
   This PR only validates ordered argv/location/script references. It never runs
   them or interprets a duplicated environment-variable inventory.
5. **JWB-489 + integration:** obtain verifiable stop and qualify provider/platform
   support. Preserve ownership/workspaces on uncertain outcomes; PR #40 records
   the blocker rather than solving it.
6. **Coordinator + Jaren:** approve an exact disposable demo only after fake
   integration passes, verify the selected revision against all release gates,
   then approve publication of an installable artifact. No such approval is
   inferred from this PR or example.

Claim and stop work can proceed independently of this review. No daemon, MCP,
Docker, automatic map progression or optional PR-review automation is required
by or introduced in this change.
