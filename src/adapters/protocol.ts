import { z } from "zod";
import type { CapabilitySet } from "../domain/model.ts";

export const PROTOCOL_VERSION = "1.0";
export const DEFAULT_MAX_MESSAGE_SIZE = 1024 * 1024;

interface RpcRequest {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params?: unknown;
}

const responseSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.string(),
  result: z.unknown().optional(),
  error: z
    .object({ code: z.number(), message: z.string(), data: z.unknown().optional() })
    .optional(),
});
type RpcResponse = z.infer<typeof responseSchema>;
const initializeSchema = z.object({
  adapter: z.object({
    name: z.string(),
    version: z.string(),
    protocol_versions: z.array(z.string()),
    capabilities: z.record(z.string(), z.literal(true)),
  }),
});
export interface AdapterDescription {
  name: string;
  version: string;
  protocol_versions: string[];
  capabilities: CapabilitySet;
}

export type AdapterProtocolErrorCode =
  | "timeout"
  | "cancelled"
  | "message_too_large"
  | "process_exit"
  | "invalid_response"
  | "rpc_error";

export class AdapterProtocolError extends Error {
  constructor(
    readonly code: AdapterProtocolErrorCode,
    message: string,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "AdapterProtocolError";
  }
}

export interface AdapterClientOptions {
  timeoutMs?: number;
  maxMessageSize?: number;
  environment?: Record<string, string>;
  deadlineScheduler?: AdapterDeadlineScheduler;
}

export interface AdapterDeadlineScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

const systemDeadlineScheduler: AdapterDeadlineScheduler = {
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

export interface AdapterCallOptions {
  signal?: AbortSignal;
}

export class AdapterClient {
  readonly #command: string[];
  readonly #timeoutMs: number;
  readonly #maxMessageSize: number;
  readonly #environment: Record<string, string>;
  readonly #deadlineScheduler: AdapterDeadlineScheduler;

  constructor(command: string | readonly string[], options: AdapterClientOptions = {}) {
    const normalized = typeof command === "string" ? [command] : [...command];
    if (normalized.length === 0 || normalized.some((argument) => argument.length === 0)) {
      throw new Error("Adapter command is required");
    }
    this.#command = normalized;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#maxMessageSize = options.maxMessageSize ?? DEFAULT_MAX_MESSAGE_SIZE;
    this.#environment = options.environment ?? {};
    this.#deadlineScheduler = options.deadlineScheduler ?? systemDeadlineScheduler;
  }

  async initialize(
    kind: "tracker" | "harness" | "workspace" | "environment",
    workspace: string,
    coreVersion: string,
    options: AdapterCallOptions = {},
  ) {
    const result = await this.call(
      "adapter.initialize",
      {
        protocol_version: PROTOCOL_VERSION,
        core_version: coreVersion,
        adapter_kind: kind,
        workspace,
      },
      options,
      initializeSchema,
    );
    if (!result.adapter.protocol_versions.some((version) => version.split(".")[0] === "1")) {
      throw new AdapterProtocolError(
        "invalid_response",
        `Adapter ${result.adapter.name} does not support protocol major 1`,
      );
    }
    return result.adapter;
  }

  async call<T>(
    method: string,
    params: unknown,
    options: AdapterCallOptions,
    schema: z.ZodType<T>,
  ): Promise<T>;
  async call(method: string, params?: unknown, options?: AdapterCallOptions): Promise<unknown>;
  async call(
    method: string,
    params?: unknown,
    options: AdapterCallOptions = {},
    schema: z.ZodType = z.unknown(),
  ): Promise<unknown> {
    if (options.signal?.aborted) {
      throw new AdapterProtocolError("cancelled", "Adapter call was cancelled");
    }

    const request: RpcRequest = { jsonrpc: "2.0", id: crypto.randomUUID(), method, params };
    const child = Bun.spawn(this.#command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "inherit",
      env: { ...processEnvironment(), ...this.#environment },
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.end();

    let failure: AdapterProtocolError | undefined;
    const stop = (next: AdapterProtocolError) => {
      if (failure) return;
      failure = next;
      child.kill();
    };
    const cancelDeadline = this.#deadlineScheduler.schedule(
      () => stop(new AdapterProtocolError("timeout", `Adapter call exceeded ${this.#timeoutMs}ms`)),
      this.#timeoutMs,
    );
    const onAbort = () => stop(new AdapterProtocolError("cancelled", "Adapter call was cancelled"));
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const bytes = await readLimited(child.stdout, this.#maxMessageSize, () =>
        stop(
          new AdapterProtocolError(
            "message_too_large",
            `Adapter response exceeds ${this.#maxMessageSize} bytes`,
          ),
        ),
      );
      const exitCode = await child.exited;
      if (failure) throw failure;
      if (exitCode !== 0) {
        throw new AdapterProtocolError(
          "process_exit",
          `Adapter exited unsuccessfully with code ${exitCode}`,
        );
      }

      const text = new TextDecoder().decode(bytes);
      const lines = text.split("\n").filter((line) => line.length > 0);
      if (lines.length !== 1) {
        throw new AdapterProtocolError(
          "invalid_response",
          "Adapter must return exactly one JSON-RPC object per call",
        );
      }

      let response: RpcResponse;
      try {
        response = responseSchema.parse(JSON.parse(lines[0] ?? ""));
      } catch {
        throw new AdapterProtocolError("invalid_response", "Adapter returned invalid JSON");
      }
      if (response.jsonrpc !== "2.0" || response.id !== request.id) {
        throw new AdapterProtocolError("invalid_response", "Invalid JSON-RPC response envelope");
      }
      if (response.error) {
        throw new AdapterProtocolError(
          "rpc_error",
          `Adapter error ${response.error.code}: ${response.error.message}`,
          response.error.code,
        );
      }
      if (!("result" in response)) {
        throw new AdapterProtocolError(
          "invalid_response",
          "Adapter response contains neither result nor error",
        );
      }
      const parsed = schema.safeParse(response.result);
      if (!parsed.success)
        throw new AdapterProtocolError("invalid_response", "Invalid adapter result");
      return parsed.data;
    } finally {
      cancelDeadline();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  exceeded: () => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      exceeded();
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(length > limit ? 0 : length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function processEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
