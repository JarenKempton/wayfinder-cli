import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const T3_SERVER_VERSION = "0.0.41-nightly.20260909.1426";

export class T3Error extends Error {
  constructor(readonly code: string) {
    super(`T3 ${code}; preserve workspace and claim; explicit recovery required`);
    this.name = "T3Error";
  }
}

export interface T3Runtime {
  environmentId: string;
  serverVersion: string;
  origin: string;
}

export interface T3Connection {
  runtime: T3Runtime;
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface T3Platform {
  readText(path: string): Promise<string>;
  run(argv: readonly string[]): Promise<{ exitCode: number; stdout: string }>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const platform: T3Platform = {
  readText: (path) => readFile(path, "utf8"),
  async run(argv) {
    const child = Bun.spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => child.kill(), 30_000);
    try {
      const [stdout, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        child.exited,
      ]);
      return { stdout, exitCode };
    } finally {
      clearTimeout(timeout);
    }
  },
  fetch: (url, init) => fetch(url, init),
};

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new T3Error("invalid_response");
  return value as Record<string, unknown>;
}

export function nonempty(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new T3Error("invalid_response");
  return value;
}

function localOrigin(value: unknown): string {
  const url = new URL(nonempty(value));
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new T3Error("unsafe_origin");
  return url.origin;
}

export interface T3ConnectOptions {
  home?: string;
  command?: string;
  platform?: T3Platform;
  expected?: Pick<T3Runtime, "environmentId" | "serverVersion">;
}

/** Local discovery/auth only. Never starts a server, invokes npx, or persists credentials. */
export async function connectT3(options: T3ConnectOptions = {}): Promise<T3Connection> {
  const io = options.platform ?? platform;
  const home = options.home ?? join(homedir(), ".t3");
  const command = options.command ?? "t3";
  let state: Record<string, unknown> | undefined;
  let stateDirectory = "userdata";
  for (const directory of ["userdata", "dev"]) {
    let raw: string;
    try {
      raw = await io.readText(join(home, directory, "server-runtime.json"));
    } catch {
      continue;
    }
    // A present but invalid runtime is not permission to switch environments.
    try {
      state = object(JSON.parse(raw));
    } catch {
      throw new T3Error("invalid_discovery");
    }
    stateDirectory = directory;
    break;
  }
  if (!state) throw new T3Error("server_unavailable");
  if (state.version !== 1) throw new T3Error("invalid_discovery");
  let origin: string;
  try {
    origin = localOrigin(state.origin);
  } catch {
    throw new T3Error("unsafe_origin");
  }

  async function request(
    token: string | undefined,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    if (!path.startsWith("/api/orchestration/") && path !== "/.well-known/t3/environment")
      throw new T3Error("invalid_route");
    try {
      const response = await io.fetch(`${origin}${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) throw new T3Error(`http_${response.status}`);
      return await response.json();
    } catch (error) {
      if (error instanceof T3Error) throw error;
      throw new T3Error("request_unavailable");
    }
  }

  const descriptor = object(await request(undefined, "GET", "/.well-known/t3/environment"));
  const runtime = {
    origin,
    environmentId: nonempty(descriptor.environmentId),
    serverVersion: nonempty(descriptor.serverVersion),
  };
  if (
    options.expected &&
    (runtime.environmentId !== options.expected.environmentId ||
      runtime.serverVersion !== options.expected.serverVersion)
  )
    throw new T3Error("identity_collision");
  if (runtime.serverVersion !== T3_SERVER_VERSION) throw new T3Error("unsupported_version");
  // Dev auth base-directory semantics have not been qualified. Discovery alone is safe.
  if (stateDirectory === "dev") throw new T3Error("dev_auth_unqualified");
  let auth: Record<string, unknown>;
  try {
    const issued = await io.run([
      command,
      "auth",
      "session",
      "issue",
      "--json",
      "--ttl",
      "2m",
      "--label",
      "wayfinder",
      "--subject",
      "wayfinder",
      "--base-dir",
      home,
    ]);
    if (issued.exitCode !== 0) throw new T3Error("auth_unavailable");
    auth = object(JSON.parse(issued.stdout));
  } catch {
    throw new T3Error("auth_unavailable");
  }
  const sessionId = nonempty(auth.sessionId);
  let token = "";
  async function close() {
    token = "";
    try {
      const revoked = await io.run([
        command,
        "auth",
        "session",
        "revoke",
        sessionId,
        "--base-dir",
        home,
      ]);
      if (revoked.exitCode !== 0) throw new T3Error("auth_revoke_failed");
    } catch {
      throw new T3Error("auth_revoke_failed");
    }
  }
  try {
    token = nonempty(auth.token);
    if (auth.method !== "bearer-access-token") throw new T3Error("auth_unavailable");
  } catch {
    await close();
    throw new T3Error("auth_unavailable");
  }
  return {
    runtime,
    request: (method, path, body) => {
      if (!token) throw new T3Error("auth_closed");
      return request(token, method, path, body);
    },
    close,
  };
}
