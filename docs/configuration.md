# Project configuration and launch context (JWB-491)

Implemented against main `7ee3403`, using Jaren's September 9 direction and
first-release acceptance records from the direction worktree. The copied
application-handler instructions do not apply; neither checkout contains
`docs/action-layer-plan.md`. The existing Python `wfcli/config.py` and
`wfcli/models.py` were inspected for field names, without reading personal config.

## Commands

```sh
wayfinder init
wayfinder init --path wayfinder.toml --from reviewed-project.toml --json
wayfinder config show --path wayfinder.toml --json
wayfinder config edit --editor vi
wayfinder config edit --set model selected-model
wayfinder config edit --follow model
wayfinder config edit --help --json
```

The default is `wayfinder.toml` in the current directory; `--path` selects another
file. No ancestor search or implicit import of `~/.config/wf/config.toml` occurs.
`init` writes a valid starter with an example Jira site and commented repository
and map entries. It is a configuration scaffold, not a connected/ready execution.
Configure the real site and mappings explicitly before pickup composition.
`--from` validates and copies an explicitly selected project file. A legacy file
needs `version = 1`; unknown fields are rejected rather than silently discarded.
Existing files and symlinks cannot be replaced by init. The parent directory must
already exist. No project instruction files or setup scripts are generated.

`config edit` runs the explicit editor, or `VISUAL`/`EDITOR`, as one executable
with the staged file as a separate argument. An editor setting containing shell
options is not interpreted; use an executable wrapper if needed. Only successful,
validated edits replace the project file. Editor failure, malformed TOML, a
conflicting personal choice, or a detected concurrent project edit preserves the
project file. Replacement uses a same-directory rename after checking the original
content; this is optimistic conflict detection, not a lock against external tools.

`--set` writes one explicit personal choice into the existing platform SQLite
store, scoped by absolute project config path. `--follow` removes that choice.
Defaults are never copied into personal records. Use the same source config path
when composing executions in different workspaces; independent config paths have
independent personal choices. `config show` uses read-only queries and does not
create/migrate a database. SQLite may create its normal WAL coordination sidecars
when reading an existing database; project content and durable records are not
modified. Tests inject temporary config paths and SQLite stores.

All commands now come from the typed application tree in `src/application.ts`.
Configuration action definitions live in `src/actions/configuration.ts`; their
input fields infer caller/handler types and generate parsing and help. CLI dispatch,
help, manual entries, and live completion queries consume that same tree. There is
no separate command switch, usage-string list, or completion-name list. See
[the action boundary](actions.md) for composition and availability semantics.

## Minimal schema

The repository/map/tracker/T3 names preserve the Python reader's existing shape.
The additions are schema version, defaults, requirements, and optional project
instruction/setup references. `version = 1` identifies the file format: users do
not increment it when changing settings. Every read computes a content hash for
execution identity automatically. These are different from a future format
migration, which must explicitly support earlier formats rather than ask users
to update counters. The version-controlled starter is
`src/configuration/default.toml`, embedded as a text asset when compiling the CLI. No credential values belong in any of these fields.

```toml
version = 1

[repositories.example]
github = "owner/repository"
path = "."
worktree_root = "../worktrees"
base_branch = "main"

[maps.EXAMPLE-470]
repository = "example"
claim_status = "In Progress"
available_statuses = ["To Do"]
claim_comment_required = true

[tracker.jira]
site = "https://example.atlassian.net"
cli = "acli"

[t3]
provider = "codex"
model = "selected-model"
thinking_effort = "low"
# context_window = "provider-supported-option"
runtime_mode = "approval-required"
interaction_mode = "default"
open = "none"

[defaults]
host = "t3"

[required]
runtime_mode = "approval-required"

[instructions]
runtime_contract = "docs/wayfinder-runtime-contract.md"

[instructions.role_templates]
task = "docs/task-role.md"

[setup]
version = "recipe-v1"

[[setup.steps]]
argv = ["bun", "install", "--frozen-lockfile"]
location = "workspace"
scripts = []

[[setup.steps]]
argv = ["sh", "scripts/setup.sh"]
location = "workspace"
scripts = [{ path = "scripts/setup.sh", version = "source-revision-or-content-hash" }]
```

`host`, `agent`, `model`, `effort`, `context_window`, `runtime_mode`, and
`interaction_mode` are the only personal/default/required setting keys. Existing
T3 settings supply defaults (`provider` maps to `agent`, `thinking_effort` maps to
`effort`); explicit `[defaults]` wins over those legacy defaults. Personal choices
win over defaults. `[required]` wins over defaults and rejects any conflicting
personal choice, naming the setting and project source. Matching choices are
allowed. There is no one-run bypass in this seam. Unknown keys, empty scalars,
invalid runtime modes, missing map repositories, non-array argv and credential-
bearing Jira URLs fail validation without echoing supplied values.

