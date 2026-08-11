import { describe, expect, test } from "bun:test";
import type { Ticket, TicketRef } from "../src/domain.ts";
import {
  evaluateFrontier,
  normalizeTrackerTickets,
  selectFrontierTicket,
} from "../src/frontier.ts";

const ref = (value: string) => value as TicketRef;
const base = (value: string, order: number): Ticket => ({
  ref: ref(value),
  map: "jira:x:W:map:M1" as Ticket["map"],
  kind: "task",
  state: "open",
  status: "To Do",
  order,
});

describe("frontier", () => {
  test("supports cross-map blockers and stable ordering", () => {
    const a = base("jira:x:W:ticket:A", 2);
    const b = { ...base("jira:x:W:ticket:B", 1), map: "jira:x:W:map:M2" as Ticket["map"] };
    b.dependencies = [{ blocking: a.ref, blocked: b.ref, kind: "blocks" }];
    const c = base("jira:x:W:ticket:C", 0);
    expect(
      evaluateFrontier([a, b, c], {}, { availableStatuses: new Set(["To Do"]) }).map(
        (item) => item.ref,
      ),
    ).toEqual([c.ref, a.ref]);
  });

  test("preserves tracker input order when order values tie", () => {
    const z = base("jira:x:W:ticket:Z", 1);
    const a = base("jira:x:W:ticket:A", 1);
    expect(
      evaluateFrontier([z, a], {}, { availableStatuses: new Set(["To Do"]) }).map(
        (item) => item.ref,
      ),
    ).toEqual([z.ref, a.ref]);
  });

  test("honors qualified workspace, group, map, and ticket scopes", () => {
    const a = {
      ...base("jira:x:W:ticket:A", 0),
      group: "jira:x:W:group:G1" as NonNullable<Ticket["group"]>,
    };
    const b = {
      ...base("jira:x:W:ticket:B", 1),
      map: "jira:x:W:map:M2" as Ticket["map"],
      group: "jira:x:W:group:G2" as NonNullable<Ticket["group"]>,
    };
    const options = { availableStatuses: new Set(["To Do"]) };
    expect(evaluateFrontier([a, b], { workspace: "jira:x:W" as never }, options)).toHaveLength(2);
    expect(evaluateFrontier([a, b], { group: a.group }, options)).toEqual([a]);
    expect(evaluateFrontier([a, b], { map: b.map }, options)).toEqual([b]);
    expect(evaluateFrontier([a, b], { ticket: a.ref }, options)).toEqual([a]);
  });

  test("closed blockers unblock and assignees exclude", () => {
    const a = { ...base("jira:x:W:ticket:A", 0), state: "closed" as const, status: "Done" };
    const b = base("jira:x:W:ticket:B", 1);
    b.dependencies = [{ blocking: a.ref, blocked: b.ref, kind: "blocks" }];
    const c = {
      ...base("jira:x:W:ticket:C", 2),
      assignee: "human" as NonNullable<Ticket["assignee"]>,
    };
    expect(evaluateFrontier([a, b, c], {}, { availableStatuses: new Set(["To Do"]) })).toEqual([b]);
  });

  test("unknown blockers fail closed", () => {
    const ticket = base("jira:x:W:ticket:B", 0);
    ticket.dependencies = [
      { blocking: ref("jira:x:W:ticket:A"), blocked: ticket.ref, kind: "blocks" },
    ];
    expect(() => evaluateFrontier([ticket], {}, { availableStatuses: new Set(["To Do"]) })).toThrow(
      "unknown blocker",
    );
  });

  test("rejects cross-workspace and malformed tracker inputs", () => {
    const a = base("jira:x:W:ticket:A", 0);
    const other = {
      ...base("jira:x:OTHER:ticket:B", 1),
      map: "jira:x:OTHER:map:M2" as Ticket["map"],
    };
    expect(() => normalizeTrackerTickets([a, other])).toThrow("Cross-workspace frontier");

    const malformed = base("jira:x:W:ticket:B", 1);
    malformed.dependencies = [{ blocking: a.ref, blocked: a.ref, kind: "blocks" }];
    expect(() => normalizeTrackerTickets([a, malformed])).toThrow("dependency owned by");

    expect(() => normalizeTrackerTickets([a, { ...a }])).toThrow("Duplicate ticket");
  });

  test("noninteractive selection requires a policy", () => {
    const tickets = [
      { ...base("a", 0), priority: 1 },
      { ...base("b", 1), priority: 5 },
    ];
    expect(() => selectFrontierTicket(tickets, "")).toThrow();
    expect(selectFrontierTicket(tickets, "highest-priority").ref).toBe(ref("b"));
  });
});
