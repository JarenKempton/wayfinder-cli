import { readFileSync } from "node:fs";
import type { Ticket } from "../domain.ts";
import { evaluateFrontier } from "../frontier.ts";
import { parseRef } from "../reference.ts";
import { defineAction } from "./definition.ts";
import { optional, positional, text } from "./input.ts";
import { parseScope } from "./store.ts";

export function frontierActions() {
  return {
    resolve: defineAction({
      description: "Normalize a qualified tracker reference.",
      input: { reference: positional(text("Qualified tracker reference.", "REFERENCE")) },
      dependencies: {},
      handler: (_, input) => parseRef(input.reference),
    }),
    frontier: defineAction({
      description: "Read the eligible frontier from normalized ticket input without mutations.",
      input: {
        input: text("Normalized tickets JSON file.", "FILE"),
        scope: optional(text("Qualified tracker scope.", "REFERENCE")),
        available: optional(
          text("Comma-separated available statuses (default: To Do,Open).", "STATUSES"),
        ),
      },
      dependencies: {},
      handler(_, input) {
        const tickets = JSON.parse(readFileSync(input.input, "utf8")) as Ticket[];
        const result = evaluateFrontier(tickets, parseScope(input.scope), {
          availableStatuses: new Set(
            (input.available ?? "To Do,Open").split(",").map((value) => value.trim()),
          ),
        });
        return { tickets: result, count: result.length };
      },
      render: (result, json) =>
        json
          ? [JSON.stringify(result, null, 2)]
          : result.tickets.map((ticket) => `${ticket.ref}\t${ticket.kind}\t${ticket.status}`),
    }),
  };
}
