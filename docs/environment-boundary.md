# Development environment boundary

Status: accepted design for JWB-296.

A prepared Git worktree is not necessarily ready for agent work. An application
may still need processes, credentials, hosted dependencies, routing, and health
checks. Wayfinder CLI coordinates that lifecycle through an environment adapter,
but the adapter—not Wayfinder CLI core—owns what the application environment means.

Wayfinder CLI resolves an adapter and an opaque profile reference, requests a
side-effect-free plan, obtains authorization, and coordinates start, readiness,
logs, resume, and stop. It records the adapter's summary, warnings, opaque
environment ID, credential handles, readiness evidence, and log references
without interpreting application topology.

## Portable contract and capabilities

The portable `EnvironmentAdapter` contract is `preflight`, `plan`, `start`,
`verifyReady`, `logs`, `resume`, and `stop`. Operations are gated by the
fine-grained capabilities `environment_plan`, `environment_start`,
`environment_readiness`, `environment_logs`, `environment_resume`, and
`environment_stop`. Missing capabilities are explicit unsupported errors.

`preflight` and `plan` are side-effect free. A plan contains an opaque ID and
profile, a human-readable summary and warnings, and credential-provider handles;
it contains no secret values. `start` requires either recorded human confirmation
or a named explicit automation policy. Interactive runs confirm by default.

`start` returns an opaque environment ID, adapter-defined readiness evidence,
and log references. `resume` must verify actual state and never silently recreate
a stale environment. `stop` is idempotent and receipt-scoped: it may stop only
resources the adapter can prove it owns, and it never deletes a prepared Git
workspace or mutates unrelated hosted resources.

## Opaque profiles and named workspaces

Wayfinder CLI configuration selects only an adapter and an adapter-defined profile. It
does not merge component choices. Precedence is deterministic, from lowest to
highest:

1. workspace or repository defaults;
2. developer-local configuration;
3. map or ticket structured hints;
4. explicit invocation.

The plan request includes a map of opaque workspace names to prepared workspace
paths. This permits an adapter to consume more than one worktree without making
Wayfinder CLI defines repository relationships or assumes sibling directory layouts. How a
profile relates those workspaces is entirely adapter-owned.

Application component catalogs, dependency expansion, local/hosted/off routing,
ports, containers, commands, gateways, health checks, production guards, and
detailed selection interfaces remain outside Wayfinder CLI core. Protocol 1.x does not
standardize those concepts. A later protocol may add a portable model only after
independent prototypes demonstrate that it generalizes without application
coupling.

## Secrets and lifecycle evidence

- Versioned configuration and plans contain credential-provider handles, never
  secret values.
- Secret values use scoped secure channels and never appear in arguments, logs,
  receipts, or ordinary SQLite fields.
- Wayfinder CLI displays and persists bounded plan summaries, warnings, readiness evidence,
  and log references without requiring an application-specific schema.
- A failed readiness check does not become success. Ambiguous or stale state is
  attention-required and retains its evidence.
- Stop and failure cleanup use the exact persisted environment receipt and do not
  imply tracker resolution, claim release, or workspace deletion.

## Embedded and external implementations

Embedded and executable adapters implement the same semantic contract. Bundled,
generally portable behavior may run in process. A separate executable is
appropriate when an environment is independently versioned, organization
specific, implemented in another runtime, or already has a developer-facing
CLI. External adapters use the versioned Wayfinder Adapter Protocol and are discovered
as `wayfinder-adapter-<name>`.

This lets a product-specific tool compose with Wayfinder CLI without compiling its topology
or lifecycle into the portable runtime.

## ResponsiBid ownership

JWB-10, not JWB-296, owns ResponsiBid's concrete local and hybrid developer lane:
PHP and Next.js applications, Docker microservices, gateway configuration,
hosted authentication, developer isolation, production prohibition, deterministic
reset/seed behavior, and concrete profiles. Its prototypes provide the evidence
for those decisions. Wayfinder CLI treats the resulting integration and profile names as
opaque and coordinates only the portable lifecycle described here.
