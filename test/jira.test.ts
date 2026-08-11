import { describe, expect, test } from "bun:test";
import { findAdapter } from "../src/adapters.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "../src/contracts.ts";
import type { ActorRef, ClaimRef, RunRef, TicketRef } from "../src/domain.ts";
import { type JiraResponse, JiraTrackerAdapter, type JiraTransport } from "../src/jira.ts";

const ticket = "jira:responsibid:JWB:ticket:JWB-288" as TicketRef;

class FakeJira implements JiraTransport {
  assignee: string | null = null;
  status = "To Do";
  updated = "1";
  property: unknown = null;
  failAt?: string;
  comments: string[] = [];

  async request<T>(method: string, path: string, body?: unknown): Promise<JiraResponse<T>> {
    const input = body as {
      accountId: string | null;
      transition: { id: string };
      body: { content: Array<{ content: Array<{ text: string }> }> };
    };
    const operation = `${method} ${path.split("?")[0]}`;
    if (this.failAt === operation) return { status: 500 };
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
    if (method === "GET" && path.includes("/issue/JWB-288?")) {
      return { status: 200, body: this.issue() as T };
    }
    if (method === "PUT" && path.endsWith("/assignee")) {
      this.assignee = input.accountId;
      this.bump();
      return { status: 204 };
    }
    if (method === "PUT" && path.includes("/properties/")) {
      this.property = body;
      this.bump();
      return { status: 204 };
    }
    if (method === "DELETE" && path.includes("/properties/")) {
      this.property = null;
      this.bump();
      return { status: 204 };
    }
    if (method === "POST" && path.endsWith("/transitions")) {
      this.status = ["To Do", "In Progress", "Done"][Number(input.transition.id)] ?? this.status;
      this.bump();
      return { status: 204 };
    }
    if (method === "POST" && path.endsWith("/comment")) {
      this.comments.push(input.body.content[0]?.content[0]?.text ?? "");
      return { status: 201, body: {} as T };
    }
    return { status: 404 };
  }

  issue() {
    return {
      key: "JWB-288",
      fields: {
        updated: this.updated,
        assignee: this.assignee ? { accountId: this.assignee } : null,
        status: {
          name: this.status,
          statusCategory: { key: this.status === "Done" ? "done" : "new" },
        },
        issuetype: { name: "Task" },
        parent: { key: "JWB-274" },
        priority: { id: "4" },
        issuelinks: [
          {
            type: { inward: "is blocked by", outward: "blocks" },
            inwardIssue: { key: "JWB-279", fields: { status: { name: "Done" } } },
          },
        ],
      },
    };
  }
  bump() {
    this.updated = String(Number(this.updated) + 1);
  }
}

function adapter(api: FakeJira) {
  return new JiraTrackerAdapter({ instance: "responsibid", workspace: "JWB", transport: api });
}

function claim(version = "1") {
  return {
    ticket,
    claim: "wayfinder-claim:c" as ClaimRef,
    run: "wayfinder-run:r" as RunRef,
    owner: "account" as ActorRef,
    leaseExpiresAt: "2099-01-01T00:00:00.000Z",
    expectedVersion: version,
  };
}

describe("Jira tracker adapter", () => {
  test("normalizes tickets, maps, kinds, assignment, and blocking links", async () => {
    const result = await adapter(new FakeJira()).getTicket(ticket);
    expect(result).toMatchObject({
      ref: ticket,
      map: "jira:responsibid:JWB:map:JWB-274",
      kind: "task",
      state: "open",
      status: "To Do",
    });
    expect(result.dependencies?.[0]).toEqual({
      blocking: "jira:responsibid:JWB:ticket:JWB-279" as TicketRef,
      blocked: ticket,
      kind: "blocks",
    });
  });

  test("advertises verified Jira features but not atomic conditional update", async () => {
    const described = await adapter(new FakeJira()).describe();
    expect(described.native_dependencies).toBe(true);
    expect(described.conditional_update).toBeUndefined();
    expect(described.atomic_assignment).toBeUndefined();
    expect(findAdapter("jira")).toMatchObject({ bundled: true, available: true });
  });

  test("claims, records audit evidence, and verifies every owned field", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await subject.claim(claim());
    await subject.verifyClaim(claim());
    expect(api.assignee).toBe("account");
    expect(api.status).toBe("In Progress");
    expect(api.comments).toHaveLength(1);
  });

  test("rejects a changed revision before mutation", async () => {
    const api = new FakeJira();
    api.updated = "2";
    await expect(adapter(api).claim(claim())).rejects.toBeInstanceOf(ClaimCollisionError);
    expect(api.assignee).toBeNull();
  });

  test("reports a partial multi-step claim as ambiguous", async () => {
    const api = new FakeJira();
    api.failAt = "PUT /rest/api/3/issue/JWB-288/properties/wayfinder.claim";
    await expect(adapter(api).claim(claim())).rejects.toBeInstanceOf(AmbiguousTrackerResultError);
    expect(api.assignee).toBe("account");
  });

  test("restores and verifies the exact claim-owned snapshot", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    const originalSnapshot = await subject.snapshotClaimState(ticket);
    await subject.claim(claim());
    await subject.restoreClaimState({ ticket, claim: claim().claim, originalSnapshot });
    await subject.verifyRestored({ ticket, claim: claim().claim, originalSnapshot });
    expect(api.assignee).toBeNull();
    expect(api.status).toBe("To Do");
    expect(api.property).toBeNull();
  });

  test("will not restore over a different current claim", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    const originalSnapshot = await subject.snapshotClaimState(ticket);
    await subject.claim(claim());
    api.property = { ...(api.property as object), claim: "wayfinder-claim:other" };
    await expect(
      subject.restoreClaimState({ ticket, claim: claim().claim, originalSnapshot }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });

  test("renews lease without a comment and verifies by reread", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await subject.claim(claim());
    const expectedVersion = api.updated;
    const request = {
      ticket,
      claim: claim().claim,
      leaseExpiresAt: "2099-02-01T00:00:00.000Z",
      expectedVersion,
    };
    await subject.renewLease(request);
    await subject.verifyLease(request);
    expect(api.comments).toHaveLength(1);
  });

  test("adds resolution evidence and transitions only through a discovered transition", async () => {
    const api = new FakeJira();
    const subject = adapter(api);
    await subject.addArtifactLink(ticket, "https://github.test/pr/1", "PR 1");
    await subject.resolve(ticket);
    expect(api.comments[0]).toContain("https://github.test/pr/1");
    expect(api.status).toBe("Done");
  });
});
