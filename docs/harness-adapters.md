# Command harness adapters

The bundled command adapters intentionally implement only the `prepare` and `launch`
tiers. Research in [JWB-278](research/JWB-278-session-surfaces.md) identifies richer
machine-facing protocols for Pi, Codex, and OpenCode, but those findings are targets for
future protocol adapters. Executable discovery does not prove a durable session API.

## Implemented matrix

| Name | Exact launch argv | Native launch platforms | Capabilities before detection | Capabilities after detection |
| --- | --- | --- | --- | --- |
| Generic command | configured argv template | configuration-defined | template-derived prepare only | template-derived prepare plus `process_launch` |
| Pi | `pi -p <prompt>` | macOS, Linux, Windows | `prompt_generation` | prepare plus `process_launch` |
| Claude Code | `claude -p <prompt>` | macOS, Linux; Windows through WSL | `prompt_generation` | prepare plus `process_launch` |
| Codex | `codex exec <prompt>` | macOS, Linux; Windows through WSL | `prompt_generation` | prepare plus `process_launch` |
| Cursor | `cursor-agent -p <prompt>` | macOS, Linux; Windows through WSL | `prompt_generation` | prepare plus `process_launch` |
| OpenCode | `opencode run <prompt>` | macOS, Linux, Windows | `prompt_generation` | prepare plus `process_launch` |
| T3 Code | none | none | none | none |

T3 Code is a host integration, not a generic executable wrapper. The registry retains an
unavailable T3 descriptor so configuration can name the planned integration, but it has no
executable and advertises neither `process_launch` nor `visible_multi_session` until a
supported host protocol is implemented and tested.

All command adapters launch with argument arrays and retain the exact child handle for
same-process failure compensation. They do not reconstruct ownership from a PID and do not
advertise `session_create`, `session_resume`, `session_status`, `session_interrupt`, or
`session_close`.

## Command evidence

The argv above follows the vendors' documented non-interactive surfaces:

- [Pi coding-agent CLI](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/README.md#non-interactive-mode)
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive/)
- [Cursor CLI overview](https://docs.cursor.com/en/cli/overview)
- [OpenCode CLI `run`](https://opencode.ai/docs/cli/#run)

The adapter tests assert the complete argv for every profile. During JWB-291 correction,
the same forms were also checked against installed help for Pi 0.82.1, Claude Code 2.1.228,
Codex CLI 0.147.0, and Cursor Agent 2026.07.23-e383d2b. OpenCode was not installed locally,
so its exact `run` form is pinned to the cited official CLI reference and covered by the
same deterministic argv tests.
