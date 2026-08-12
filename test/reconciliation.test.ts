import { describe, expect, test } from "bun:test";
import type { Ticket, TicketRef } from "../src/domain.ts";
import { deriveCloseoutFrontierHandoff, reconcileDependencyStatuses } from "../src/frontier.ts";

const ref = (value: string) => value as TicketRef;
const map = "jira:x:W:map:M" as Ticket["map"];
const policy = {
  ready: "To Do",
  blocked: "Blocked",
  managedStatuses: new Set(["To Do", "Blocked"]),
  protectedStatuses: new Set(["In Progress", "In Review"]),
};
const ticket = (id: string, order: number, status = "To Do"): Ticket => ({
  ref: ref(`jira:x:W:ticket:${id}`),
  map,
  kind: "task",
  state: "open",
  status,
  order,
  metadata: { version: `v-${id}` },
});

describe("dependency status reconciliation", () => {
  test("derives blocked and ready statuses without mutating tracker input", () => {
    const blocker = ticket("A", 0);
    const blocked = ticket("B", 1);
    blocked.dependencies = [{ blocking: blocker.ref, blocked: blocked.ref, kind: "blocks" }];
    const alreadyBlocked = { ...ticket("C", 2, "Blocked"), dependencies: blocked.dependencies };
    alreadyBlocked.dependencies = [
      { blocking: blocker.ref, blocked: alreadyBlocked.ref, kind: "blocks" },
    ];
    const input = [blocker, blocked, alreadyBlocked];

    const result = reconcileDependencyStatuses(input, {}, policy);

    expect(result.transitions).toEqual([
      {
        ticket: blocked.ref,
        from: "To Do",
        to: "Blocked",
        expectedVersion: "v-B",
        unresolvedBlockers: [blocker.ref],
      },
    ]);
    expect(result.tickets.map((item) => item.status)).toEqual(["To Do", "Blocked", "Blocked"]);
    expect(input[1]?.status).toBe("To Do");
  });

  test("does not overwrite assigned, closed, or unmanaged workflow states", () => {
    const blocker = ticket("A", 0);
    const assigned = { ...ticket("B", 1), assignee: "human" as NonNullable<Ticket["assignee"]> };
    const active = ticket("C", 2, "In Progress");
    const closed = { ...ticket("D", 3, "Done"), state: "closed" as const };
    const unmanaged = {
      ...ticket("E", 4, "Backlog"),
      assignee: "human" as NonNullable<Ticket["assignee"]>,
    };
    for (const item of [assigned, active, closed, unmanaged]) {
      item.dependencies = [{ blocking: blocker.ref, blocked: item.ref, kind: "blocks" }];
    }
    const result = reconcileDependencyStatuses(
      [blocker, assigned, active, closed, unmanaged],
      {},
      policy,
    );
    expect(result.transitions).toEqual([]);
    expect(result.drift).toEqual([
      {
        ticket: assigned.ref,
        from: "To Do",
        to: "Blocked",
        unresolvedBlockers: [blocker.ref],
        reasons: ["assigned"],
      },
      {
        ticket: active.ref,
        from: "In Progress",
        to: "Blocked",
        unresolvedBlockers: [blocker.ref],
        reasons: ["protected_status"],
      },
    ]);
    expect(result.tickets.find((item) => item.ref === unmanaged.ref)?.status).toBe("Backlog");
  });

  test("fails closed for incomplete graphs and invalid policies", () => {
    const blocked = ticket("B", 0);
    blocked.dependencies = [
      { blocking: ref("jira:x:W:ticket:A"), blocked: blocked.ref, kind: "blocks" },
    ];
    expect(() => reconcileDependencyStatuses([blocked], {}, policy)).toThrow("unknown blocker");
    expect(() => reconcileDependencyStatuses([], {}, { ...policy, blocked: "To Do" })).toThrow(
      "distinct",
    );
  });

  test("uses cross-map blockers from the full graph but reports only scoped tickets", () => {
    const otherMap = "jira:x:W:map:OTHER" as Ticket["map"];
    const blocker = { ...ticket("A", 0), map: otherMap };
    const inside = ticket("B", 1);
    inside.dependencies = [{ blocking: blocker.ref, blocked: inside.ref, kind: "blocks" }];
    const outside = { ...ticket("C", 2), map: otherMap };
    outside.dependencies = [{ blocking: inside.ref, blocked: outside.ref, kind: "blocks" }];

    const result = reconcileDependencyStatuses([blocker, inside, outside], { map }, policy);

    expect(result.transitions.map((item) => item.ticket)).toEqual([inside.ref]);
    expect(result.tickets.find((item) => item.ref === outside.ref)?.status).toBe("To Do");
  });

  test("validates scope against the complete workspace graph", () => {
    const input = [ticket("A", 0)];
    expect(() =>
      reconcileDependencyStatuses(input, { map: "jira:x:OTHER:map:M" as Ticket["map"] }, policy),
    ).toThrow("outside workspace");
  });
});

