# Development environment boundary

An environment adapter owns application readiness and execution context.
Core coordinates its lifecycle without interpreting product-specific service
topology, ports, routing, or hosted dependencies.

The [EnvironmentAdapter contract](../src/domain/contracts.ts) and
[environment coordinator](../src/execution/environment.ts) define the executable
interface and authorization checks.

## Lifecycle

Preflight and planning are side-effect free. Plans carry an opaque profile,
summary, warnings, and credential-provider handles; they contain no secrets.
Starting requires recorded human confirmation or an explicit automation policy.
Readiness must be verified before the environment is treated as usable.

Resume verifies the recorded environment rather than silently recreating it.
Stop is idempotent and receipt-scoped: it affects only resources whose ownership
the adapter can prove. It never deletes a prepared Git workspace or implies
claim release or ticket completion. Unknown outcomes retain recovery evidence.

## Workspace and profile ownership

Workspace handles resolve in the environment's frame of reference: a host path,
container mount point, or remote path. Core must not validate all handles as
local filesystem paths or assume sibling repository layouts.

Profiles and their application topology are adapter-owned. Protocol 1.x does
not define a universal component catalog or local-versus-hosted routing schema.
Embedded and external adapters obey the same lifecycle semantics.

Project configuration can describe ordered setup commands and instruction
references; the [configuration schema](../src/configuration/schema.ts) defines
their format. Describing a recipe does not execute it. Setup authorization is
bound to the recipe and referenced script versions. Failed preparation blocks
launch and retains the workspace; explicit retry begins at the failed step.
An environment implementation must enforce these rules when executing setup.

Secrets use scoped secure channels. Plans, receipts, logs, and ordinary database
fields contain only safe references and bounded evidence. Required isolation
must never silently fall back to host execution.
