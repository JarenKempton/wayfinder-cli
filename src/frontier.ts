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
}

export interface DependencyStatusPolicy {
  ready: string;
  blocked: string;
  /** Only these statuses are owned by dependency reconciliation. */
  managedStatuses: ReadonlySet<string>;
  /** Active workflow states that must be reported, never overwritten. */
  protectedStatuses?: ReadonlySet<string>;
}

export interface DependencyStatusTransition {
  ticket: TicketRef;
  from: string;
  to: string;
  expectedVersion: string;
  unresolvedBlockers: TicketRef[];
}

export interface DependencyStatusDrift extends Omit<DependencyStatusTransition, "expectedVersion"> {
  reasons: ("assigned" | "protected_status")[];
}

export interface DependencyStatusReconciliation {
  tickets: Ticket[];
  transitions: DependencyStatusTransition[];
  drift: DependencyStatusDrift[];
}

export interface CloseoutFrontierHandoff extends DependencyStatusReconciliation {
  frontier: Ticket[];
  newlyEligible: Ticket[];
}

export interface CloseoutVerification {
  beforeVersion: string;
  afterVersion: string;
  fromStatus: string;
  toStatus: string;
}

export function evaluateFrontier(
  tickets: readonly Ticket[],
  scope: FrontierScope,
  options: FrontierOptions,
): Ticket[] {
  const normalized = normalizeTrackerTickets(tickets);
  const normalizedScope = normalizeScope(scope);
  validateScope(normalizedScope, normalized.workspace);
  const byRef = new Map<TicketRef, Ticket>(
    normalized.tickets.map((ticket) => [ticket.ref, ticket]),
  );
  const eligible: Ticket[] = [];

  for (const ticket of normalized.tickets) {
    if (!isInScope(ticket, normalizedScope)) continue;
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

/**
 * Derives tracker status changes from the complete dependency graph without mutating input.
 * The complete workspace graph is validated and used for blocker evaluation, while only tickets
 * inside `scope` may produce transitions or drift. Assigned and protected tickets are drift only.
 */
export function reconcileDependencyStatuses(
  tickets: readonly Ticket[],
  scope: FrontierScope,
  policy: DependencyStatusPolicy,
): DependencyStatusReconciliation {
  validateDependencyStatusPolicy(policy);
  const normalized = normalizeTrackerTickets(tickets);
  const normalizedScope = normalizeScope(scope);
  validateScope(normalizedScope, normalized.workspace);
  const byRef = new Map(normalized.tickets.map((ticket) => [ticket.ref, ticket]));
  const transitions: DependencyStatusTransition[] = [];
  const drift: DependencyStatusDrift[] = [];
  const reconciled = normalized.tickets.map((ticket) => {
    if (!isInScope(ticket, normalizedScope) || ticket.state !== "open") return ticket;
    const unresolvedBlockers = (ticket.dependencies ?? [])
      .map((dependency) => byRef.get(dependency.blocking) as Ticket)
      .filter((blocker) => blocker.state !== "closed")
      .map((blocker) => blocker.ref);
    const status = unresolvedBlockers.length > 0 ? policy.blocked : policy.ready;
    if (status === ticket.status) return ticket;
    const protectedStatus = policy.protectedStatuses?.has(ticket.status) ?? false;
    if (!policy.managedStatuses.has(ticket.status) && !protectedStatus) return ticket;
    const candidate = { ticket: ticket.ref, from: ticket.status, to: status, unresolvedBlockers };
    const reasons: DependencyStatusDrift["reasons"] = [];
    if (ticket.assignee !== undefined) reasons.push("assigned");
    if (protectedStatus) reasons.push("protected_status");
    if (reasons.length > 0) {
      drift.push({ ...candidate, reasons });
      return ticket;
    }
    const expectedVersion = ticket.metadata?.version;
    if (typeof expectedVersion !== "string" || expectedVersion.length === 0) {
      throw new Error(`Ticket ${ticket.ref} lacks a tracker version guard for status repair`);
    }
    const transition = { ...candidate, expectedVersion };
    transitions.push(transition);
    return { ...ticket, status };
  });
  return { tickets: reconciled, transitions, drift };
}

/**
 * Computes the post-close status plan and the stable frontier handoff. The tracker snapshots
 * remain the authority: the close must already be visible in `after` before a handoff is emitted.
 */
export function deriveCloseoutFrontierHandoff(
  before: readonly Ticket[],
  after: readonly Ticket[],
  closedTicket: TicketRef,
  verification: CloseoutVerification,
  scope: FrontierScope,
  policy: DependencyStatusPolicy,
): CloseoutFrontierHandoff {
  const normalizedBefore = normalizeTrackerTickets(before).tickets;
  const normalizedAfter = normalizeTrackerTickets(after).tickets;
  validateCloseoutSnapshots(normalizedBefore, normalizedAfter, closedTicket, verification);
  const prior = reconcileDependencyStatuses(normalizedBefore, scope, policy);
  const next = reconcileDependencyStatuses(normalizedAfter, scope, policy);
  const beforeByRef = new Map(prior.tickets.map((ticket) => [ticket.ref, ticket]));
  const closedBefore = beforeByRef.get(closedTicket);
  const closedAfter = next.tickets.find((ticket) => ticket.ref === closedTicket);
  if (!closedBefore || !closedAfter) throw new Error(`Closeout ticket is absent: ${closedTicket}`);
  if (closedBefore.state !== "open" || closedAfter.state !== "closed") {
    throw new Error(`Closeout transition is not verified: ${closedTicket}`);
  }
  const frontierOptions = { availableStatuses: new Set([policy.ready]) };
  const priorFrontier = new Set(
    evaluateFrontier(prior.tickets, scope, frontierOptions).map((ticket) => ticket.ref),
  );
  const frontier = evaluateFrontier(next.tickets, scope, frontierOptions);
  return {
    ...next,
    frontier,
    newlyEligible: frontier.filter((ticket) => !priorFrontier.has(ticket.ref)),
  };
}

function validateCloseoutSnapshots(
  before: readonly Ticket[],
  after: readonly Ticket[],
  closing: TicketRef,
  verification: CloseoutVerification,
): void {
  const afterByRef = new Map(after.map((ticket) => [ticket.ref, ticket]));
  if (before.length !== after.length) throw new Error("Closeout snapshot graph changed");
  for (const prior of before) {
    const next = afterByRef.get(prior.ref);
    if (!next) throw new Error(`Closeout snapshot ticket changed: ${prior.ref}`);
    if (stableTicketShape(prior) !== stableTicketShape(next)) {
      throw new Error(`Closeout snapshot graph changed for ${prior.ref}`);
    }
    if (prior.ref === closing) {
      const priorVersion = prior.metadata?.version;
      const nextVersion = next.metadata?.version;
      if (
        prior.state !== "open" ||
        next.state !== "closed" ||
        prior.status !== verification.fromStatus ||
        next.status !== verification.toStatus ||
        priorVersion !== verification.beforeVersion ||
        nextVersion !== verification.afterVersion ||
        priorVersion === nextVersion ||
        prior.assignee !== next.assignee ||
        stableMetadata(prior, true) !== stableMetadata(next, true)
      ) {
        throw new Error(`Closeout transition is not verified: ${closing}`);
      }
      continue;
    }
    if (
      prior.state !== next.state ||
      prior.status !== next.status ||
      prior.assignee !== next.assignee ||
      stableMetadata(prior, false) !== stableMetadata(next, false)
    ) {
      throw new Error(`Closeout snapshot eligibility changed for ${prior.ref}`);
    }
  }
}

function stableMetadata(ticket: Ticket, omitVersion: boolean): string {
  const metadata = { ...(ticket.metadata ?? {}) };
  if (omitVersion) delete metadata.version;
  return JSON.stringify(canonicalValue(metadata));
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function stableTicketShape(ticket: Ticket): string {
  return JSON.stringify({
    ref: ticket.ref,
    map: ticket.map,
    group: ticket.group ?? null,
    kind: ticket.kind,
    order: ticket.order,
    priority: ticket.priority ?? null,
    dependencies: (ticket.dependencies ?? [])
      .map(({ blocking, blocked, kind }) => ({ blocking, blocked, kind }))
      .toSorted((left, right) =>
        `${left.blocking}\0${left.blocked}\0${left.kind}`.localeCompare(
          `${right.blocking}\0${right.blocked}\0${right.kind}`,
        ),
      ),
  });
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
    if (!ticket || typeof ticket !== "object") throw new Error("Invalid normalized ticket");
    requireKind(ticket.ref, "ticket");
    requireKind(ticket.map, "map");
    if (ticket.group !== undefined) requireKind(ticket.group, "group");
    if (!["task", "research", "prototype", "decision"].includes(ticket.kind)) {
      throw new Error(`Ticket ${ticket.ref} has an unsupported kind: ${ticket.kind}`);
    }
    if (ticket.state !== "open" && ticket.state !== "closed") {
      throw new Error(`Ticket ${ticket.ref} has an unsupported state: ${ticket.state}`);
    }
    if (typeof ticket.status !== "string" || ticket.status.length === 0) {
      throw new Error(`Ticket ${ticket.ref} has an invalid status`);
    }
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

  for (const ticket of normalized) {
    for (const dependency of ticket.dependencies ?? []) {
      if (!seen.has(dependency.blocking)) {
        throw new Error(`Ticket ${ticket.ref} references unknown blocker ${dependency.blocking}`);
      }
    }
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

function requireKind(reference: string, expected: "workspace" | "group" | "map" | "ticket"): void {
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
  if (references.length > 1) throw new Error("Frontier scope must contain at most one reference");
  const reference = references[0];
  if (
    reference !== undefined &&
    workspace !== undefined &&
    workspaceRefOf(reference) !== workspace
  ) {
    throw new Error(`Frontier scope ${reference} is outside workspace ${workspace}`);
  }
}

function normalizeScope(scope: FrontierScope): FrontierScope {
  return {
    ...(scope.workspace === undefined
      ? {}
      : { workspace: normalizeScopeRef(scope.workspace, "workspace") as WorkspaceRef }),
    ...(scope.group === undefined
      ? {}
      : { group: normalizeScopeRef(scope.group, "group") as GroupRef }),
    ...(scope.map === undefined ? {} : { map: normalizeScopeRef(scope.map, "map") as MapRef }),
    ...(scope.ticket === undefined
      ? {}
      : { ticket: normalizeScopeRef(scope.ticket, "ticket") as TicketRef }),
  };
}

function normalizeScopeRef(
  reference: string,
  expected: "workspace" | "group" | "map" | "ticket",
): string {
  const parsed = parseRef(reference);
  if (parsed.kind !== expected) {
    throw new Error(`Expected ${expected} scope reference, received ${parsed.kind}: ${parsed.raw}`);
  }
  return parsed.raw;
}

function validateDependencyStatusPolicy(policy: DependencyStatusPolicy): void {
  if (!policy.ready || !policy.blocked || policy.ready === policy.blocked) {
    throw new Error("Dependency status policy requires distinct ready and blocked statuses");
  }
  if (!policy.managedStatuses.has(policy.ready) || !policy.managedStatuses.has(policy.blocked)) {
    throw new Error("Dependency status policy must manage its ready and blocked statuses");
  }
}
