import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ClaimRequest,
  ReclaimRequest,
  ReleaseClaimRequest,
  RenewLeaseRequest,
  RestoreClaimRequest,
  TrackerAdapter,
} from "./contracts.ts";
import { AmbiguousTrackerResultError, ClaimCollisionError } from "./contracts.ts";
import {
  type ClaimRef,
  capabilities,
  type MapRef,
  type Ticket,
  type TicketRef,
  type TrackerSnapshot,
} from "./domain.ts";
import { evaluateFrontier, type FrontierScope } from "./frontier.ts";

const BLOCK_START = "```wayfinder-tracker";
const BLOCK_END = "```";

export interface MarkdownMapRecord {
  ref: MapRef;
  title: string;
  order: number;
  context: string[];
}
export interface MarkdownClaimRecord {
  ref: ClaimRef;
  run: ClaimRequest["run"];
  owner: ClaimRequest["owner"];
  claimedAt: string;
  leaseExpiresAt: string;
  status: "active" | "superseded";
  supersedes?: ClaimRef;
  supersededBy?: ClaimRef;
}
export interface MarkdownTicketRecord extends Ticket {
  title: string;
  claim?: MarkdownClaimRecord;
  comments: string[];
  artifacts: string[];
}
export interface MarkdownTrackerDocument {
  format: "wayfinder-markdown-tracker";
  version: number;
  maps: MarkdownMapRecord[];
  tickets: MarkdownTicketRecord[];
}
interface ClaimPayload {
  assignee?: Ticket["assignee"];
  status: string;
  claim?: MarkdownClaimRecord;
}

export class MarkdownTrackerAdapter implements TrackerAdapter {
  readonly path: string;
  constructor(path: string) {
    this.path = resolve(path);
  }

