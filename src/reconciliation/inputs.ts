import { flag, optional, positional, text } from "../cli/schema.ts";
export const statusesInput = {
  scope: positional(text("Qualified tracker scope.", "scope")),
  input: optional(text("Normalized ticket input (required unless recovering).", "FILE")),
  available: optional(text("Ready status (default: To Do).", "STATUS")),
  blocked: optional(text("Blocked status (default: Blocked).", "STATUS")),
  repair: flag(
    "Plan or apply status repair; applying requires composed repair and receipt services.",
  ),
  "dry-run": flag("Plan repairs without mutation; requires --repair."),
  recover: optional(
    text(
      "Recover a durable repair receipt; requires composed repair and receipt services.",
      "receipt-ref",
    ),
  ),
};
