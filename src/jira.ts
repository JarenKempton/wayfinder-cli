import {
  AmbiguousTrackerResultError,
  ClaimCollisionError,
  type ClaimRequest,
  type ReclaimRequest,
  type ReleaseClaimRequest,
  type RenewLeaseRequest,
  type RestoreClaimRequest,
  type TrackerAdapter,
} from "./contracts.ts";
import {
  type ActorRef,
  capabilities,
  type Dependency,
  type MapRef,
  type Ticket,
  type TicketKind,
  type TicketRef,
  type TrackerSnapshot,
} from "./domain.ts";
import { parseRef } from "./reference.ts";

export interface JiraResponse<T = unknown> {
  status: number;
  body?: T;
}

/** Credential-bearing HTTP is a platform concern; the domain adapter only receives this handle. */
export interface JiraTransport {
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<JiraResponse<T>>;
}

interface JiraUser {
  accountId: string;
}
interface JiraStatus {
  name: string;
  statusCategory?: { key?: string };
}
interface JiraType {
  name: string;
}
interface JiraLinkedIssue {
  key: string;
  fields: { status: JiraStatus };
}
interface JiraIssueLink {
  type: { inward: string; outward: string };
  inwardIssue?: JiraLinkedIssue;
  outwardIssue?: JiraLinkedIssue;
}
interface JiraIssue {
  key: string;
  fields: {
    updated: string;
    assignee: JiraUser | null;
    status: JiraStatus;
    issuetype: JiraType;
    parent?: { key: string };
    issuelinks?: JiraIssueLink[];
    priority?: { id?: string };
  };
}
interface JiraClaimProperty {
  claim: string;
  run: string;
  owner: string;
  leaseExpiresAt: string;
  originalSnapshot: TrackerSnapshot;
  supersedes?: string;
}
interface JiraClaimSnapshot {
  assignee: string | null;
  status: string;
  claim: JiraClaimProperty | null;
}

export interface JiraTrackerOptions {
  instance: string;
  workspace: string;
  transport: JiraTransport;
  claimProperty?: string;
  activeStatus?: string;
  availableStatuses?: readonly string[];
}

const fields = "updated,assignee,status,issuetype,parent,issuelinks,priority";

export function jiraCapabilities() {
  return capabilities(
    "native_maps",
    "native_dependencies",
    "cross_map_dependencies",
    "workflow_transition",
    "native_properties",
    "claim_comments",
    "lease_metadata",
    "resolution_comments",
    "artifact_links",
  );
}

export class JiraTrackerAdapter implements TrackerAdapter {
  readonly #transport: JiraTransport;
  readonly #prefix: string;
  readonly #claimProperty: string;
  readonly #activeStatus: string;
  readonly #availableStatuses: ReadonlySet<string>;

  constructor(options: JiraTrackerOptions) {
    this.#transport = options.transport;
    this.#prefix = `jira:${options.instance}:${options.workspace}`;
    this.#claimProperty = options.claimProperty ?? "wayfinder.claim";
    this.#activeStatus = options.activeStatus ?? "In Progress";
    this.#availableStatuses = new Set(options.availableStatuses ?? ["To Do", "Open"]);
  }

