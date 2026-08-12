import { describe, expect, test } from "bun:test";
import { findAdapter } from "../src/adapters.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../src/contracts.ts";
import type { ActorRef, ClaimRef, RunRef, Ticket, TicketRef } from "../src/domain.ts";
import { evaluateFrontier, selectFrontierTicket } from "../src/frontier.ts";
import { type JiraResponse, JiraTrackerAdapter, type JiraTransport } from "../src/jira.ts";

const ticket = "jira:responsibid:JWB:ticket:JWB-288" as TicketRef;
const owner = "account" as ActorRef;

type Failure = { operation: string; timing: "before" | "after" };

class FakeJira implements JiraTransport {
  assignee: string | null = null;
  status = "To Do";
  updated = 1;
  property: unknown = null;
  priority = { id: "9000", name: "Highest" };
  rank = 7;
  permissions = true;
  assigneeEditable = true;
  links: Array<Record<string, unknown>> = [
    {
      type: { inward: "is blocked by", outward: "blocks" },
      inwardIssue: { key: "JWB-279", fields: { status: { name: "Done" } } },
    },
  ];
  failure?: Failure;
  comments: string[] = [];
  operations: string[] = [];

  async request<T>(method: string, path: string, body?: unknown): Promise<JiraResponse<T>> {
    const operation = `${method} ${path.split("?")[0]}`;
    this.operations.push(operation);
    if (this.failure?.operation === operation && this.failure.timing === "before")
      return { status: 500 };
    const result = this.respond<T>(method, path, body);
    if (this.failure?.operation === operation && this.failure.timing === "after")
      return { status: 500 };
    return result;
  }

  respond<T>(method: string, path: string, body?: unknown): JiraResponse<T> {
    const input = body as {
      accountId: string | null;
      transition: { id: string };
      body: { content: Array<{ content: Array<{ text: string }> }> };
    };
    if (method === "GET" && path.includes("/mypermissions")) {
      const names = ["ASSIGN_ISSUES", "EDIT_ISSUES", "ADD_COMMENTS", "TRANSITION_ISSUES"];
      return {
        status: 200,
        body: {
          permissions: Object.fromEntries(
            names.map((name) => [name, { havePermission: this.permissions }]),
          ),
        } as T,
      };
    }
    if (method === "GET" && path.endsWith("/editmeta")) {
      return {
        status: 200,
        body: { fields: { assignee: { operations: this.assigneeEditable ? ["set"] : [] } } } as T,
      };
    }
    if (method === "GET" && path.includes("/properties/")) {
      return (
        this.property === null ? { status: 404 } : { status: 200, body: { value: this.property } }
      ) as JiraResponse<T>;
    }
    if (method === "GET" && path.endsWith("/transitions")) {
      return {
        status: 200,
        body: {
          transitions: ["To Do", "In Progress", "Done"].map((name, id) => ({
            id: String(id),
            to: { name },
          })),
        } as T,
      };
    }
    if (method === "GET" && path.includes("/issue/JWB-288?"))
      return { status: 200, body: this.issue() as T };
    if (method === "PUT" && path.endsWith("/assignee")) {
      this.assignee = input.accountId;
      this.bump();
      return { status: 204 };
    }
    if (method === "PUT" && path.includes("/properties/")) {
      this.property = structuredClone(body);
      // Jira issue properties do not change fields.updated.
      return { status: 204 };
    }
    if (method === "DELETE" && path.includes("/properties/")) {
      this.property = null;
      // Jira issue properties do not change fields.updated.
      return { status: 204 };
    }
    if (method === "POST" && path.endsWith("/transitions")) {
      this.status = ["To Do", "In Progress", "Done"][Number(input.transition.id)] ?? this.status;
      this.bump();
      return { status: 204 };
    }
    if (method === "POST" && path.endsWith("/comment")) {
      this.comments.push(input.body.content[0]?.content[0]?.text ?? "");
      // Jira comments do not change issue fields.updated.
      return { status: 201, body: {} as T };
    }
    return { status: 404 };
  }

  issue() {
    return {
      key: "JWB-288",
      fields: {
        updated: String(this.updated),
        assignee: this.assignee ? { accountId: this.assignee } : null,
        status: {
          name: this.status,
          statusCategory: { key: this.status === "Done" ? "done" : "new" },
        },
        issuetype: { name: "Task" },
        parent: { key: "JWB-274" },
        priority: this.priority,
        customfield_rank: this.rank,
        issuelinks: this.links,
      },
    };
  }

  bump() {
    this.updated += 1;
  }
  mutationCount() {
    return this.operations.filter((item) => /^(PUT|POST|DELETE) /.test(item)).length;
  }
}