  async describe() {
    return capabilities(
      "native_maps",
      "native_dependencies",
      "cross_map_dependencies",
      "atomic_assignment",
      "workflow_transition",
      "conditional_update",
      "native_properties",
      "claim_comments",
      "lease_metadata",
      "resolution_comments",
      "artifact_links",
    );
  }
  async preflight(ticket: TicketRef): Promise<void> {
    await this.getTicket(ticket);
    await this.#withLock(async () => undefined);
  }
  async getTicket(ticket: TicketRef): Promise<Ticket> {
    return structuredClone(this.#ticket(await this.read(), ticket));
  }
  async listTickets(): Promise<Ticket[]> {
    return structuredClone((await this.read()).tickets);
  }
  async frontier(scope: FrontierScope = {}): Promise<Ticket[]> {
    return evaluateFrontier(await this.listTickets(), scope, {
      availableStatuses: new Set(["To Do"]),
    });
  }
  async snapshotClaimState(ticket: TicketRef): Promise<TrackerSnapshot> {
    const document = await this.read();
    return {
      version: String(document.version),
      payload: this.#claimPayload(this.#ticket(document, ticket)),
    };
  }
  async claim(request: ClaimRequest): Promise<void> {
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.state !== "open" || ticket.assignee !== undefined || ticket.claim !== undefined)
        throw new ClaimCollisionError("Ticket is already claimed or closed");
      ticket.assignee = request.owner;
      ticket.status = "In Progress";
      ticket.claim = {
        ref: request.claim,
        run: request.run,
        owner: request.owner,
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: request.leaseExpiresAt,
        status: "active",
      };
      ticket.comments.push(`Claimed by ${request.owner} as ${request.claim} for ${request.run}.`);
    });
  }
  async verifyClaim(request: ClaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      ticket.assignee !== request.owner ||
      ticket.claim?.ref !== request.claim ||
      ticket.claim.run !== request.run ||
      ticket.claim.leaseExpiresAt !== request.leaseExpiresAt ||
      ticket.status !== "In Progress"
    )
      throw new AmbiguousTrackerResultError("Claim could not be verified");
  }
  async restoreClaimState(request: RestoreClaimRequest): Promise<void> {
    await this.#mutate(undefined, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.claim?.ref !== request.claim) throw new ClaimCollisionError();
      this.#restorePayload(ticket, request.originalSnapshot);
      ticket.comments.push(`Restored claim state after ${request.claim}.`);
    });
  }
  async verifyRestored(request: RestoreClaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      JSON.stringify(this.#claimPayload(ticket)) !==
      JSON.stringify(this.#snapshotPayload(request.originalSnapshot))
    )
      throw new AmbiguousTrackerResultError("Restored claim state could not be verified");
  }
  async renewLease(request: RenewLeaseRequest): Promise<void> {
    await this.#mutate(request.expectedVersion, (document) => {
      this.#matchingClaim(document, request.ticket, request.claim).leaseExpiresAt =
        request.leaseExpiresAt;
    });
  }
  async verifyLease(request: RenewLeaseRequest): Promise<void> {
    if (
      this.#matchingClaim(await this.read(), request.ticket, request.claim).leaseExpiresAt !==
      request.leaseExpiresAt
    )
      throw new AmbiguousTrackerResultError("Lease renewal could not be verified");
  }
  async releaseClaim(request: ReleaseClaimRequest): Promise<void> {
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      if (ticket.claim?.ref !== request.claim) throw new ClaimCollisionError();
      this.#restorePayload(ticket, request.originalSnapshot);
      ticket.comments.push(`Released ${request.claim}; authorized by ${request.authorizedBy}.`);
    });
  }
  async verifyReleased(request: ReleaseClaimRequest): Promise<void> {
    await this.verifyRestored(request);
  }
  async reclaim(request: ReclaimRequest): Promise<void> {
    await this.#mutate(request.expectedVersion, (document) => {
      const ticket = this.#ticket(document, request.ticket);
      const prior = ticket.claim;
      if (
        !prior ||
        prior.ref !== request.staleClaim ||
        prior.status !== "active" ||
        Date.parse(prior.leaseExpiresAt) > Date.now()
      )
        throw new ClaimCollisionError("Claim is not stale or no longer matches");
      prior.status = "superseded";
      prior.supersededBy = request.claim;
      ticket.assignee = request.owner;
      ticket.claim = {
        ref: request.claim,
        run: request.run,
        owner: request.owner,
        claimedAt: new Date().toISOString(),
        leaseExpiresAt: request.leaseExpiresAt,
        status: "active",
        supersedes: request.staleClaim,
      };
      ticket.comments.push(
        `Reclaimed ${request.staleClaim} as ${request.claim}; authorized by ${request.authorizedBy}.`,
      );
    });
  }
  async verifyReclaimed(request: ReclaimRequest): Promise<void> {
    const ticket = this.#ticket(await this.read(), request.ticket);
    if (
      ticket.assignee !== request.owner ||
      ticket.claim?.ref !== request.claim ||
      ticket.claim.supersedes !== request.staleClaim ||
      ticket.claim.leaseExpiresAt !== request.leaseExpiresAt
    )
      throw new AmbiguousTrackerResultError("Reclaim could not be verified");
  }
  async comment(ticketRef: TicketRef, body: string): Promise<void> {
    await this.#mutate(undefined, (document) => {
      this.#ticket(document, ticketRef).comments.push(body);
    });
  }
  async resolve(
    ticketRef: TicketRef,
    resolution: string,
    artifacts: readonly string[] = [],
  ): Promise<void> {
    if (!resolution.trim()) throw new Error("A resolution comment is required before close");
    await this.#mutate(undefined, (document) => {
      const ticket = this.#ticket(document, ticketRef);
      if (ticket.state === "closed") throw new ClaimCollisionError("Ticket is already closed");
      ticket.comments.push(`Resolution: ${resolution}`);
      ticket.artifacts.push(...artifacts);
      ticket.state = "closed";
      ticket.status = "Done";
      delete ticket.assignee;
      delete ticket.claim;
    });
  }
  async appendMapContext(mapRef: MapRef, ticketRef: TicketRef, gist: string): Promise<void> {
    await this.#mutate(undefined, (document) => {
      const map = document.maps.find((item) => item.ref === mapRef);
      if (!map) throw new Error(`Unknown map: ${mapRef}`);
      const ticket = this.#ticket(document, ticketRef);
      if (ticket.map !== mapRef || ticket.state !== "closed")
        throw new Error("A map context pointer requires a closed ticket on that map");
      const marker = `[${ticket.title}](${ticket.ref})`;
      if (map.context.some((line) => line.includes(marker)))
        throw new ClaimCollisionError("Map context pointer already exists");
      map.context.push(`${marker} — ${gist}`);
    });
  }
  async read(): Promise<MarkdownTrackerDocument> {
    return parseMarkdownTracker(await readFile(this.path, "utf8"));
  }

  async #mutate(
    expectedVersion: string | undefined,
    update: (document: MarkdownTrackerDocument) => void,
  ): Promise<void> {
    await this.#withLock(async () => {
      const source = await readFile(this.path, "utf8");
      const document = parseMarkdownTracker(source);
      if (expectedVersion !== undefined && String(document.version) !== expectedVersion)
        throw new ClaimCollisionError();
      update(document);
      document.version += 1;
      const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
      try {
        await writeFile(temporary, formatMarkdownTracker(document), "utf8");
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
  }
  async #withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;
    let lock: Awaited<ReturnType<typeof open>>;
    try {
      lock = await open(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new ClaimCollisionError();
      throw error;
    }
    try {
      return await operation();
    } finally {
      await lock.close();
      await rm(lockPath, { force: true });
    }
  }
  #ticket(document: MarkdownTrackerDocument, ref: TicketRef): MarkdownTicketRecord {
    const ticket = document.tickets.find((item) => item.ref === ref);
    if (!ticket) throw new Error(`Unknown ticket: ${ref}`);
    return ticket;
  }
  #matchingClaim(
    document: MarkdownTrackerDocument,
    ticketRef: TicketRef,
    claimRef: ClaimRef,
  ): MarkdownClaimRecord {
    const claim = this.#ticket(document, ticketRef).claim;
    if (!claim || claim.ref !== claimRef || claim.status !== "active")
      throw new ClaimCollisionError();
    return claim;
  }
  #claimPayload(ticket: MarkdownTicketRecord): ClaimPayload {
    return {
      ...(ticket.assignee === undefined ? {} : { assignee: ticket.assignee }),
      status: ticket.status,
      ...(ticket.claim === undefined ? {} : { claim: structuredClone(ticket.claim) }),
    };
  }
  #snapshotPayload(snapshot: TrackerSnapshot): ClaimPayload {
    if (!snapshot.payload || typeof snapshot.payload !== "object")
      throw new Error("Invalid Markdown tracker snapshot");
    return structuredClone(snapshot.payload) as ClaimPayload;
  }
  #restorePayload(ticket: MarkdownTicketRecord, snapshot: TrackerSnapshot): void {
    const payload = this.#snapshotPayload(snapshot);
    ticket.status = payload.status;
    if (payload.assignee === undefined) delete ticket.assignee;
    else ticket.assignee = payload.assignee;
    if (payload.claim === undefined) delete ticket.claim;
    else ticket.claim = payload.claim;
  }
}

