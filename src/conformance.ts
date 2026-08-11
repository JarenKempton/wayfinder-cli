import { AdapterClient, AdapterProtocolError, type AdapterProtocolErrorCode } from "./protocol.ts";

export interface ConformanceCheck {
  name: string;
  ok: boolean;
  evidence: string;
}

export interface ConformanceReport {
  ok: boolean;
  executable: string;
  checks: ConformanceCheck[];
}

const CREDENTIAL_HANDLE = "credential-provider:conformance";

/**
 * PROTOTYPE (JWB-280): exercise the subprocess safety contract against an adapter
 * fixture that selects deliberate failure behavior with WAYFINDER_CONFORMANCE_SCENARIO.
 */
export async function runAdapterConformance(executable: string): Promise<ConformanceReport> {
  const checks: ConformanceCheck[] = [];

  const normal = client(executable, "normal");
  const description = await normal.initialize("tracker", "conformance:test", "0.1.0");
  checks.push({
    name: "protocol negotiation",
    ok: description.protocol_versions.includes("1.0"),
    evidence: `${description.name}@${description.version} supports ${description.protocol_versions.join(", ")}`,
  });

  checks.push(
    await expectFailure("incompatible major is rejected", "invalid_response", async () => {
      await client(executable, "incompatible").initialize(
        "tracker",
        "conformance:incompatible",
        "0.1.0",
      );
    }),
    await expectFailure(
      "unknown method",
      "rpc_error",
      async () => {
        await normal.call("conformance.unknown");
      },
      -32601,
    ),
    await expectFailure("deadline terminates subprocess", "timeout", async () => {
      await client(executable, "hang", { timeoutMs: 30 }).call("conformance.probe");
    }),
    await expectFailure("message limit terminates subprocess", "message_too_large", async () => {
      await client(executable, "oversized", { maxMessageSize: 256 }).call("conformance.probe");
    }),
    await expectFailure("crash is isolated", "process_exit", async () => {
      await client(executable, "crash").call("conformance.probe");
    }),
  );

  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  checks.push(
    await expectFailure("cancellation terminates subprocess", "cancelled", async () => {
      await client(executable, "hang", { timeoutMs: 1_000 }).call("conformance.probe", undefined, {
        signal: controller.signal,
      });
    }),
  );

  const credential = await client(executable, "credential", {
    environment: { WAYFINDER_CREDENTIAL_HANDLE: CREDENTIAL_HANDLE },
  }).call<{ handle: string; argv: string[] }>("conformance.probe");
  checks.push({
    name: "credential handle is environment-scoped",
    ok: credential.handle === CREDENTIAL_HANDLE && !credential.argv.includes(CREDENTIAL_HANDLE),
    evidence: "adapter received the provider handle through the environment, not argv",
  });

  const recovered = await client(executable, "normal").initialize(
    "tracker",
    "conformance:recovery",
    "0.1.0",
  );
  checks.push({
    name: "fresh call survives prior failure",
    ok: recovered.name === description.name,
    evidence: "a fresh subprocess negotiated after timeout, cancellation, size failure, and crash",
  });

  return { ok: checks.every((check) => check.ok), executable, checks };
}

function client(
  executable: string,
  scenario: string,
  options: {
    timeoutMs?: number;
    maxMessageSize?: number;
    environment?: Record<string, string>;
  } = {},
) {
  const command = executable.endsWith(".ts") ? [process.execPath, executable] : executable;
  return new AdapterClient(command, {
    ...options,
    environment: { ...options.environment, WAYFINDER_CONFORMANCE_SCENARIO: scenario },
  });
}

async function expectFailure(
  name: string,
  code: AdapterProtocolErrorCode,
  operation: () => Promise<void>,
  rpcCode?: number,
): Promise<ConformanceCheck> {
  try {
    await operation();
    return { name, ok: false, evidence: "operation unexpectedly succeeded" };
  } catch (error) {
    const ok =
      error instanceof AdapterProtocolError &&
      error.code === code &&
      (rpcCode === undefined || error.rpcCode === rpcCode);
    return {
      name,
      ok,
      evidence: ok
        ? `observed ${code}${rpcCode === undefined ? "" : ` (${rpcCode})`}`
        : String(error),
    };
  }
}