function adapter(api: FakeJira, now = "2026-08-11T12:00:00.000Z") {
  return new JiraTrackerAdapter({
    instance: "responsibid",
    workspace: "JWB",
    transport: api,
    clock: { now: () => new Date(now) },
    priorityOrder: ["Highest", "High", "Medium", "Low", "Lowest"],
    orderField: "customfield_rank",
  });
}

function claim(expectedVersion = "1", leaseExpiresAt = "2099-01-01T00:00:00.000Z") {
  return {
    ticket,
    claim: "wayfinder-claim:c" as ClaimRef,
    run: "wayfinder-run:r" as RunRef,
    owner,
    leaseExpiresAt,
    expectedVersion,
  };
}

async function claimed(api: FakeJira, lease = "2099-01-01T00:00:00.000Z") {
  const subject = adapter(api);
  const originalSnapshot = await subject.snapshotClaimState(ticket);
  await subject.claim(claim(originalSnapshot.version, lease));
  return { subject, originalSnapshot, version: String(api.updated) };
}

describe("Jira tracker adapter", () => {
  test("normalizes dependency, native order, and semantic priority", async () => {
    const highestApi = new FakeJira();
    highestApi.priority = { id: "9000", name: "Highest" };
    highestApi.rank = 8;
    const lowestApi = new FakeJira();
    lowestApi.priority = { id: "1", name: "Lowest" };
    lowestApi.rank = 9;
    const highest = await adapter(highestApi).getTicket(ticket);
    const lowest = await adapter(lowestApi).getTicket(ticket);
    expect(highest).toMatchObject({
      map: "jira:responsibid:JWB:map:JWB-274",
      order: 8,
      priority: 5,
    });
    expect(lowest).toMatchObject({ order: 9, priority: 1 });
    expect(selectFrontierTicket([lowest, highest], "highest-priority")).toBe(highest);
    expect(highest.dependencies?.[0]?.blocking).toBe(
      "jira:responsibid:JWB:ticket:JWB-279" as TicketRef,
    );
  });

  test("emits inward blockers as dependencies owned by the current ticket", async () => {
    const result = await adapter(new FakeJira()).getTicket(ticket);
    expect(result.dependencies).toEqual([
      {
        blocking: "jira:responsibid:JWB:ticket:JWB-279" as TicketRef,
        blocked: ticket,
        kind: "blocks",
      },
    ]);
  });

  test("does not attach outward blocks owned by another ticket", async () => {
    const api = new FakeJira();
    api.links = [
      {
        type: { inward: "is blocked by", outward: "blocks" },
        outwardIssue: { key: "JWB-295", fields: { status: { name: "To Do" } } },
      },
    ];
    expect((await adapter(api).getTicket(ticket)).dependencies).toEqual([]);
  });

  test("produces a complete graph satisfying normalizeTrackerTickets ownership", async () => {
    const current = await adapter(new FakeJira()).getTicket(ticket);
    const blocker: Ticket = {
      ...current,
      ref: "jira:responsibid:JWB:ticket:JWB-279" as TicketRef,
      state: "closed",
      status: "Done",
      dependencies: [],
      order: current.order - 1,
    };
    expect(current.dependencies?.every((dependency) => dependency.blocked === current.ref)).toBe(
      true,
    );
    expect(() =>
      evaluateFrontier(
        [blocker, current],
        { map: current.map },
        { availableStatuses: new Set(["To Do"]) },
      ),
    ).not.toThrow();
  });

  test("advertises only implemented features and remains unavailable without composition", async () => {
    const described = await adapter(new FakeJira()).describe();
    expect(described.native_dependencies).toBe(true);
    expect(described.atomic_assignment).toBeUndefined();
    expect(described.conditional_update).toBeUndefined();
    expect(described.artifact_links).toBeUndefined();
    expect(findAdapter("jira")).toMatchObject({
      bundled: true,
      available: false,
      capabilities: {},
    });
  });

  test("preflight proves permissions, assignment editability, transition, and property read", async () => {
    const api = new FakeJira();
    await adapter(api).preflight(ticket);
    expect(api.operations).toEqual(
      expect.arrayContaining([
        "GET /rest/api/3/mypermissions",
        "GET /rest/api/3/issue/JWB-288/editmeta",
        "GET /rest/api/3/issue/JWB-288/transitions",
        "GET /rest/api/3/issue/JWB-288/properties/wayfinder.claim",
      ]),
    );
    api.permissions = false;
    await expect(adapter(api).preflight(ticket)).rejects.toThrow("permission is required");
    expect(api.mutationCount()).toBe(0);
  });

  test("models Jira fields.updated changes for fields and transitions, not properties or comments", async () => {
    const api = new FakeJira();
    const initial = api.updated;
    await api.request("PUT", "/rest/api/3/issue/JWB-288/properties/wayfinder.claim", {
      claim: "guard",
    });
    await api.request("POST", "/rest/api/3/issue/JWB-288/comment", {
      body: { content: [{ content: [{ text: "audit" }] }] },
    });
    expect(api.updated).toBe(initial);
    await api.request("PUT", "/rest/api/3/issue/JWB-288/assignee", { accountId: owner });
    await api.request("POST", "/rest/api/3/issue/JWB-288/transitions", {
      transition: { id: "1" },
    });
    expect(api.updated).toBe(initial + 2);
  });

  test("creates the guard before owned fields and verifies the claim", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await subject.claim(claim());
    await subject.verifyClaim(claim());
    const writes = api.operations.filter((item) => /^(PUT|POST) /.test(item));
    expect(writes[0]).toContain("/properties/wayfinder.claim");
    expect(api.assignee).toBe("account");
    expect(api.status).toBe("In Progress");
  });

  test("failed guard creation before mutation is definite and leaves state untouched", async () => {
    const api = new FakeJira();
    api.failure = {
      operation: "PUT /rest/api/3/issue/JWB-288/properties/wayfinder.claim",
      timing: "before",
    };
    await expect(adapter(api).claim(claim())).rejects.toBeInstanceOf(ClaimCollisionError);
    expect({ property: api.property, assignee: api.assignee, status: api.status }).toEqual({
      property: null,
      assignee: null,
      status: "To Do",
    });
  });

  test("ambiguous guard response and post-guard partial claim are compensable", async () => {
    for (const failure of [
      {
        operation: "PUT /rest/api/3/issue/JWB-288/properties/wayfinder.claim",
        timing: "after" as const,
      },
      { operation: "PUT /rest/api/3/issue/JWB-288/assignee", timing: "after" as const },
    ]) {
      const api = new FakeJira();
      const subject = adapter(api);
      const originalSnapshot = await subject.snapshotClaimState(ticket);
      api.failure = failure;
      await expect(subject.claim(claim())).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
      expect((api.property as { claim?: string }).claim).toBe(claim().claim);
      delete api.failure;
      await subject.restoreClaimState({ ticket, claim: claim().claim, originalSnapshot });
      await subject.verifyRestored({ ticket, claim: claim().claim, originalSnapshot });
    }
  });

  test("partial restoration retains the guard and is retryable and idempotent", async () => {
    const api = new FakeJira();
    const { subject, originalSnapshot } = await claimed(api);
    api.failure = { operation: "POST /rest/api/3/issue/JWB-288/transitions", timing: "before" };
    await expect(
      subject.restoreClaimState({ ticket, claim: claim().claim, originalSnapshot }),
    ).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    expect((api.property as { claim?: string }).claim).toBe(claim().claim);
    delete api.failure;
    const restore = { ticket, claim: claim().claim, originalSnapshot };
    await subject.restoreClaimState(restore);
    await subject.restoreClaimState(restore);
    await subject.verifyRestored(restore);
    expect({ property: api.property, assignee: api.assignee, status: api.status }).toEqual({
      property: null,
      assignee: null,
      status: "To Do",
    });
  });

  test("release rejects stale expected version without mutation and verifies a valid release", async () => {
    const api = new FakeJira();
    const { subject, originalSnapshot, version } = await claimed(api);
    const before = api.mutationCount();
    const base = { ticket, claim: claim().claim, originalSnapshot, authorizedBy: owner };
    await expect(
      subject.releaseClaim({ ...base, expectedVersion: "stale" }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
    expect(api.mutationCount()).toBe(before);
    await subject.releaseClaim({ ...base, expectedVersion: version });
    await subject.verifyReleased({ ...base, expectedVersion: version });
  });

  test("reclaims only when the injected clock observes an expired lease", async () => {
    const api = new FakeJira();
    const first = await claimed(api, "2026-08-11T11:59:00.000Z");
    const request = {
      staleClaim: claim().claim,
      claim: "wayfinder-claim:next" as ClaimRef,
      run: "wayfinder-run:next" as RunRef,
      ticket,
      owner,
      authorizedBy: owner,
      leaseExpiresAt: "2026-08-11T12:15:00.000Z",
      expectedVersion: first.version,
      originalSnapshot: first.originalSnapshot,
    };
    await first.subject.reclaim(request);
    await first.subject.verifyReclaimed(request);
    const notExpired = adapter(api, "2026-08-11T11:00:00.000Z");
    const snapshot = await notExpired.snapshotClaimState(ticket);
    await expect(
      notExpired.reclaim({
        ...request,
        staleClaim: request.claim,
        claim: "wayfinder-claim:third" as ClaimRef,
        expectedVersion: snapshot.version,
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("post-mutation comment failures are ambiguous", async () => {
    const api = new FakeJira();
    api.failure = { operation: "POST /rest/api/3/issue/JWB-288/comment", timing: "before" };
    await expect(adapter(api).claim(claim())).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    expect(api.assignee).toBe(owner);
    expect(api.status).toBe("In Progress");
  });
});