describe("closeout frontier handoff", () => {
  test("waits for verified close, reconciles dependents, and reports newly eligible in order", () => {
    const closing = ticket("A", 0, "In Progress");
    closing.assignee = "human" as NonNullable<Ticket["assignee"]>;
    const later = ticket("B", 2, "Blocked");
    const first = ticket("C", 1, "Blocked");
    for (const item of [later, first]) {
      item.dependencies = [{ blocking: closing.ref, blocked: item.ref, kind: "blocks" }];
    }
    const afterClosing = { ...closing, state: "closed" as const, status: "Done" };

    const result = deriveCloseoutFrontierHandoff(
      [closing, later, first],
      [afterClosing, later, first],
      closing.ref,
      { map },
      policy,
    );

    expect(result.transitions.map((item) => [item.ticket, item.from, item.to])).toEqual([
      [later.ref, "Blocked", "To Do"],
      [first.ref, "Blocked", "To Do"],
    ]);
    expect(result.frontier.map((item) => item.ref)).toEqual([first.ref, later.ref]);
    expect(result.newlyEligible.map((item) => item.ref)).toEqual([first.ref, later.ref]);
  });

  test("refuses a handoff until close is observed and snapshots match", () => {
    const closing = ticket("A", 0, "In Progress");
    expect(() =>
      deriveCloseoutFrontierHandoff([closing], [closing], closing.ref, {}, policy),
    ).toThrow("not verified");
    expect(() =>
      deriveCloseoutFrontierHandoff(
        [closing],
        [{ ...closing, state: "closed", status: "Done" }, ticket("B", 1)],
        closing.ref,
        {},
        policy,
      ),
    ).toThrow("Closeout snapshot graph changed");
  });

  test.each([
    ["changed edge", (item: Ticket) => ({ ...item, dependencies: [] })],
    [
      "changed map ownership",
      (item: Ticket) => ({ ...item, map: "jira:x:W:map:OTHER" as Ticket["map"] }),
    ],
    [
      "changed group ownership",
      (item: Ticket) => ({ ...item, group: "jira:x:W:group:G" as NonNullable<Ticket["group"]> }),
    ],
    ["changed kind", (item: Ticket) => ({ ...item, kind: "research" as const })],
    ["changed order", (item: Ticket) => ({ ...item, order: item.order + 1 })],
    ["unrelated status", (item: Ticket) => ({ ...item, status: "To Do" })],
    [
      "unrelated tracker version",
      (item: Ticket) => ({ ...item, metadata: { version: "changed" } }),
    ],
    [
      "unrelated assignee",
      (item: Ticket) => ({ ...item, assignee: "human" as NonNullable<Ticket["assignee"]> }),
    ],
  ])("rejects %s between closeout snapshots", (_label, change) => {
    const closing = ticket("A", 0, "In Progress");
    const dependent = ticket("B", 1, "Blocked");
    dependent.dependencies = [{ blocking: closing.ref, blocked: dependent.ref, kind: "blocks" }];
    expect(() =>
      deriveCloseoutFrontierHandoff(
        [closing, dependent],
        [{ ...closing, state: "closed", status: "Done" }, change(dependent)],
        closing.ref,
        {},
        policy,
      ),
    ).toThrow("Closeout snapshot");
  });

  test("rejects malformed and duplicate closeout graphs", () => {
    const closing = ticket("A", 0, "In Progress");
    const closed = { ...closing, state: "closed" as const, status: "Done" };
    expect(() =>
      deriveCloseoutFrontierHandoff([closing, closing], [closed], closing.ref, {}, policy),
    ).toThrow("Duplicate ticket");
    const malformed = ticket("B", 1);
    malformed.dependencies = [
      { blocking: ref("jira:x:W:ticket:Z"), blocked: malformed.ref, kind: "blocks" },
    ];
    expect(() =>
      deriveCloseoutFrontierHandoff(
        [closing, malformed],
        [closed, malformed],
        closing.ref,
        {},
        policy,
      ),
    ).toThrow("unknown blocker");
  });
});
