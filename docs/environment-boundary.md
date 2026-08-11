# Development environment boundary

Status: accepted design for JWB-296.

Nav owns the transaction around a development environment; an environment
adapter owns the application. Nav selects a named profile, checks advertised
capabilities, schedules lifecycle operations, persists adapter receipts and
readiness evidence, and defines when stop and cleanup may run. It does not know
which services an application has or how they are started.

The environment adapter owns service topology, local-versus-hosted routing,
ports, containers, commands, process groups, application health checks, log
locations, and credential-provider requirements. A Git workspace adapter still
owns checkout/worktree preparation. These are separate stages: a prepared Git
workspace is an input to environment planning.

## Portable contract and capabilities

The portable `EnvironmentAdapter` contract is `preflight`, `plan`, `start`,
`verifyReady`, `logs`, `resume`, and `stop`. Every operation is gated by the
fine-grained capabilities `environment_plan`, `environment_start`,
`environment_readiness`, `environment_logs`, `environment_resume`, and
`environment_stop`. Missing capabilities are reported as unsupported; Nav does
not infer success.

`plan` is side-effect free. It resolves a portable profile into an adapter-owned
plan without exposing secret values. `start` returns an opaque environment ID,
per-service readiness evidence, and log references. `resume` reattaches using
that ID and must verify actual state. `stop` stops only processes/resources in
the adapter receipt; it does not delete the Git workspace, hosted services, or
unrelated shared dependencies.

## Configuration ownership and precedence

Repositories declare portable named profiles and service selections. A profile
contains stable logical service names and selects each as `local`, `hosted`, or
`disabled`; hosted selections may name an abstract target such as `staging`.
Adapter-owned configuration maps those logical names to commands, URLs, ports,
containers, health checks, and credential handles.

Precedence is deterministic, from lowest to highest:

1. repository profile defaults;
2. user-local, uncommitted overrides;
3. explicit invocation overrides.

Higher layers may select a profile or override declared services, but cannot
introduce undeclared application services. Tracker/map routing may select a
profile through normal execution settings; it does not define application
topology. Effective non-secret configuration is recorded with the run.

## Resource and lifecycle rules

- Secrets remain in credential providers. Configuration and plans contain only
  handles; secret values are injected through scoped environment or equivalent
  secure channels and never appear in arguments, logs, receipts, or SQLite.
- The adapter reserves and validates ports during preflight/plan. A collision is
  a failed preflight, not permission for Nav to kill the existing listener.
- The adapter owns spawned process groups and returns opaque ownership evidence.
  Nav persists the receipt before advancing the transaction.
- Logs remain adapter/application artifacts. Nav stores bounded references and
  may stream them, but does not require a universal log format.
- Readiness is application-defined and must distinguish local readiness from an
  externally hosted dependency. Start is not committed until required evidence
  verifies or the profile explicitly marks the dependency external.
- Resume revalidates processes, ports, hosted reachability, and readiness; a
  stale receipt is attention-required, never silently recreated.
- Failure cleanup and explicit stop are receipt-scoped, idempotent, and
  capability-checked. They never delete the prepared workspace or mutate hosted
  services unless a future, separately advertised capability explicitly says so.

## Embedded and external implementations

Both are supported through the same contract. Bundled, generally portable
behavior may be embedded behind an in-process adapter. A separate executable is
justified when the lifecycle is independently versioned, organization-specific,
requires a different runtime, or already has a useful developer-facing CLI.
External adapters use the versioned Nav Adapter Protocol and are discovered as
`nav-adapter-<name>`; Nav passes argument arrays and credential handles, not
shell command strings or secret values.

This keeps Biz App and every company-specific development lifecycle outside Nav
core while allowing their adapters or CLIs to compose with the same orchestration
transaction, capability checks, receipts, and recovery rules.
