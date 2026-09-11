import { readFileSync } from "node:fs";
import { defineAction } from "../cli/definition.ts";
import { optional, positional, text } from "../cli/schema.ts";
import { parseRef } from "../domain/reference.ts";
import { parseTickets } from "../domain/tickets.ts";
import { parseScope } from "../persistence/command-store.ts";
import { evaluateFrontier } from "./evaluate.ts";

export function frontierActions() {
  return {
    resolve: defineAction({
      description: "Normalize a qualified tracker reference.",
      input: { reference: positional(text("Qualified tracker reference.", "REFERENCE")) },
      handler: (input) => parseRef(input.reference),
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
      handler(input) {
        const tickets = parseTickets(JSON.parse(readFileSync(input.input, "utf8")));
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
