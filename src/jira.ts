import type {
  ClaimRequest,
  FrontierTrackerAdapter,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
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
  UnsupportedCapabilityError,
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
    assignee: { accountId: string } | null;
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
interface JiraSearchPage {
  issues?: JiraIssue[];
  nextPageToken?: string;
  isLast?: boolean;
}

export interface JiraTrackerOptions {
  instance: string;
  workspace: string;
  transport: JiraTransport;
  /** Jira's site-specific field id for the standard LexoRank Rank field. */
  rankField: string;
  /** Highest-priority name first; Jira numeric IDs have no portable semantic ordering. */
  priorityOrder: readonly string[];
  claimProperty?: string;
  pageSize?: number;
}

const MUTATION_CAPABILITIES = [
  "atomic_assignment",
  "conditional_update",
  "claim_identity",
  "claim_comments",
  "lease_metadata",
] as const;

export function jiraCapabilities() {
  return capabilities("native_maps", "native_dependencies");
}

/**
 * Jira Cloud read adapter. Mutating claim methods intentionally fail closed because Jira's
 * assignment, transition, and property APIs do not expose one atomic conditional transaction.
 */
export class JiraTrackerAdapter implements FrontierTrackerAdapter {
  readonly #transport: JiraTransport;
  readonly #prefix: string;
  readonly #claimProperty: string;
  readonly #priorityOrder: readonly string[];
  readonly #rankField: string;
  readonly #pageSize: number;

  constructor(options: JiraTrackerOptions) {
    if (!options.rankField) throw new Error("Jira Rank field id is required");
    if (options.priorityOrder.length === 0) throw new Error("Jira priority order is required");
    if (
      options.pageSize !== undefined &&
      (!Number.isInteger(options.pageSize) || options.pageSize < 1 || options.pageSize > 100)
    )
      throw new Error("Jira page size must be an integer from 1 to 100");
    this.#transport = options.transport;
    this.#prefix = `jira:${options.instance}:${options.workspace}`;
    this.#claimProperty = options.claimProperty ?? "wayfinder.claim";
    this.#priorityOrder = options.priorityOrder;
    this.#rankField = options.rankField;
    this.#pageSize = options.pageSize ?? 100;
  }

  async describe() {
    return jiraCapabilities();
  }

  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
    // Decline before the mutation window: neither a claim CAS nor exact restoration CAS exists.
    this.#mutationUnavailable();
  }

  async getTicket(ticket: TicketRef): Promise<Ticket> {
    const issue = await this.#issue(ticket);
    const parent = issue.fields.parent?.key;
    if (!parent) throw new Error("Jira Wayfinder ticket has no parent map");
    const map = `${this.#prefix}:map:${parent}` as MapRef;
    const tickets = await this.listMapTickets(map);
    const found = tickets.find((item) => item.ref === ticket);
    if (!found) throw new Error(`Jira ticket is not a child of its reported map: ${ticket}`);
    return found;
  }

  async listMapTickets(map: MapRef): Promise<Ticket[]> {
    const mapKey = this.#mapKey(map);
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page = await this.#required<JiraSearchPage>(
        "POST",
        "/rest/api/3/search/jql",
        {
          jql: `parent = ${JSON.stringify(mapKey)} ORDER BY Rank ASC`,
          fields: this.#fields(),
          maxResults: this.#pageSize,
          ...(nextPageToken ? { nextPageToken } : {}),
        },
        "search map tickets",
      );
      if (!Array.isArray(page.issues)) throw new Error("Invalid Jira search page");
      issues.push(...page.issues);
      if (page.isLast === true || !page.nextPageToken) break;
      if (page.nextPageToken === nextPageToken) throw new Error("Jira search page token repeated");
      nextPageToken = page.nextPageToken;
    } while (nextPageToken !== undefined);
    return issues.map((issue, order) =>
      this.#normalize(issue, this.#ticketRef(issue.key), map, order),
    );
  }

  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const issue = await this.#issue(ticket);
    return {
      version: issue.fields.updated,
      payload: {
        assignee: issue.fields.assignee?.accountId ?? null,
        status: issue.fields.status.name,
        claim: await this.#readClaim(ticket),
      } satisfies JiraClaimSnapshot,
    };
  }

  async claim(_request: ClaimRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async verifyClaim(_request: ClaimRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    requireClaimedOwner(request.claimedOwner);
    this.#mutationUnavailable();
  }

  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    requireClaimedOwner(request.claimedOwner);
    this.#mutationUnavailable();
  }

  async renewLease(_request: RenewLeaseRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async verifyLease(_request: RenewLeaseRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    requireClaimedOwner(request.claimedOwner);
    this.#mutationUnavailable();
  }

  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    requireClaimedOwner(request.claimedOwner);
    this.#mutationUnavailable();
  }

  async reclaim(_request: ReclaimRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async verifyReclaimed(_request: ReclaimRequest): Promise<void> {
    this.#mutationUnavailable();
  }

  async addComment(_ticket: TicketRef, _text: string): Promise<void> {
    this.#mutationUnavailable();
  }

  async resolve(_ticket: TicketRef, _status = "Done"): Promise<void> {
    this.#mutationUnavailable();
  }

  #normalize(issue: JiraIssue, ref: TicketRef, map: MapRef, order: number): Ticket {
    const rank = issue.fields[this.#rankField];
    if (typeof rank !== "string" || rank.length === 0)
      throw new Error(`Jira Rank field is missing or invalid: ${this.#rankField}`);
    const priorityName = issue.fields.priority?.name;
    const priorityIndex = priorityName ? this.#priorityOrder.indexOf(priorityName) : -1;
    if (priorityName && priorityIndex < 0)
      throw new Error(`Jira priority is not configured: ${priorityName}`);
    const dependencies: Dependency[] = [];
    for (const link of issue.fields.issuelinks ?? []) {
      if (link.inwardIssue && link.type.inward.toLowerCase().includes("blocked by")) {
        dependencies.push({
          blocking: this.#ticketRef(link.inwardIssue.key),
          blocked: ref,
          kind: "blocks",
        });
      }
    }
    return {
      ref,
      map,
      kind: this.#kind(issue.fields.issuetype.name),
      state: issue.fields.status.statusCategory?.key === "done" ? "closed" : "open",
      status: issue.fields.status.name,
      ...(issue.fields.assignee ? { assignee: issue.fields.assignee.accountId as ActorRef } : {}),
      dependencies,
      order,
      ...(priorityIndex >= 0 ? { priority: this.#priorityOrder.length - priorityIndex } : {}),
      metadata: {
        nativeKey: issue.key,
        version: issue.fields.updated,
        rank,
        priorityName,
      },
    };
  }

  async #issue(ticket: TicketRef): Promise<JiraIssue> {
    return this.#required(
      "GET",
      `/rest/api/3/issue/${this.#ticketKey(ticket)}?fields=${this.#fields().join(",")}`,
      undefined,
      "read issue",
    );
  }

  async #readClaim(ticket: TicketRef): Promise<JiraClaimProperty | null> {
    const property = await this.#transport.request<{ value?: JiraClaimProperty }>(
      "GET",
      `/rest/api/3/issue/${this.#ticketKey(ticket)}/properties/${encodeURIComponent(this.#claimProperty)}`,
    );
    if (property.status !== 200 && property.status !== 404)
      throw new Error(`Jira property read failed (${property.status})`);
    return property.status === 200 ? (property.body?.value ?? null) : null;
  }

  #fields(): string[] {
    return [
      "updated",
      "assignee",
      "status",
      "issuetype",
      "parent",
      "issuelinks",
      "priority",
      this.#rankField,
    ];
  }

  async #required<T>(method: string, path: string, body: unknown, operation: string): Promise<T> {
    const response = await this.#transport.request<T>(method, path, body);
    if (response.status < 200 || response.status >= 300)
      throw new Error(`Jira ${operation} failed (${response.status})`);
    return response.body as T;
  }

  #ticketKey(ref: TicketRef): string {
    return encodeURIComponent(this.#nativeKey(ref, "ticket"));
  }

  #mapKey(ref: MapRef): string {
    return this.#nativeKey(ref, "map");
  }

  #nativeKey(ref: TicketRef | MapRef, kind: "ticket" | "map"): string {
    const parsed = parseRef(ref);
    if (
      parsed.kind !== kind ||
      parsed.adapter !== "jira" ||
      !parsed.nativeId ||
      `${parsed.adapter}:${parsed.instance}:${parsed.workspace}` !== this.#prefix
    )
      throw new Error(`${kind} is outside Jira workspace: ${ref}`);
    return parsed.nativeId;
  }

  #ticketRef(key: string): TicketRef {
    return `${this.#prefix}:ticket:${key}` as TicketRef;
  }

  #kind(name: string): TicketKind {
    const value = name.toLowerCase();
    return value === "research" || value === "prototype" || value === "decision" ? value : "task";
  }

  #mutationUnavailable(): never {
    throw new UnsupportedCapabilityError(MUTATION_CAPABILITIES);
  }
}

function requireClaimedOwner(owner: ActorRef | undefined): ActorRef {
  if (!owner) throw new Error("Persisted claimed owner is required");
  return owner;
}
