# Wayfinder CLI

Wayfinder CLI is portable work orchestration for agents. It discovers unblocked work from
Wayfinder maps, lets a person select one ticket, and coordinates a deterministic
claim, workspace, and harness launch without making the tracker, model, or
harness part of the core domain.

Wayfinder CLI is designed to integrate with the map-based Wayfinder workflow popularized
by Matt Pocock. See [NOTICE.md](NOTICE.md) for attribution and project lineage.
The normative [ownership boundary](docs/ownership-boundary.md) defines what
stays in the MCP/skill layer and what belongs to this CLI runtime.
The [compatibility fixtures](docs/compatibility-fixtures.md) exercise durable
frontier ordering and pickup compensation through production code, plus an
offline golden for the historical command and receipt surface.

## Status

Wayfinder CLI is a TypeScript/Bun pre-release. This repository currently defines and implements the stable
foundation: qualified references, portable ticket and capability types, frontier
evaluation, adapter protocol discovery, layered execution routing, SQLite run,
claim, lease, observation, and recovery state, and the lifecycle CLI. Bundled
Linear and GitHub Issues adapters normalize
native map children and blockers and exhaust provider pagination. Their hosted
assignment APIs do not satisfy mutating pickup's capability gate, so they remain
read-only in pickup coordination. Product-specific session lifecycle adapters
must pass their conformance suites before being advertised as supported. The
[command harness adapters](docs/harness-adapters.md) provide only executable-qualified
prepare/launch integration; their documented richer session protocols are not yet claimed.
The [T3 Code orchestration API evidence](docs/session-hosts/t3-code.md) records
the locally verified version, transport, schemas, and remaining host qualification gaps.

## Tracker credentials

The Linear adapter accepts a scoped API token and the GitHub adapter accepts a
token with repository Issues access. Tokens are passed in request headers and
are never placed in process arguments or logs. The registry leaves both adapters
unavailable until credential validation and CLI composition are proven; merely
setting an environment variable does not advertise a usable adapter.

Both adapters intentionally omit `conditional_update`, `atomic_assignment`, and
`lease_metadata` from their advertised capabilities. Their public assignment APIs
do not provide a verified compare-and-swap, durable claim identity, or native
expiring lease. Mutating pickup requires all of those capabilities and fails
before snapshot or mutation when they are absent. Direct compensation helpers
retain the persisted claimed-owner guard and never overwrite a concurrent owner.

The GitHub adapter uses the documented REST API version `2026-03-10`, pins
authenticated pagination to the configured API origin, and rejects
cross-repository sub-issues or blockers at the v1 workspace boundary.

## Develop from source

```sh
bun install
bun run src/cli.ts --help
```

## Install a prerelease

GitHub Releases contain checksum-listed standalone binaries for macOS, Linux, and Windows,
along with an SPDX SBOM, build provenance, shell completions, and a man page. To install a
specific prerelease without Bun or Node:

```sh
WAYFINDER_VERSION=0.1.0-beta.1 sh scripts/install.sh
```

```powershell
.\scripts\install.ps1 -Version 0.1.0-beta.1
```

The installers verify the selected binary against the release checksum before installing it.
Interactive release builds check for a newer release at most once every 24 hours and print a
notification only; set `WAYFINDER_NO_UPDATE_CHECK=1` to opt out.

## Find and use commands

Run `wayfinder --help` or `wayfinder config edit --help`. Help, JSON descriptions,
man pages and Bash/zsh/fish completion come from the registered actions and their
Zod input schemas. Unavailable service bindings are omitted; discovery never
launches an agent to determine availability. Per-execution preflight still checks
credentials, capabilities and workspace facts before any action proceeds.

`frontier --input tickets.json` evaluates a saved array of normalized Wayfinder
[Tickets](src/domain/tickets.ts). It is useful for offline inspection, replaying a
reported dependency problem, or an agent handing verified data to the evaluator.
It does not fetch Jira or prove that a saved snapshot is still current.
Ticket-based live preview/pickup composition is pending JWB-492.

## Project configuration

`wayfinder init` creates `wayfinder.toml` from the reviewed
[starter](src/configuration/default.toml), or copies an explicitly selected file
with `--from FILE`. It refuses an existing destination. The starter's example
tracker is a placeholder; add your repository, map and tracker before integration.
`wayfinder config show` reads without creating SQLite or changing durable state.
Results are JSON; `--json` makes that machine-output intent explicit.

TOML keeps project requirements, defaults, instruction paths and setup recipes
reviewable, with comments and Bun's existing parser. Zod validates the resulting
object. Secrets belong in credential handles, never this file or command options.

```sh
wayfinder config edit --set model your-model
wayfinder config edit --follow model
wayfinder config edit --editor vi
```

