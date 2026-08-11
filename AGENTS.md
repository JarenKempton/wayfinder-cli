# Agent instructions

## Project intent

Nav is a portable orchestration CLI for Wayfinder-style maps. Preserve tracker,
harness, model, and workspace independence in all core packages.

The implementation language is TypeScript and the build/runtime tool is Bun.
Bun-specific behavior belongs in narrow platform modules; portable domain and
transaction logic should remain ordinary TypeScript.

## Non-negotiable behavior

- Tracker state is durable coordination truth; chat history is not.
- Frontier reads do not mutate anything.
- Claim before work and use conditional mutations where a tracker supports them.
- Do not advertise capabilities an adapter cannot verify.
- Never automatically release or reassign an expired claim.
- Never delete a workspace as a side effect of stopping a run.
- Never pass secrets in process arguments, logs, receipts, or ordinary config.
- Product Pipeline and other portfolio systems stay outside the execution core.

## Engineering rules

- Keep public protocol changes backward compatible within a protocol major.
- Use argument arrays with `Bun.spawn`; never compose shell commands.
- Add tests for every state-machine transition and failure compensation path.
- Run `bun test`, `bun run typecheck`, and `bun run check` before handoff.
- Do not add a live tracker mutation until its fake/conformance adapter proves
  collision, verification, compensation, and ambiguous-failure behavior.
