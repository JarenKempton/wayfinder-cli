# JWB-278: Session surfaces for target harnesses and operating systems

## Question

Which documented, non-UI-automation surfaces can Wayfinder CLI use to launch and manage
sessions for its v1 harness targets, and on which of macOS, Linux, and Windows
are those surfaces supported?

## Result

Wayfinder CLI should not treat “the executable exists” as evidence of a managed session.
The targets fall into three integration classes:

1. **Stable machine-facing lifecycle:** Codex app-server, Pi SDK/RPC, and
   OpenCode server expose addressable sessions plus programmatic operations.
2. **Documented CLI persistence:** Claude Code and Cursor expose launch,
   listing/pickers, and resume, but their public CLI references do not define a
   general session status/interrupt/close protocol. Wayfinder CLI can launch them and can
   stop the child process it owns, but should not advertise full lifecycle.
3. **Host/command surfaces:** T3 Code is itself a visible multi-session host;
   the generic command adapter owns only a spawned process. Neither should be
   inferred to have a vendor-neutral durable-session lifecycle.

The repository's current discovery logic assigns `process_launch` to every
found executable. That is a reasonable availability probe, but it is not enough
to assign `session_create`, `session_resume`, `session_status`,
`session_interrupt`, or `session_close`; those require an adapter-specific
surface and conformance tests.

## Evidence matrix

Legend: **yes** is explicitly supported by the cited surface; **process** means
Wayfinder CLI can supervise the process it launched but has no documented vendor session
operation; **no claim** means the primary documentation inspected does not
establish the capability.

| Harness | Best non-UI surface | Create / resume | Status | Interrupt | Close/delete | Visible multi-session | OS qualification |
|---|---|---|---|---|---|---|---|
| T3 Code | `t3` server plus desktop/web client and provider adapters | T3 creates provider threads and presents conversations, but its public docs do not define a stable external session-control API for Wayfinder CLI | no claim | no claim | no claim | yes (product UI) | Desktop installation is documented for Windows, macOS, and Arch Linux; the server/remote workflow is documented for Linux hosts |
| Pi | `pi --mode rpc` or the published TypeScript SDK/runtime | yes: CLI `--session`, `--continue`, `--resume`; `SessionManager` and `AgentSessionRuntime` create/open/switch sessions | yes in-process/RPC via session state/events | yes: SDK `abort()` (and process supervision) | process/dispose; no durable-session delete operation documented | selectors/list APIs, not a multi-pane host | npm package and project docs include Windows-specific shell/terminal behavior; macOS and Linux are supported by the same Node CLI |
| Claude Code | CLI / stream-json print mode | yes: `--continue` and `--resume [session-id]` | no general session-status CLI documented | process (interactive cancellation is terminal-driven) | no claim | picker only; current CLI also has background agents, but that is a distinct agent surface | macOS, Linux, Windows via WSL or native Git Bash are explicit system requirements |
| Codex | stable `codex app-server` JSON-RPC; CLI for interactive use | yes: `thread/start`, `thread/resume`; CLI `resume` | yes: thread status/events | yes: `turn/interrupt` | archive/delete exist in CLI; app-server exposes durable thread operations, but a stable `thread/close` operation is not documented | client-defined; CLI picker is not itself multi-session | macOS/Linux are standard CLI targets; native Windows support/sandboxing remains qualified/experimental, so prefer WSL unless a Windows adapter passes conformance |
| Cursor | `cursor-agent` CLI | yes: new invocation; `ls`, `resume`, and `--resume <chat-id>` | no claim (`status` is authentication status) | process | no claim | conversation list/picker only | macOS, Linux, and Windows **through WSL** are explicitly documented |
| OpenCode | headless HTTP server (OpenAPI), CLI, or ACP | yes: session endpoints; CLI `--continue`/`--session` | yes: `GET /session/:id` and server events | yes: `POST /session/:id/abort` | yes: `DELETE /session/:id` and CLI `session delete` | web/TUI clients can attach to one server | macOS/Linux supported; native Windows is available but WSL is recommended and some Windows installation paths remain qualified |
| Generic command | argv-based subprocess | process / no durable resume contract | process only | process signal only | process only | no | portable if the configured executable and argv are valid on that OS |

## Harness notes

### T3 Code

