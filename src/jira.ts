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

export interface JiraClock {
  now(): Date;
}

interface JiraUser {
  accountId: string;
}
interface JiraStatus {
  name: string;
  statusCategory?: { key?: string };
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
  fields: Record<string, unknown> & {
    updated: string;
    assignee: JiraUser | null;
    status: JiraStatus;
    issuetype: { name: string };
    parent?: { key: string };
    issuelinks?: JiraIssueLink[];
    priority?: { name?: string };
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
  clock: JiraClock;
  /** Highest-priority name first; Jira numeric IDs have no portable semantic ordering. */
  priorityOrder: readonly string[];
  /** A configured numeric field that preserves the map's native stable order. */
  orderField: string;
  claimProperty?: string;
  activeStatus?: string;
  availableStatuses?: readonly string[];
}

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
  );
}

export class JiraTrackerAdapter implements TrackerAdapter {
  readonly #transport: JiraTransport;
  readonly #clock: JiraClock;
  readonly #prefix: string;
  readonly #claimProperty: string;
  readonly #activeStatus: string;
  readonly #availableStatuses: ReadonlySet<string>;
  readonly #priorityOrder: readonly string[];
  readonly #orderField: string;

  constructor(options: JiraTrackerOptions) {
    if (options.priorityOrder.length === 0) throw new Error("Jira priority order is required");
    if (!options.orderField) throw new Error("Jira native order field is required");
    this.#transport = options.transport;
    this.#clock = options.clock;
    this.#prefix = `jira:${options.instance}:${options.workspace}`;
    this.#claimProperty = options.claimProperty ?? "wayfinder.claim";
    this.#activeStatus = options.activeStatus ?? "In Progress";
    this.#availableStatuses = new Set(options.availableStatuses ?? ["To Do", "Open"]);
    this.#priorityOrder = options.priorityOrder;
    this.#orderField = options.orderField;
  }

  async describe() {
    // Jira has no server-side CAS spanning assignment, status, and properties.
    return jiraCapabilities();
  }