  async describe() {
    // Jira issue edits do not provide a server-side CAS across assignment, status, and property.
    return jiraCapabilities();
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.#issue(ticket);
    const transitions = await this.#required<{ transitions?: unknown[] }>(
      "GET",
      `/rest/api/3/issue/${this.#key(ticket)}/transitions`,
      undefined,
      "read transitions",
    );
    if (!Array.isArray(transitions.transitions))
      throw new Error("Jira transitions are unavailable");
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const issue = await this.#issue(ticket);
    const dependencies: Dependency[] = [];
    for (const link of issue.fields.issuelinks ?? []) {
      if (link.inwardIssue && link.type.inward.toLowerCase().includes("blocked by")) {
        dependencies.push({
          blocking: this.#ticketRef(link.inwardIssue.key),
          blocked: ticket,
          kind: "blocks",
        });
      }
      if (link.outwardIssue && link.type.outward.toLowerCase() === "blocks") {
        dependencies.push({
          blocking: ticket,
          blocked: this.#ticketRef(link.outwardIssue.key),
          kind: "blocks",
        });
      }
    }
    return {
      ref: ticket,
      map: `${this.#prefix}:map:${issue.fields.parent?.key ?? issue.key}` as MapRef,
      kind: this.#kind(issue.fields.issuetype.name),
      state: issue.fields.status.statusCategory?.key === "done" ? "closed" : "open",
      status: issue.fields.status.name,
      ...(issue.fields.assignee ? { assignee: issue.fields.assignee.accountId as ActorRef } : {}),
      dependencies,
      order: 0,
      ...(issue.fields.priority?.id ? { priority: Number(issue.fields.priority.id) } : {}),
      metadata: { nativeKey: issue.key, version: issue.fields.updated },
    };
  }

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const issue = await this.#issue(ticket);
    return { version: issue.fields.updated, payload: await this.#snapshot(issue, ticket) };
  }

  async claim(request: ClaimRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const current = await this.#snapshot(issue, request.ticket);
    if (
      issue.fields.updated !== request.expectedVersion ||
      current.assignee !== null ||
      current.claim !== null ||
      !this.#availableStatuses.has(current.status)
    )
      throw new ClaimCollisionError();
    const originalSnapshot = { version: request.expectedVersion, payload: current };
    try {
      await this.#assign(request.ticket, String(request.owner));
      await this.#putClaim(request.ticket, {
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        leaseExpiresAt: request.leaseExpiresAt,
        originalSnapshot,
      });
      await this.#transition(request.ticket, this.#activeStatus);
      await this.addComment(
        request.ticket,
        `Wayfinder claim ${request.claim} for ${request.run}; lease ${request.leaseExpiresAt}.`,
      );
    } catch (error) {
      if (error instanceof ClaimCollisionError) throw error;
      throw new AmbiguousTrackerResultError(`Jira claim may be partial: ${message(error)}`);
    }
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    const snapshot = await this.#current(request.ticket);
    if (
      snapshot.assignee !== String(request.owner) ||
      snapshot.claim?.claim !== request.claim ||
      snapshot.claim.run !== request.run ||
      snapshot.claim.leaseExpiresAt !== request.leaseExpiresAt ||
      snapshot.status !== this.#activeStatus
    )
      throw new ClaimCollisionError("Jira claim verification failed");
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    if (current.claim?.claim !== request.claim)
      throw new ClaimCollisionError("Claim changed before restoration");
    const original = payload(request.originalSnapshot);
    try {
      await this.#assign(request.ticket, original.assignee);
      if (original.claim) await this.#putClaim(request.ticket, original.claim);
      else await this.#deleteClaim(request.ticket);
      await this.#transition(request.ticket, original.status);
    } catch (error) {
      throw new AmbiguousTrackerResultError(`Jira restoration may be partial: ${message(error)}`);
    }
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    const original = payload(request.originalSnapshot);
    if (JSON.stringify(current) !== JSON.stringify(original)) {
      throw new AmbiguousTrackerResultError("Jira owned fields do not match the original snapshot");
    }
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const current = await this.#snapshot(issue, request.ticket);
    if (
      issue.fields.updated !== request.expectedVersion ||
      current.claim?.claim !== request.claim
    ) {
      throw new ClaimCollisionError("Claim changed before renewal");
    }
    await this.#putClaim(request.ticket, {
      ...current.claim,
      leaseExpiresAt: request.leaseExpiresAt,
    });
  }

  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    if (
      current.claim?.claim !== request.claim ||
      current.claim.leaseExpiresAt !== request.leaseExpiresAt
    ) {
      throw new ClaimCollisionError("Jira lease verification failed");
    }
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.restoreClaimState(request);
    await this.addComment(
      request.ticket,
      `Wayfinder claim ${request.claim} released by ${request.authorizedBy}.`,
    );
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.verifyRestored(request);
  }

  async reclaim(request: ReclaimRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const current = await this.#snapshot(issue, request.ticket);
    if (
      issue.fields.updated !== request.expectedVersion ||
      current.claim?.claim !== request.staleClaim ||
      Date.parse(current.claim.leaseExpiresAt) > Date.now()
    )
      throw new ClaimCollisionError("Claim is not reclaimable");
    const next: JiraClaimProperty = {
      claim: request.claim,
      run: request.run,
      owner: request.owner,
      leaseExpiresAt: request.leaseExpiresAt,
      originalSnapshot: request.originalSnapshot,
      supersedes: request.staleClaim,
    };
    try {
      await this.#assign(request.ticket, String(request.owner));
      await this.#putClaim(request.ticket, next);
      await this.addComment(
        request.ticket,
        `Wayfinder claim ${request.claim} supersedes stale ${request.staleClaim}; authorized by ${request.authorizedBy}.`,
      );
    } catch (error) {
      throw new AmbiguousTrackerResultError(`Jira reclaim may be partial: ${message(error)}`);
    }
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    if (
      current.assignee !== String(request.owner) ||
      current.claim?.claim !== request.claim ||
      current.claim.supersedes !== request.staleClaim
    )
      throw new ClaimCollisionError("Jira reclaim verification failed");
  }

  async addComment(ticket: TicketRef, text: string): Promise<void> {
    await this.#required(
      "POST",
      `/rest/api/3/issue/${this.#key(ticket)}/comment`,
      {
        body: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text }] }],
        },
      },
      "add comment",
    );
  }

  async addArtifactLink(ticket: TicketRef, url: string, title: string): Promise<void> {
    await this.addComment(ticket, `Artifact: ${title} — ${url}`);
  }

  async resolve(ticket: TicketRef, status = "Done"): Promise<void> {
    await this.#transition(ticket, status);
  }

  async #current(ticket: TicketRef): Promise<JiraClaimSnapshot> {
    const issue = await this.#issue(ticket);
    return this.#snapshot(issue, ticket);
  }

  async #snapshot(issue: JiraIssue, ticket: TicketRef): Promise<JiraClaimSnapshot> {
    const property = await this.#transport.request<{ value?: JiraClaimProperty }>(
      "GET",
      `/rest/api/3/issue/${this.#key(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`,
    );
    if (property.status !== 200 && property.status !== 404)
      throw new Error(`Jira property read failed (${property.status})`);
    return {
      assignee: issue.fields.assignee?.accountId ?? null,
      status: issue.fields.status.name,
      claim: property.status === 200 ? (property.body?.value ?? null) : null,
    };
  }

  async #issue(ticket: TicketRef): Promise<JiraIssue> {
    return this.#required(
      "GET",
      `/rest/api/3/issue/${this.#key(ticket)}?fields=${fields}`,
      undefined,
      "read issue",
    );
  }

  async #assign(ticket: TicketRef, accountId: string | null): Promise<void> {
    await this.#required(
      "PUT",
      `/rest/api/3/issue/${this.#key(ticket)}/assignee`,
      { accountId },
      "assign issue",
    );
  }

  async #putClaim(ticket: TicketRef, claim: JiraClaimProperty): Promise<void> {
    await this.#required(
      "PUT",
      `/rest/api/3/issue/${this.#key(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`,
      claim,
      "write claim property",
    );
  }

  async #deleteClaim(ticket: TicketRef): Promise<void> {
    const response = await this.#transport.request(
      "DELETE",
      `/rest/api/3/issue/${this.#key(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`,
    );
    if (response.status !== 204 && response.status !== 404)
      throw new Error(`Jira claim property delete failed (${response.status})`);
  }

  async #transition(ticket: TicketRef, status: string): Promise<void> {
    const result = await this.#required<{
      transitions: Array<{ id: string; to: { name: string } }>;
    }>("GET", `/rest/api/3/issue/${this.#key(ticket)}/transitions`, undefined, "read transitions");
    const transition = result.transitions.find((item) => item.to.name === status);
    if (!transition) {
      const issue = await this.#issue(ticket);
      if (issue.fields.status.name === status) return;
      throw new Error(`Jira status is not reachable: ${status}`);
    }
    await this.#required(
      "POST",
      `/rest/api/3/issue/${this.#key(ticket)}/transitions`,
      { transition: { id: transition.id } },
      "transition issue",
    );
  }

  async #required<T>(method: string, path: string, body: unknown, operation: string): Promise<T> {
    const response = await this.#transport.request<T>(method, path, body);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Jira ${operation} failed (${response.status})`);
    return response.body as T;
  }

  #key(ref: TicketRef): string {
    const parsed = parseRef(ref);
    if (
      parsed.kind !== "ticket" ||
      parsed.adapter !== "jira" ||
      parsed.nativeId === undefined ||
      `${parsed.adapter}:${parsed.instance}:${parsed.workspace}` !== this.#prefix
    )
      throw new Error(`Ticket is outside Jira workspace: ${ref}`);
    return encodeURIComponent(parsed.nativeId);
  }
  #ticketRef(key: string): TicketRef {
    return `${this.#prefix}:ticket:${key}` as TicketRef;
  }
  #kind(name: string): TicketKind {
    const value = name.toLowerCase();
    return value === "research" || value === "prototype" || value === "decision" ? value : "task";
  }
}

function payload(snapshot: TrackerSnapshot): JiraClaimSnapshot {
  const value = snapshot.payload as Partial<JiraClaimSnapshot> | null;
  if (!value || !("assignee" in value) || typeof value.status !== "string" || !("claim" in value)) {
    throw new Error("Invalid Jira claim snapshot");
  }
  return value as JiraClaimSnapshot;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
