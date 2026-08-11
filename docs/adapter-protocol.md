# Wayfinder Adapter Protocol 1.0

External adapters are executables named `wayfinder-adapter-<name>`. They exchange one
JSON-RPC 2.0 object per line over stdin/stdout. Stdout is reserved for protocol
messages; structured diagnostics go to stderr.

## Initialization

Core sends `adapter.initialize` before any other method:

```json
{"jsonrpc":"2.0","id":"1","method":"adapter.initialize","params":{"protocol_version":"1.0","core_version":"0.1.0","adapter_kind":"tracker","workspace":"jira:example:ABC"}}
```

`adapter_kind` is one of `tracker`, `workspace`, `environment`, or `harness`.
Embedded and executable environment adapters expose the same lifecycle contract;
the protocol transport does not change ownership of application topology.
Environment profile references, plan summaries, warnings, and lifecycle evidence
are adapter-defined and opaque to core. Protocol 1.x does not define a universal
component catalog or local-versus-hosted service-routing schema.

The adapter responds with its identity and exact capabilities:

```json
{"jsonrpc":"2.0","id":"1","result":{"adapter":{"name":"example","version":"1.2.0","protocol_versions":["1.0"],"capabilities":["native_dependencies","conditional_update"]}}}
```

## Transport requirements

- Maximum message size: 1 MiB by default.
- One request ID maps to exactly one response.
- Unknown methods return JSON-RPC `-32601`.
- Incompatible major versions fail initialization.
- Calls are cancellable by terminating the adapter process.
- Secrets must not appear in argv, stdout, stderr, or error data.
- Credential-provider handles may be passed in scoped environment variables.
- Core applies per-call deadlines and treats process exit as an adapter failure.

The canonical JSON Schemas live under [`schemas/`](../schemas/).