T3 Code describes itself as “a harness for your AI harnesses.” Its repository
documents a server launched with `t3`, desktop packages for Windows, macOS, and
Arch Linux, remote backends, and a UI that hosts provider conversations. The
remote-access documentation explains that the desktop SSH launcher starts or
reuses a remote T3 server and that Linux servers can continue running after
logout. This proves a visible host and server surface, but not a supported
third-party lifecycle API that Wayfinder CLI can bind to. Treat T3 integration as a
dedicated adapter whose verified provider/thread contract determines its
capabilities, not as an executable alias. [T3 Code repository](https://github.com/pingdotgg/t3code),
[remote access](https://github.com/pingdotgg/t3code/blob/main/docs/user/remote-access.md)

### Pi

Pi has the broadest embedding surface after Codex/OpenCode. Its CLI persists
JSONL sessions, accepts a session path or partial ID, continues the most recent
session, and exposes a selector. RPC mode uses newline-delimited JSON over
stdin/stdout. The SDK exposes `sessionId`, streaming state/events, `abort()`,
`dispose()`, session listing, and runtime-level new/switch/fork operations.
Those are sufficient to build a managed adapter without terminal scraping.
[Pi coding-agent README](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md),
[Pi SDK](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/sdk.md),
[session format/API](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/session.md)

### Claude Code

Anthropic documents interactive launch, print/streaming modes, continue, and
resume-by-ID. These support deterministic launch and durable resume. The public
CLI reference inspected does not specify general commands to query arbitrary
session run state, interrupt a session by ID, or close/delete a durable
conversation. Therefore `process_launch` and `session_resume` are supportable;
managed interruption should initially mean stopping the exact child process Wayfinder CLI
started, not claiming a vendor session interrupt API.
[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage),
[Claude Code setup/system requirements](https://docs.anthropic.com/en/docs/claude-code/getting-started)

### Codex

Codex app-server is the preferred adapter boundary. Its stable JSON-RPC surface
documents `thread/start`, `thread/resume`, status in thread notifications, turn
events, and `turn/interrupt`. It also supports generated stable schemas, which
is valuable for conformance and protocol-drift detection. The ordinary CLI has
interactive `resume`, `fork`, `archive`, `delete`, and non-interactive `exec`,
but process-oriented CLI wrapping is weaker than app-server for live state.
Experimental app-server methods must not be advertised as stable capabilities.
[Codex app-server protocol](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md),
[Codex CLI repository](https://github.com/openai/codex)

### Cursor

Cursor documents `cursor-agent` interactive and non-interactive modes, `ls`,
`resume`, and `--resume <chat-id>`. Its `status` command checks authentication,
not a conversation's run status. No public session interrupt or close/delete
command is present in the cited parameter reference. Accordingly this adapter
should remain launch + durable resume, with owned-process stopping only.
[Cursor CLI overview](https://docs.cursor.com/en/cli/overview),
[Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters),
[Cursor CLI installation](https://docs.cursor.com/en/cli/installation)

### OpenCode

OpenCode exposes the strongest complete lifecycle surface: a headless server
with an OpenAPI description, session get/list/create operations, session abort,
and session delete. The CLI also lists/deletes sessions and resumes by ID, and
ACP provides a separate nd-JSON integration surface. The server API, rather
than terminal UI driving, should back the managed/lifecycle adapter.
[OpenCode CLI](https://opencode.ai/docs/cli/),
[OpenCode server API](https://opencode.ai/docs/server/),
[OpenCode installation](https://opencode.ai/docs),
[OpenCode on Windows/WSL](https://opencode.ai/docs/windows-wsl/)

## Recommended capability policy

Capability discovery should be a two-stage intersection:

```text
adapter implementation capabilities
  ∩ installed harness version/protocol probe
  ∩ current OS support
  = advertised capabilities
```

Initial conservative assignments:

- **Codex app-server, Pi RPC/SDK, OpenCode server:** implement managed adapters,
  but advertise each lifecycle bit only after version negotiation/probing and
  adapter conformance.
- **Claude Code and Cursor:** `prompt_generation`, `process_launch`,
  `session_resume`, model/tool flags where explicitly probed; do not claim
  session status/interrupt/close.
- **T3 Code:** `visible_multi_session` belongs to the T3 host adapter. Any
  lifecycle claims must come from its supported server/provider protocol.
- **Generic command:** `prompt_generation` and `process_launch` only. PID/handle
  supervision is a Wayfinder CLI run capability, not proof of durable harness sessions.
- **Windows:** represent `windows-native` and `windows-wsl` as different
  environments during preflight. Cursor explicitly supports WSL; Codex and
  OpenCode carry Windows qualifications; collapsing these into one “Windows”
  boolean would overstate compatibility.

## Repository implication

`src/adapters.ts` currently reports the same capability set for every located
harness executable. The implementation ticket following this research should
replace that uniform inference with adapter-specific, OS-qualified probes. A
successful `Bun.which()` may establish only executable availability. It cannot
establish a stable session ID, resumability, live status, interrupt semantics,
or safe closure.

## Evidence limitations

- The Jira ticket and parent map were read through the authenticated Atlassian
  CLI; their stated research question and v1 target list define this artifact's
  boundary.
- T3 Code is early and its public repository says there is no standalone public
  documentation site. Its capability row is intentionally conservative until
  a versioned server/provider API is documented or proven by conformance.
- Product releases can change quickly. Adapter capability probes must remain
  authoritative at runtime; this matrix is design evidence, not a permanent
  version allowlist.
