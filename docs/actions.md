# Executable actions and derived discovery

An action is the callable implementation plus its input contract and required
service bindings. Help and completion are views of those objects. Registering an
action once changes what can be called and what can be discovered together.

```ts
const app = createApplication(services);
const result = await app.config.show.execute({ path: "wayfinder.toml" });
```

The compiler checks `config.show`, the accepted fields, and the returned result.
It rejects `config.shwo`, `show.execute({ editor: "vi" })`, and invalid personal
setting names. CLI strings are untrusted input: the command-line boundary walks
the same tree, parses its field definitions, and invokes the same action. There
is no string-based dispatch inside application code.

## Definition and registration

`src/actions/configuration.ts` is a concrete example. Each action specifies:

- Its description, field definitions, and handler. Types are inferred from the
  field parsers and handler; there is no independently maintained input interface,
  option switch, or usage string.
- Actual service bindings required by the handler. After the common binding
  check, the handler receives those services with non-optional types.
- Any cross-field validation and external result validation it needs. Both CLI
  calls and direct calls pass through validation. CLI rendering stays separate
  from handler results; `--help` and `--json` are transport concerns.

Action groups compose in `src/application.ts`. `composeActions` preserves their
inferred types and rejects duplicate root registrations at compile time and
runtime. A new action goes in its owning group; a new group is registered once.
There are no secondary edits to the CLI router, help list, manual, or completion
scripts. Aliases, where needed, are part of the action definition.

`src/actions/input.ts` owns field parsing and inference, `definition.ts` owns
binding/invocation, `catalog.ts` projects the tree, and `command-line.ts` handles
CLI syntax. These modules have no Bun, tracker, workspace, or database dependency.
The remaining files hold action definitions grouped by concern. CLI composition
does not add a workflow engine or execute setup.

## Availability has one owner

A missing required service makes an action unavailable. That same result is used
to omit it from normal help, manual entries and completion, and to reject direct
or CLI execution with an explanation. For example, without a lifecycle service,
`stop` is absent from help and cannot open the state store or run a handler.
Providing that service and composing the application makes it discoverable and
callable together. Availability is derived from the actual bindings; no separate
`enabled` flag or capability list controls action discovery.

Composition and help do not contact a tracker, probe a session, initialize a
SQLite store, or execute handlers. Availability means the implementation and its
required services are composed. A particular ticket, workspace, credential or
remote connection still needs request-specific preflight. Help cannot prove an
arbitrary future target is reachable or authorized. Existing adapter capability
and transaction verification checks continue to enforce that boundary.

The existing `reconcile statuses` command supports read-only audit as well as
input-selected repair/recovery. Audit remains available without mutation
services; the repair/recovery input descriptions state their additional service
requirements, and their existing guards still enforce them before mutation.
Discovery of the audit action is not verification of a live repair request.

Generated shell scripts contain no command names. On each completion request
they call `wayfinder completions <shell> --at <prefix>`. That invocation composes
the current application and returns available children or options. An installed
completion script therefore does not preserve yesterday's action list.

## Configuration boundaries

- `configuration/schema.ts`: portable project/default/required/personal resolution.
- `configuration/files.ts`: local path resolution, TOML parsing, content identities
  and instruction loading.
- `configuration/local-settings.ts`: read-only SQLite access to personal choices.
- `configuration/project-files.ts`: non-overwrite initialization, staged editing,
  and explicit personal-choice writes through the existing StateStore.
- `configuration/default.toml`: reviewed starter content, embedded in the binary.
- `actions/configuration.ts`: callable configuration actions and inferred inputs.

TOML remains the static, comment-friendly project format for compatibility with
the existing config shape. Action type safety comes from executable schemas,
not from making users write TypeScript configuration. Format version 1 is a
compatibility marker; changing settings automatically changes the source hash
without a user-maintained revision counter.

This revision does not migrate the existing SQLite schema to an ORM. Its
parameterized storage operations remain behind the storage boundary; adopting a
typed database schema can be evaluated independently of action discovery.

## Verification

`test/actions.test.ts` registers an otherwise unknown sample action and verifies
that typed calls, CLI dispatch, help, manual, and completion all derive from it.
Removing its service removes discovery and prevents invocation. Tests also check
real application bindings without invoking lifecycle services or creating stores,
live completion queries, malformed input, and duplicate registration. Compile-only
negative examples use `@ts-expect-error`; typecheck fails if invalid action names,
arguments, results or registrations become accepted.
