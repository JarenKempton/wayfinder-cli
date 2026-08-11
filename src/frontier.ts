import type { GroupRef, MapRef, Ticket, TicketRef, WorkspaceRef } from "./domain.ts";

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
  const byRef = new Map<TicketRef, Ticket>(tickets.map((ticket) => [ticket.ref, ticket]));
  const eligible: Ticket[] = [];

  for (const ticket of tickets) {
    if (!isInScope(ticket, scope)) continue;
    if (ticket.state !== "open") continue;
    if (!options.availableStatuses.has(ticket.status)) continue;
    if (ticket.assignee !== undefined) continue;

    let blocked = false;
    for (const dependency of ticket.dependencies ?? []) {
      if (dependency.blocked !== ticket.ref) continue;
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

  return eligible.toSorted(
    (left, right) => left.order - right.order || left.ref.localeCompare(right.ref),
  );
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
  return true;
}
