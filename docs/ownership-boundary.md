# Wayfinder ownership boundary

Status: accepted for the Wayfinder CLI v1 design.

This decision separates the shared Wayfinder workflow from the portable local
runtime. The MCP/skill layer explains and presents the workflow; the Wayfinder
CLI executes tracker-backed agent work. Neither layer owns Product Pipeline
state on behalf of the other.

## Ownership

### MCP/skill layer

The MCP/skill layer owns the human- and agent-facing Wayfinder contract:

- the map, ticket, role, frontier, claim-before-work, and resolution-transaction
  concepts;
- the canonical workflow philosophy and role instructions;
- MCP-facing tool names, descriptions, input schemas, choice UI, and prompts;
- map authoring, decision interviews, and presentation of tracker context;
- Product Pipeline and other portfolio integrations, when a product chooses to
  provide them; and
- translating a user interaction into one explicit CLI operation.

The layer may read CLI results to present progress, but it must not treat chat
history as coordination state or infer that an operation succeeded.

### Wayfinder CLI

The CLI owns portable execution mechanics:

- resolving qualified tracker, workspace, map, ticket, claim, and run
  references;
- normalizing tracker records and dependencies through adapters;
- computing a stable, read-only frontier;
- preflighting and conditionally claiming exactly one selected ticket;
- preparing and retaining workspaces;
- selecting and launching a harness from explicit configuration;
- recording local runs, leases, heartbeats, steps, snapshots, and receipts;
- supervising, stopping, resuming, and recovering runs; and
- verifying compensation or reporting that recovery is required.

The CLI does not define the Wayfinder philosophy, own MCP tool definitions,
author maps, choose a ticket on the user's behalf without an explicit policy,
or read or write Product Pipeline state. Product systems may independently read
tracker progress; they are not an execution dependency.

Tracker adapters own only vendor mechanics. They return normalized facts and
perform capability-checked mutations requested by core. Frontier eligibility,
transaction ordering, leases, and recovery decisions remain in portable CLI
core.

## Stable crossing contract

MCP tools and skills integrate with the CLI as an external client of its public
command interface. They must not import internal TypeScript modules, inspect the
SQLite ledger, invoke an adapter directly, or depend on human-formatted output.

### Inputs

An operation supplies:

- an explicit command and operation-specific options;
- fully qualified references, or input that `wayfinder resolve` can qualify;
- an exact ticket or an explicit selection policy for noninteractive pickup;
- adapter, workspace, harness, and credential-provider references where the
  operation requires them; and
- an optional idempotency/correlation identifier when the command contract
  offers one.

Secrets cross only through credential-provider handles or scoped environment
variables, never command arguments, ordinary configuration, logs, or receipts.
Interactive selection belongs to the calling experience; it passes the one
selected ticket back to the CLI. Frontier reads never claim or otherwise
mutate tracker state.

### Outputs

Machine consumers request `--json`. A successful response contains:

- the CLI contract version;
- the operation and its outcome;
- canonical qualified references;
- the normalized tracker or run snapshot relevant to the operation;
- exact capabilities used or found missing; and
- structured receipts for every attempted mutation, including verification
  state.

Commands that start or recover work also return a stable run reference. Human
diagnostics go to stderr; stdout is reserved for the requested machine result.
The tracker remains the durable coordination truth. The local ledger is an
execution and recovery record, not a replacement tracker.

### Versioning

The public CLI JSON contract and the external adapter protocol are separately
versioned. Every machine-readable response identifies its CLI contract major.
Additive fields and enum values may be introduced within a major, so clients
must ignore unknown fields and handle unknown capabilities explicitly. Removing
or redefining a field, operation, outcome, or error meaning requires a new CLI
contract major.

Adapter protocol negotiation follows its own rules in
[`adapter-protocol.md`](adapter-protocol.md). An MCP/skill integration depends
on the CLI contract, not on a particular adapter protocol or vendor adapter.

### Failure behavior

- Invalid input, unresolved references, incompatible contract majors, missing
  capabilities, failed preflights, and selection ambiguity fail before claim.
- Unsupported behavior is an explicit typed failure, never a downgraded or
  inferred success.
- A post-claim failure triggers compensation from the recorded tracker
  snapshot. The result is `compensated` only after restoration is verified.
- A collision or ambiguous mutation/verification result is not success. The
  CLI preserves evidence and reports `recovery_required` when it cannot prove a
  safe final state.
- Cancellation and timeouts follow the same transaction rules; they do not
  silently release a claim, reassign a ticket, delete a workspace, or erase run
  history.
- Process exit status distinguishes success from failure, while structured JSON
  carries the stable error code, phase, retryability, references, and receipts.

The calling MCP tool or skill presents these outcomes and may ask the human for
a decision. It must not conceal an ambiguous result, synthesize a successful
receipt, or compensate by directly mutating the tracker.

## Consequences

Wayfinder concepts and MCP tools remain usable with another conforming runtime,
and the CLI remains usable from a terminal, automation, or a future client that
does not load the skills. Adding or changing MCP tools is not implementation
work for this CLI map. Adding a tracker, workspace, or harness integration is
CLI work only when it conforms to the portable contracts and advertises no
capability it cannot verify.
