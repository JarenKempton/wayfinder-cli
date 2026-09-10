import { expect, test } from "bun:test";
import { connectT3, type T3Platform } from "../src/platform/t3.ts";

function fixture() {
  const commands: string[][] = [];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  let origin = "http://127.0.0.1:3773";
  let authExit = 0;
  let revokeExit = 0;
  let httpStatus = 200;
  const platform: T3Platform = {
    async readText() {
      return JSON.stringify({
        version: 1,
        origin,
        pid: 42,
        port: 3773,
        startedAt: "2026-09-10T00:00:00Z",
      });
    },
    async run(argv) {
      commands.push([...argv]);
      return argv.includes("issue")
        ? {
            exitCode: authExit,
            stdout: JSON.stringify({
              sessionId: "credential-id",
              token: "secret-token",
              method: "bearer-access-token",
            }),
          }
        : { exitCode: revokeExit, stdout: "private stderr" };
    },
    async fetch(url, init) {
      requests.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify(
          url.includes(".well-known")
            ? { environmentId: "env", serverVersion: "0.0.41-nightly.20260909.1426" }
            : { snapshotSequence: 1, projects: [], threads: [], updatedAt: "2026-09-10T00:00:00Z" },
        ),
        { status: httpStatus },
      );
    },
  };
  return {
    platform,
    commands,
    requests,
    origin: (value: string) => {
      origin = value;
    },
    failAuth: () => {
      authExit = 1;
    },
    failRevoke: () => {
      revokeExit = 1;
    },
    status: (value: number) => {
      httpStatus = value;
    },
  };
}

test("auth is memory-only, all HTTP disallows redirects, revocation is explicit", async () => {
  const f = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: f.platform });
  await c.request("GET", "/api/orchestration/snapshot");
  await c.close();
  expect(JSON.stringify(f.commands)).not.toContain("secret-token");
  expect(f.commands[0]).toEqual([
    "t3",
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
    "/fixture/.t3",
  ]);
  expect(f.commands[1]).toEqual([
    "t3",
    "auth",
    "session",
    "revoke",
    "credential-id",
    "--base-dir",
    "/fixture/.t3",
  ]);
  expect(f.requests.every((r) => r.init?.redirect === "error")).toBe(true);
  expect(f.requests[1]?.init?.headers).toEqual({
    Authorization: "Bearer secret-token",
    "Content-Type": "application/json",
  });
});

test.each([
  "https://example.com",
  "http://127.0.0.1:3773/path",
  "http://user:pass@127.0.0.1:3773",
  "http://localhost.evil:3773",
])("rejects unsafe discovery origin %s before auth", async (origin) => {
  const f = fixture();
  f.origin(origin);
  await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow();
  expect(f.commands).toHaveLength(0);
  expect(f.requests).toHaveLength(0);
});

test("binds expected environment before issuing credentials", async () => {
  const f = fixture();
  await expect(
    connectT3({
      home: "/fixture/.t3",
      platform: f.platform,
      expected: { environmentId: "other", serverVersion: "0.0.41-nightly.20260909.1426" },
    }),
  ).rejects.toThrow("identity_collision");
  expect(f.commands).toHaveLength(0);
});

test("unavailable credentials/server and revocation failures expose only safe codes", async () => {
  const f = fixture();
  f.failAuth();
  await expect(connectT3({ home: "/fixture/.t3", platform: f.platform })).rejects.toThrow(
    "auth_unavailable",
  );
  const g = fixture();
  g.status(503);
  await expect(connectT3({ home: "/fixture/.t3", platform: g.platform })).rejects.toThrow(
    "http_503",
  );
  expect(g.commands).toHaveLength(0);
  const h = fixture();
  const c = await connectT3({ home: "/fixture/.t3", platform: h.platform });
  h.failRevoke();
  await expect(c.close()).rejects.toThrow("auth_revoke_failed");
});