An explicit personal choice persists in local SQLite, keyed by canonical project
configuration path. Following a default stores no override, so new executions see
changed defaults. Required project settings reject conflicting personal choices.
Resolved execution snapshots retain their configuration schema version and source
content hash. [Drizzle](src/persistence/configuration.ts) uses the existing SQLite
connection and tables; reads preserve read-only handles and do not run migrations.
The editor operates on a staged file, validates it and checks for concurrent edits
before replacement. Failed edits preserve the original file.

Setup recipes describe ordered command arrays or explicit scripts; this component
does **not** execute them. The future runner must require approval of recipe/script
versions and preserve failed workspaces for explicit retry. JWB-492 must resolve
configuration, load and hash referenced instructions, supply verified host/agent
availability for the selected host to [planConfiguredLaunch](src/execution/configuration-plan.ts), then
persist the resolved snapshot when an execution is authorized. The pure planner
never claims, launches or writes SQLite. Generic prompts request artifacts and
acceptance evidence; project/workflow policy owns completion gates and human
approval. Passing tests does not authorize closing a ticket.

## Add an action or adapter

An existing feature adds its action in `commands.ts`. For example, the real
[configuration commands](src/configuration/commands.ts) bind `config.show` as:

```ts
show: defineAction({
  description: "Read project configuration and explicit personal choices without changing durable state.",
  input: showInput,
  handler: operations.show,
  output: validateConfigurationOutput,
})
```

[showInput](src/configuration/inputs.ts) is a Zod shape; its descriptions and
metadata supply CLI help. The handler input and result are inferred. This definition
provides `app.config.show.execute({ path })`, `config show --help`, JSON help,
manual content and completion, without another command inventory. A new feature
registers its group in [application.ts](src/application.ts). Optional services use
`dependency(...)`; the same binding guards invocation and reports availability.
[Action tests](test/actions.test.ts) demonstrate a new action, malformed inputs,
negative type checks and completion without invoking its handler.

| Location | Responsibility |
| --- | --- |
| `src/cli/` | Optique integration, typed action boundary, generated help/manual/completion |
| `src/configuration/` | Zod project/local schemas, resolution, safe files and commands |
| `src/domain/` | Portable records, identifiers and adapter contracts |
| `src/frontier/`, `execution/`, `reconciliation/` | Work selection, execution and repair/recovery operations |
| `src/persistence/` | Existing SQLite store and local path conventions |
| `src/adapters/trackers/` | Named tracker implementations; `http.ts` is shared HTTP transport code |
| `src/adapters/harnesses/` | Named command profiles, their registration and shared process behavior |
| `src/adapters/session-hosts/t3/` | T3 transport and session protocol |
| `src/adapters/workspaces/` | Workspace implementations, currently Git |
| `src/distribution/` | Installed binary's build metadata and update notification |

With `host = "t3"`, T3 owns provider execution. Wayfinder sends T3 a configured
provider instance ID, model, options and runtime mode; it does not launch a second
standalone Codex/Claude process. `adapters/harnesses/` describes direct executable
launches as an alternative path. The older portable `HarnessAdapter` interface is
a launch contract shared by both paths, not a dependency between them. JWB-492
must resolve `agent`/`t3.provider` against the selected T3 host's provider instances,
reject missing or ambiguous selections, and supply that host's available providers
to the planner. A local executable check cannot establish T3 provider availability.

A command harness such as [Codex](src/adapters/harnesses/codex.ts) has its own
profile file. Add a profile to [profiles.ts](src/adapters/harnesses/profiles.ts);
name types, name validation and discovery derive from that registration. Protocols
with several responsibilities get a folder, as T3 does. A file is not proof of
runtime availability: executable/platform checks and verified adapter capabilities
still determine what is offered.

`dist/` is ignored build output. The [release workflow](.github/workflows/release.yml)
injects version and release API URL from GitHub's repository context; production
update code contains no repository URL. Builds without an endpoint skip network
and cache activity. `WAYFINDER_UPDATE_URL` remains an explicit endpoint override.

`test/fixtures/` contains inputs consumed by automated checks. `docs/` retains
contracts, architectural decisions and protocol qualification evidence. Temporary
library probes, demonstration projects and PR review transcripts belong in review
history, not a parallel source of product behavior.

## Principles

- The tracker is the durable source of execution truth.
- A human owns a claim; a Wayfinder run identifies the executing session.
- Frontier discovery is read-only and stable.
- Claims happen only after every local and remote preflight succeeds.
- Unsupported capabilities fail explicitly.
- Stale leases never silently reassign work.
- Product-planning systems may read tracker progress but are not required for
  pickup or execution.

## Development

```sh
bun test
bun run typecheck
bun run check
bun run build
```

Wayfinder CLI is licensed under the [MIT License](LICENSE).
