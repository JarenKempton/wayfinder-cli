import type { GroupRef, MapRef, Ticket, TicketRef, WorkspaceRef } from "./domain.ts";
import { parseRef, workspaceRefOf } from "./reference.ts";

export interface FrontierScope {
  workspace?: WorkspaceRef;
  group?: GroupRef;
  map?: MapRef;
  ticket?: TicketRef;
}

export interface FrontierOptions {
  availableStatuses: ReadonlySet<string>;
  includeStaleClaims?: boolean;
}

export function evaluateFrontier(
  tickets: readonly Ticket[],
  scope: FrontierScope,
  options: FrontierOptions,
): Ticket[] {
  const normalized = normalizeTrackerTickets(tickets);
  validateScope(scope, normalized.workspace);
  const byRef = new Map<TicketRef, Ticket>(
    normalized.tickets.map((ticket) => [ticket.ref, ticket]),
  );
  const eligible: Ticket[] = [];

  for (const ticket of normalized.tickets) {
    if (!isInScope(ticket, scope)) continue;
    if (ticket.state !== "open") continue;
    if (!options.availableStatuses.has(ticket.status)) continue;
    if (ticket.assignee !== undefined) continue;

    let blocked = false;
    for (const dependency of ticket.dependencies ?? []) {
      const blocker = byRef.get(dependency.blocking);
      if (!blocker) {
        throw new Error(`Ticket ${ticket.ref} references unknown blocker ${dependency.blocking}`);
      }
      if (blocker.state !== "closed") {
        blocked = true;
        break;
      }
    }
    if (!blocked) eligible.push(ticket);
  }

  // Modern Array#sort is stable. Equal order values therefore retain the tracker
  // adapter's input order instead of inventing a reference-based ordering.
  return eligible.toSorted((left, right) => left.order - right.order);
}

export interface NormalizedTrackerTickets {
  workspace?: WorkspaceRef;
  tickets: Ticket[];
}

/**
 * Validates the normalized tracker boundary before core evaluates policy.
 * V1 intentionally fails closed on partial or cross-workspace dependency graphs.
 */
export function normalizeTrackerTickets(tickets: readonly Ticket[]): NormalizedTrackerTickets {
  const seen = new Set<TicketRef>();
  let workspace: WorkspaceRef | undefined;
  const normalized: Ticket[] = [];

  for (const ticket of tickets) {
    requireKind(ticket.ref, "ticket");
    requireKind(ticket.map, "map");
    if (ticket.group !== undefined) requireKind(ticket.group, "group");
    if (!Number.isFinite(ticket.order)) {
      throw new Error(`Ticket ${ticket.ref} has a non-finite tracker order`);
    }
    if (seen.has(ticket.ref)) throw new Error(`Duplicate ticket reference: ${ticket.ref}`);
    seen.add(ticket.ref);

    const ticketWorkspace = workspaceRefOf(ticket.ref) as WorkspaceRef;
    if (workspace === undefined) workspace = ticketWorkspace;
    if (workspace !== ticketWorkspace) {
      throw new Error(`Cross-workspace frontier input is not supported: ${ticket.ref}`);
    }
    requireSameWorkspace(ticket.ref, ticket.map);
    if (ticket.group !== undefined) requireSameWorkspace(ticket.ref, ticket.group);

    for (const dependency of ticket.dependencies ?? []) {
      requireKind(dependency.blocking, "ticket");
      requireKind(dependency.blocked, "ticket");
      if (dependency.kind !== "blocks") {
        throw new Error(`Ticket ${ticket.ref} has an unsupported dependency kind`);
      }
      if (dependency.blocked !== ticket.ref) {
        throw new Error(
          `Ticket ${ticket.ref} contains a dependency owned by ${dependency.blocked}`,
        );
      }
      requireSameWorkspace(ticket.ref, dependency.blocking);
    }
    normalized.push({
      ...ticket,
      ...(ticket.dependencies
        ? { dependencies: ticket.dependencies.map((item) => ({ ...item })) }
        : {}),
    });
  }

  return { ...(workspace ? { workspace } : {}), tickets: normalized };
}

export function selectFrontierTicket(tickets: readonly Ticket[], policy: string): Ticket {
  const first = tickets[0];
  if (!first) throw new Error("Frontier is empty");
  if (policy === "first") return first;
  if (policy === "highest-priority") {
    return tickets.reduce((selected, ticket) =>
      (ticket.priority ?? 0) > (selected.priority ?? 0) ? ticket : selected,
    );
  }
  throw new Error(`Unknown or missing noninteractive selection policy: ${JSON.stringify(policy)}`);
}

function isInScope(ticket: Ticket, scope: FrontierScope): boolean {
  if (scope.ticket !== undefined) return ticket.ref === scope.ticket;
  if (scope.map !== undefined) return ticket.map === scope.map;
  if (scope.group !== undefined) return ticket.group === scope.group;
  if (scope.workspace !== undefined) return workspaceRefOf(ticket.ref) === scope.workspace;
  return true;
}

function requireKind(reference: string, expected: "group" | "map" | "ticket"): void {
  const actual = parseRef(reference).kind;
  if (actual !== expected) {
    throw new Error(`Expected ${expected} reference, received ${actual}: ${reference}`);
  }
}

function requireSameWorkspace(owner: string, related: string): void {
  if (workspaceRefOf(owner) !== workspaceRefOf(related)) {
    throw new Error(`Cross-workspace relationship is not supported: ${owner} -> ${related}`);
  }
}

function validateScope(scope: FrontierScope, workspace: WorkspaceRef | undefined): void {
  const references = [scope.workspace, scope.group, scope.map, scope.ticket].filter(
    (item): item is WorkspaceRef | GroupRef | MapRef | TicketRef => item !== undefined,
  );
  if (references.length > 1) throw new Error("Frontier scope must contain exactly one reference");
  const reference = references[0];
  if (
    reference !== undefined &&
    workspace !== undefined &&
    workspaceRefOf(reference) !== workspace
  ) {
    throw new Error(`Frontier scope ${reference} is outside workspace ${workspace}`);
  }
}
