import { z } from "zod";
import { actorRefSchema, groupRefSchema, mapRefSchema, ticketRefSchema } from "./identifiers.ts";
export const ticketSchema = z.object({
  ref: ticketRefSchema,
  map: mapRefSchema,
  group: groupRefSchema.optional(),
  kind: z.enum(["task", "research", "prototype", "decision"]),
  state: z.enum(["open", "closed"]),
  status: z.string(),
  order: z.number(),
  title: z.string().optional(),
  description: z.string().optional(),
  acceptanceCriteria: z.string().optional(),
  assignee: actorRefSchema.optional(),
  priority: z.number().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dependencies: z
    .array(
      z.object({ blocking: ticketRefSchema, blocked: ticketRefSchema, kind: z.literal("blocks") }),
    )
    .optional(),
});
export function parseTickets(input: unknown) {
  const result = z.array(ticketSchema).safeParse(input);
  if (!result.success) throw new Error("Invalid ticket input");
  return result.data;
}
