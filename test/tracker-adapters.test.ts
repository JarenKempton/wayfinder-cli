import { describe, expect, test } from "bun:test";
import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
} from "../src/contracts.ts";
import type { ActorRef, ClaimRef, MapRef, RunRef, TicketRef } from "../src/domain.ts";
import { GitHubIssuesTrackerAdapter } from "../src/github-adapter.ts";
import { LinearTrackerAdapter } from "../src/linear-adapter.ts";
import type { HttpResponse, HttpTransport } from "../src/tracker-http.ts";

function response(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): HttpResponse {
  return {
    status: options.status ?? 200,
    headers: new Headers(options.headers),
    async json() {
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function queueTransport(
  items: HttpResponse[],
  requests: Array<{ url: string; body?: string }> = [],
): HttpTransport {
  return async (url, request) => {
    requests.push({ url, ...(request?.body ? { body: request.body } : {}) });
    const item = items.shift();
    if (!item) throw new Error(`Unexpected request: ${url}`);
    return item;
  };
}

const linearIssue = (id: string) => ({
  id,
  identifier: `WAY-${id}`,
  updatedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
  canceledAt: null,
  parent: { id: "map" },
  assignee: null,
  state: { name: "Todo" },
  labels: { nodes: [{ name: "wayfinder:task" }] },
  inverseRelations: { nodes: [] },
});

const githubIssue = (number: number, assignees: Array<{ login: string }> = []) => ({
  number,
  state: "open",
  updated_at: `2026-08-11T00:00:0${number}.000Z`,
  html_url: `https://github.test/o/r/issues/${number}`,
  labels: [{ name: "wayfinder:task" }],
  assignees,
});

describe("Linear tracker adapter", () => {
  test("exhausts cursor pages and preserves map order", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      pageSize: 1,
      transport: queueTransport(
        [
          response({
            data: {
              issue: {
                children: {
                  nodes: [linearIssue("1")],
                  pageInfo: { hasNextPage: true, endCursor: "next" },
                },
              },
            },
          }),
          response({
            data: {
              issue: {
                children: {
                  nodes: [linearIssue("2")],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          }),
        ],
        requests,
      ),
    });
    const tickets = await adapter.listMapTickets("linear:api:team:map:map" as MapRef);
    expect(tickets.map((ticket) => [String(ticket.ref), ticket.order])).toEqual([
      ["linear:api:team:ticket:1", 0],
      ["linear:api:team:ticket:2", 1],
    ]);
    expect(JSON.parse(requestBody(requests, 1)).variables.after).toBe("next");
  });

  test("rejects GraphQL errors even when HTTP succeeds", async () => {
    const adapter = new LinearTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response({ data: { issue: linearIssue("1") }, errors: [{ message: "partial failure" }] }),
      ]),
    });
    await expect(adapter.getTicket("linear:api:team:ticket:1" as TicketRef)).rejects.toThrow(
      "partial failure",
    );
  });
});

describe("GitHub Issues tracker adapter", () => {
  test("follows Link pagination, filters pull requests, and hydrates blockers", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      pageSize: 1,
      transport: queueTransport([
        response([githubIssue(1)], {
          headers: { link: '<https://api.github.test/page2>; rel="next"' },
        }),
        response([{ ...githubIssue(99), pull_request: {} }, githubIssue(2)]),
        response([githubIssue(10)]),
        response([]),
      ]),
    });
    const tickets = await adapter.listMapTickets("github:github.com:o/r:map:5" as MapRef);
    expect(tickets.map((ticket) => String(ticket.ref))).toEqual([
      "github:github.com:o/r:ticket:1",
      "github:github.com:o/r:ticket:2",
    ]);
    expect(String(tickets[0]?.dependencies?.[0]?.blocking)).toBe("github:github.com:o/r:ticket:10");
    expect(tickets[1]?.order).toBe(2);
  });

  test("classifies a pre-write assignment race as a collision", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response(githubIssue(1, [{ login: "other" }]), { headers: { etag: "v2" } }),
      ]),
    });
    await expect(adapter.claim(claimRequest())).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("restores only while the adapter-owned assignment is still present", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      transport: queueTransport(
        [
          response(githubIssue(1), { headers: { etag: "v1" } }),
          response(githubIssue(1, [{ login: "human" }])),
          response(githubIssue(1, [{ login: "human" }]), { headers: { etag: "v2" } }),
          response(githubIssue(1, [{ login: "human" }])),
          response(githubIssue(1)),
          response(githubIssue(1), { headers: { etag: "v3" } }),
        ],
        requests,
      ),
    });
    const request = claimRequest();
    await adapter.claim(request);
    await adapter.verifyClaim(request);
    const originalSnapshot = { version: "v1", payload: { assignee: null } };
    await adapter.restoreClaimState({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot,
    });
    await adapter.verifyRestored({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot,
    });
    expect(JSON.parse(requestBody(requests, 4))).toEqual({ assignees: [] });
  });

  test("refuses to overwrite a concurrent owner during restoration", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response(githubIssue(1), { headers: { etag: "v1" } }),
        response(githubIssue(1, [{ login: "other" }]), { headers: { etag: "v2" } }),
        response(githubIssue(1, [{ login: "other" }]), { headers: { etag: "v2" } }),
      ]),
    });
    const request = claimRequest();
    await adapter.claim(request);
    await expect(
      adapter.restoreClaimState({
        ticket: request.ticket,
        claim: request.claim,
        originalSnapshot: { version: "v1", payload: { assignee: null } },
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("can compensate a claim whose write response was ambiguous", async () => {
    const adapter = new GitHubIssuesTrackerAdapter({
      token: "secret",
      transport: queueTransport([
        response(githubIssue(1), { headers: { etag: "v1" } }),
        response({ message: "gateway lost response" }, { status: 500 }),
        response(githubIssue(1, [{ login: "human" }])),
        response(githubIssue(1)),
        response(githubIssue(1), { headers: { etag: "v3" } }),
      ]),
    });
    const request = claimRequest();
    await expect(adapter.claim(request)).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    const originalSnapshot = { version: "v1", payload: { assignee: null } };
    await adapter.restoreClaimState({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot,
    });
    await adapter.verifyRestored({
      ticket: request.ticket,
      claim: request.claim,
      originalSnapshot,
    });
  });
});

function claimRequest(): ClaimRequest {
  return {
    claim: "wayfinder-claim:test" as ClaimRef,
    run: "wayfinder-run:test" as RunRef,
    ticket: "github:github.com:o/r:ticket:1" as TicketRef,
    owner: "human" as ActorRef,
    leaseExpiresAt: "2026-08-11T00:15:00.000Z",
    expectedVersion: "v1",
  };
}

function requestBody(requests: Array<{ url: string; body?: string }>, index: number): string {
  const body = requests[index]?.body;
  if (body === undefined) throw new Error(`Request ${index} has no body`);
  return body;
}