export function parseMarkdownTracker(source: string): MarkdownTrackerDocument {
  const start = source.indexOf(BLOCK_START);
  if (start < 0) throw new Error(`Missing ${BLOCK_START} state block`);
  const jsonStart = source.indexOf("\n", start);
  const end = source.indexOf(`\n${BLOCK_END}`, jsonStart);
  if (jsonStart < 0 || end < 0) throw new Error("Unterminated Wayfinder tracker state block");
  const value: unknown = JSON.parse(source.slice(jsonStart + 1, end));
  if (!isDocument(value)) throw new Error("Invalid Wayfinder Markdown tracker document");
  return value;
}
export function formatMarkdownTracker(document: MarkdownTrackerDocument): string {
  const maps = document.maps
    .toSorted((a, b) => a.order - b.order)
    .map((map) => {
      const context = map.context.length
        ? map.context.map((line) => `- ${line}`).join("\n")
        : "_None yet._";
      return `## ${map.title}\n\n### Decisions so far\n\n${context}`;
    })
    .join("\n\n");
  return `# Wayfinder tracker\n\n${maps}\n\n${BLOCK_START}\n${JSON.stringify(document, null, 2)}\n${BLOCK_END}\n`;
}
function isDocument(value: unknown): value is MarkdownTrackerDocument {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<MarkdownTrackerDocument>;
  return (
    item.format === "wayfinder-markdown-tracker" &&
    Number.isSafeInteger(item.version) &&
    Array.isArray(item.maps) &&
    Array.isArray(item.tickets) &&
    item.tickets.every(
      (ticket) =>
        ticket &&
        typeof ticket.ref === "string" &&
        typeof ticket.map === "string" &&
        Array.isArray(ticket.comments) &&
        Array.isArray(ticket.artifacts) &&
        (ticket.dependencies === undefined || Array.isArray(ticket.dependencies)),
    )
  );
}
