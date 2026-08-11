import type { CapabilitySet } from "./domain.ts";

export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface RpcResponse {
  jsonrpc: "2.0";
  id: string;
  result?: unknown;
  error?: RpcError;
}

export interface AdapterDescription {
  name: string;
  version: string;
  protocol_versions: string[];
  capabilities: CapabilitySet;
}

interface InitializeResult {
  adapter: AdapterDescription;
}

export interface AdapterClientOptions {
  timeoutMs?: number;
  maxMessageSize?: number;
  environment?: Record<string, string>;
}

export class AdapterClient {
  readonly #path: string;
  readonly #timeoutMs: number;
  readonly #maxMessageSize: number;
  readonly #environment: Record<string, string>;

  constructor(path: string, options: AdapterClientOptions = {}) {
    if (!path) throw new Error("Adapter path is required");
    this.#path = path;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
    this.#environment = options.environment ?? {};
  }

  async initialize(
    kind: "tracker" | "harness" | "workspace",
    workspace: string,
    coreVersion: string,
  ) {
    const result = await this.call<InitializeResult>("adapter.initialize", {
      protocol_version: PROTOCOL_VERSION,
      core_version: coreVersion,
      adapter_kind: kind,
      workspace,
    });
    if (!result.adapter.protocol_versions.some((version) => version.split(".")[0] === "1")) {
      throw new Error(`Adapter ${result.adapter.name} does not support protocol major 1`);
    }
    return result.adapter;
  }

  async call<T>(method: string, params?: unknown): Promise<T> {
    const request: RpcRequest = { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
    const process = Bun.spawn([this.#path], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...processEnv(), ...this.#environment },
    });
    process.stdin.write(`${JSON.stringify(request)}\n`);
    process.stdin.end();

    const timer = setTimeout(() => process.kill(), this.#timeoutMs);
    try {
      const bytes = await new Response(process.stdout).bytes();
      const exitCode = await process.exited;
      if (bytes.byteLength > this.#maxMessageSize) {
        throw new Error(`Adapter response exceeds ${this.#maxMessageSize} bytes`);
      }
      if (exitCode !== 0) throw new Error(`Adapter exited unsuccessfully with code ${exitCode}`);
      const line = new TextDecoder().decode(bytes).trim();
      const response = JSON.parse(line) as RpcResponse;
      if (response.jsonrpc !== "2.0" || response.id !== request.id) {
        throw new Error("Invalid JSON-RPC response envelope");
      }
      if (response.error) {
        throw new Error(`Adapter error ${response.error.code}: ${response.error.message}`);
      }
      return response.result as T;
    } finally {
      clearTimeout(timer);
    }
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