Project setup and instruction references are project-owned, not personal options.
They are always included from the current project document in new resolutions.
Repository/instruction paths are relative to the project file (absolute paths are
also supported). `configurationReference` performs local path resolution without
shell/tilde expansion. Remote/container paths must be materialized by the future
execution environment; this helper does not translate them.

There is no environment-variable inventory. Setup is ordered argv with an
explicit `source` or `workspace` location. `scripts` declares referenced files and
versions, including an explicitly invoked shell script. Configuration does not
execute commands, fetch credentials, or verify declared script versions. The
future runner must bind source checkout/destination handles, verify recipe and
script versions, obtain approval once per version set, and renew approval after
changes. Failed preparation must preserve the workspace and failed step, block
launch, and require explicit retry of that step and later steps. No transitive
script-dependency verification is claimed. Secret retrieval/file copying belongs
inside project scripts using secure channels; never place values in argv or TOML.

These are repository requirements. They do not claim to implement ADR 0003's
tracker-owned organization policy capability or environment-adapter lifecycle.
Tracker policy must be composed separately and conflicts rejected; project config
must not become an alternate source for tracker organization policy. The setup
recipe describes project preparation, while the existing environment adapter
still owns isolation/readiness. No setup runner or environment replacement is added.

## JWB-492 integration points and pending acceptance

1. Read/validate project TOML with `parseProjectToml`; load explicit choices with
   `readPersonalSettings`; call `resolveProjectConfiguration` with the absolute
   source path and `configurationVersion` of the exact source content. Resolve
   before claiming or writing any execution state for a dry run.
2. Use the configured map/repository mapping to construct the existing
   `RepositorySpec` (`github` -> repository remote, `worktree_root` ->
   `worktreeRoot`, `base_branch` -> `baseBranch`). Repository reference resolution,
   base revision and workspace planning remain composition work.
3. Obtain a normalized `Ticket`. Optional `title`, `description`, and
   `acceptanceCriteria` preserve protocol major 1 compatibility. Jira now requests
   summary/description and renders ADF to readable text; GitHub, Linear and
   Markdown retain their description text. Missing context is labeled honestly.
4. Call `loadConfigurationInstructions` for the ticket role. It loads configured
   files with content hashes. Call `planConfiguredLaunch` with those inputs and
   the explicitly supported/available host and agent lists established by
   composition. Missing selections explain available alternatives and fail without
   substitution. This function is pure: no tracker, workspace, database, ID, or
   session calls. A configured template must be loaded before planning.
5. The plan carries the resolved config, instruction identities, full prompt and
   a T3 selection block labeled `pending-host-preflight`. Translate selections
   through T3's actual provider/model/options catalog and existing adapter API;
   a config preference is not a verified T3 model selection or launch receipt.
   Resolve every supported combination and prerequisite before allowing execution.
6. For an actual execution, persist the initial configuration through
   `StateStore.saveExecutionConfiguration(runRef, configuration)` after saving the
   existing Run. Persist plan/instruction evidence through the existing ledger
   `recordStep`. The config table is keyed to that Run, not a competing lane store.
   A second initial snapshot is rejected. JWB-492 must make persistence part of
   its pre-launch sequence and handle failure before external effects. Existing
   work reads `getExecutionConfiguration`, not today's project defaults. Explicit
   adoption checkpoints are future work, not automatic updates.
7. Deliver `plan.prompt` through the existing T3 API. Generic command harnesses
   already use `buildLaunchPrompt` for ticket context instead of `Work on <ref>`.
   Configured role templates replace the built-in role guidance; full ticket
   description and an explicit AC field or recognized AC/VERIFY section are
   always appended, along with map/ticket/role and required evidence output.

Run the bounded, fake-input planning demonstration:

```sh
bun run test/fixtures/configuration-plan.ts
```

This produces JSON with a T3 block and the ticket's AC in the prompt. It makes no
tracker, host or workspace calls and opens no SQLite store. Instruction-loading
tests additionally prove the source files remain unchanged.

The Jira acceptance command remains **pending JWB-492 composition**:

```sh
bun run src/cli.ts pickup JWB-<disposable> --dry-run --json
```

`pickup` is not registered and rejects as an unknown command. A fake plan is not end-to-end Jira pickup
acceptance. No live claim, T3 session, Jira write, or setup run was performed for
JWB-491. The TypeScript baseline contained no macOS contract path; new paths are
explicit project references, with no hardcoded developer-home fallback. This
scoped change does not edit the separate Python runtime.