  async preflight(ticket: TicketRef): Promise<void> {
    const key = this.#key(ticket);
    await this.#issue(ticket);
    const permissions = await this.#required<{
      permissions?: Record<string, { havePermission?: boolean }>;
    }>(
      "GET",
      `/rest/api/3/mypermissions?issueKey=${key}&permissions=ASSIGN_ISSUES,EDIT_ISSUES,ADD_COMMENTS,TRANSITION_ISSUES`,
      undefined,
      "read permissions",
    );
    for (const permission of [
      "ASSIGN_ISSUES",
      "EDIT_ISSUES",
      "ADD_COMMENTS",
      "TRANSITION_ISSUES",
    ]) {
      if (!permissions.permissions?.[permission]?.havePermission)
        throw new Error(`Jira permission is required: ${permission}`);
    }
    const edit = await this.#required<{ fields?: { assignee?: { operations?: string[] } } }>(
      "GET",
      `/rest/api/3/issue/${key}/editmeta`,
      undefined,
      "read edit metadata",
    );
    if (!edit.fields?.assignee?.operations?.includes("set"))
      throw new Error("Jira assignee is not editable");
    const transitions = await this.#transitions(ticket);
    if (!transitions.some((item) => item.to.name === this.#activeStatus))
      throw new Error(`Jira status is not reachable: ${this.#activeStatus}`);
    // A readable property endpoint plus EDIT_ISSUES is Jira's non-mutating property preflight.
    await this.#readClaim(ticket);
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const issue = await this.#issue(ticket);
    const order = issue.fields[this.#orderField];
    if (typeof order !== "number" || !Number.isFinite(order))
      throw new Error(`Jira native order field is not numeric: ${this.#orderField}`);
    const priorityName = issue.fields.priority?.name;
    const priorityIndex = priorityName ? this.#priorityOrder.indexOf(priorityName) : -1;
    if (priorityName && priorityIndex < 0)
      throw new Error(`Jira priority is not configured: ${priorityName}`);
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
      order,
      ...(priorityIndex >= 0 ? { priority: this.#priorityOrder.length - priorityIndex } : {}),
      metadata: { nativeKey: issue.key, version: issue.fields.updated, priorityName },
    };
  }

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const issue = await this.#issue(ticket);
    return { version: issue.fields.updated, payload: await this.#snapshot(issue, ticket) };
  }

  async claim(request: ClaimRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const original = await this.#snapshot(issue, request.ticket);
    if (
      issue.fields.updated !== request.expectedVersion ||
      original.assignee !== null ||
      original.claim !== null ||
      !this.#availableStatuses.has(original.status)
    )
      throw new ClaimCollisionError();
    const guard: JiraClaimProperty = {
      claim: request.claim,
      run: request.run,
      owner: request.owner,
      leaseExpiresAt: request.leaseExpiresAt,
      originalSnapshot: { version: request.expectedVersion, payload: original },
    };
    try {
      await this.#putClaim(request.ticket, guard);
    } catch (error) {
      const observed = await this.#current(request.ticket);
      if (ownedEqual(observed, original))
        throw new ClaimCollisionError(`Jira claim guard was not established: ${message(error)}`);
      throw new AmbiguousTrackerResultError(
        `Jira claim guard result is ambiguous: ${message(error)}`,
      );
    }
    try {
      await this.#assign(request.ticket, String(request.owner));
      await this.#transition(request.ticket, this.#activeStatus);
      await this.addComment(
        request.ticket,
        `Wayfinder claim ${request.claim} for ${request.run}; lease ${request.leaseExpiresAt}.`,
      );
    } catch (error) {
      throw new AmbiguousTrackerResultError(`Jira guarded claim may be partial: ${message(error)}`);
    }
  }

  async verifyClaim(request: ClaimRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    if (
      current.assignee !== String(request.owner) ||
      current.status !== this.#activeStatus ||
      !claimEqual(current.claim, {
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        leaseExpiresAt: request.leaseExpiresAt,
      })
    )
      throw new AmbiguousTrackerResultError("Jira claim verification failed");
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    const original = snapshotPayload(request.originalSnapshot);
    let current = await this.#current(request.ticket);
    if (ownedEqual(current, original)) return;
    if (current.claim?.claim !== request.claim)
      throw new ClaimCollisionError("Claim changed before restoration");
    try {
      if (current.assignee !== original.assignee)
        await this.#assign(request.ticket, original.assignee);
      current = await this.#current(request.ticket);
      if (current.status !== original.status)
        await this.#transition(request.ticket, original.status);
      current = await this.#current(request.ticket);
      if (original.claim) await this.#putClaim(request.ticket, original.claim);
      else await this.#deleteClaim(request.ticket);
    } catch (error) {
      throw new AmbiguousTrackerResultError(`Jira restoration may be partial: ${message(error)}`);
    }
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    if (!ownedEqual(await this.#current(request.ticket), snapshotPayload(request.originalSnapshot)))
      throw new AmbiguousTrackerResultError("Jira owned fields do not match the original snapshot");
  }

  async renewLease(request: RenewLeaseRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const current = await this.#snapshot(issue, request.ticket);
    if (issue.fields.updated !== request.expectedVersion || current.claim?.claim !== request.claim)
      throw new ClaimCollisionError("Claim changed before renewal");
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
    )
      throw new AmbiguousTrackerResultError("Jira lease verification failed");
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    const issue = await this.#issue(request.ticket);
    const current = await this.#snapshot(issue, request.ticket);
    if (issue.fields.updated !== request.expectedVersion || current.claim?.claim !== request.claim)
      throw new ClaimCollisionError("Claim or Jira revision changed before release");
    await this.restoreClaimState(request);
    try {
      await this.addComment(
        request.ticket,
        `Wayfinder claim ${request.claim} released by ${request.authorizedBy}.`,
      );
    } catch (error) {
      throw new AmbiguousTrackerResultError(
        `Jira release comment result is ambiguous: ${message(error)}`,
      );
    }
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
      Date.parse(current.claim.leaseExpiresAt) > this.#clock.now().getTime()
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
      await this.#putClaim(request.ticket, next);
      await this.#assign(request.ticket, String(request.owner));
      await this.addComment(
        request.ticket,
        `Wayfinder claim ${request.claim} supersedes stale ${request.staleClaim}; authorized by ${request.authorizedBy}.`,
      );
    } catch (error) {
      throw new AmbiguousTrackerResultError(
        `Jira guarded reclaim may be partial: ${message(error)}`,
      );
    }
  }

  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    const current = await this.#current(request.ticket);
    if (
      current.assignee !== String(request.owner) ||
      !claimEqual(current.claim, {
        claim: request.claim,
        run: request.run,
        owner: request.owner,
        leaseExpiresAt: request.leaseExpiresAt,
        supersedes: request.staleClaim,
      })
    )
      throw new AmbiguousTrackerResultError("Jira reclaim verification failed");
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

  async resolve(ticket: TicketRef, status = "Done"): Promise<void> {
    await this.#transition(ticket, status);
  }

  async #current(ticket: TicketRef): Promise<JiraClaimSnapshot> {
    const issue = await this.#issue(ticket);
    return this.#snapshot(issue, ticket);
  }

  async #snapshot(issue: JiraIssue, ticket: TicketRef): Promise<JiraClaimSnapshot> {
    return {
      assignee: issue.fields.assignee?.accountId ?? null,
      status: issue.fields.status.name,
      claim: await this.#readClaim(ticket),
    };
  }

  async #readClaim(ticket: TicketRef): Promise<JiraClaimProperty | null> {
    const property = await this.#transport.request<{ value?: JiraClaimProperty }>(
      "GET",
      `/rest/api/3/issue/${this.#key(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`,
    );
    if (property.status !== 200 && property.status !== 404)
      throw new Error(`Jira property read failed (${property.status})`);
    return property.status === 200 ? (property.body?.value ?? null) : null;
  }

  async #issue(ticket: TicketRef): Promise<JiraIssue> {
    const fields = [
      "updated",
      "assignee",
      "status",
      "issuetype",
      "parent",
      "issuelinks",
      "priority",
      this.#orderField,
    ].join(",");
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

  async #transitions(ticket: TicketRef) {
    const result = await this.#required<{
      transitions: Array<{ id: string; to: { name: string } }>;
    }>("GET", `/rest/api/3/issue/${this.#key(ticket)}/transitions`, undefined, "read transitions");
    return result.transitions;
  }

  async #transition(ticket: TicketRef, status: string): Promise<void> {
    const transition = (await this.#transitions(ticket)).find((item) => item.to.name === status);
    if (!transition) {
      if ((await this.#issue(ticket)).fields.status.name === status) return;
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

function snapshotPayload(snapshot: TrackerSnapshot): JiraClaimSnapshot {
  const value = snapshot.payload as Partial<JiraClaimSnapshot> | null;
  if (!value || !("assignee" in value) || typeof value.status !== "string" || !("claim" in value))
    throw new Error("Invalid Jira claim snapshot");
  return value as JiraClaimSnapshot;
}

function ownedEqual(left: JiraClaimSnapshot, right: JiraClaimSnapshot): boolean {
  return (
    left.assignee === right.assignee &&
    left.status === right.status &&
    claimEqual(left.claim, right.claim)
  );
}

function claimEqual(
  left: JiraClaimProperty | null,
  right: Partial<JiraClaimProperty> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.claim === right.claim &&
    left.run === right.run &&
    left.owner === right.owner &&
    left.leaseExpiresAt === right.leaseExpiresAt &&
    left.supersedes === right.supersedes &&
    (right.originalSnapshot === undefined ||
      snapshotEqual(left.originalSnapshot, right.originalSnapshot))
  );
}

function snapshotEqual(left: TrackerSnapshot, right: TrackerSnapshot): boolean {
  return (
    left.version === right.version && ownedEqual(snapshotPayload(left), snapshotPayload(right))
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
