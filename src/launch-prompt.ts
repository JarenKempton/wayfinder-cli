import type { Ticket, TicketKind } from "./domain.ts";

const ROLE_TEMPLATES: Record<TicketKind, string> = {
  task: "Implement only the selected task and verify its acceptance criteria. Record the implementation artifact and verification evidence.",
  research:
    "Investigate only the selected research question using primary sources. Record a linked findings artifact and evidence.",
  prototype:
    "Build only the selected prototype to answer its decision question. Record the artifact and verdict.",
  decision:
    "Gather the human's decision for the selected ticket. Do not answer on the human's behalf.",
};
/** Extract conventional Markdown, Jira plain headings, or VERIFY sections without discarding the original description. */
export function acceptanceCriteria(description: string): string | undefined {
  const lines = description.split(/\r?\n/);
  const start = lines.findIndex((line) =>
    /^(?:#{1,6}\s*|h[1-6]\.\s*)?(?:\*\*)?(?:acceptance criteria|acceptance|ac|verify)(?:\*\*)?\s*(?:\([^\n]*\))?\s*:?\s*$/i.test(
      line.trim(),
    ),
  );
  if (start < 0) return undefined;
  const end = lines.findIndex(
    (line, index) =>
      index > start && /^(?:#{1,6}\s+|h[1-6]\.\s+|[A-Z][A-Z /_-]{2,}:?\s*$)/.test(line),
  );
  return (
    lines
      .slice(start + 1, end < 0 ? undefined : end)
      .join("\n")
      .trim() || undefined
  );
}
export interface LaunchPromptOptions {
  roleTemplate?: string;
  runtimeContract?: string;
  tracker?: string;
  context?: string;
}
export function buildLaunchPrompt(ticket: Ticket, options: LaunchPromptOptions = {}): string {
  const criteria = ticket.acceptanceCriteria ?? acceptanceCriteria(ticket.description ?? "");
  return [
    ...(options.runtimeContract
      ? [`Read the Wayfinder runtime contract:\n${options.runtimeContract}`]
      : []),
    ...(options.tracker ? [`Tracker:\n${options.tracker}`] : []),
    `Map:\n${ticket.map}`,
    `Ticket:\n${ticket.ref}${ticket.title ? ` — ${ticket.title}` : ""}`,
    `Role:\n${ticket.kind}`,
    `Allowed action:\n${options.roleTemplate ?? ROLE_TEMPLATES[ticket.kind]}`,
    `Description:\n${ticket.description ?? "Not supplied by tracker."}`,
    `Acceptance criteria:\n${criteria ?? "Not supplied by tracker; verify with the ticket owner before completion."}`,
    "Required output:\n- resolution comment with evidence when resolving\n- linked implementation/findings artifact\n- close only after acceptance is verified\n- append exactly one map context pointer after close",
    ...(options.context ? [`Session-specific instructions:\n${options.context}`] : []),
  ].join("\n\n");
}
/** Jira ADF -> readable text. Preserve block/list boundaries and link destinations. */
export function jiraDescription(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  function render(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid Jira description document");
    const node = value as Record<string, unknown>;
    if (typeof node.type !== "string") throw new Error("Invalid Jira description node");
    if (node.type === "text") {
      if (typeof node.text !== "string") throw new Error("Invalid Jira description text");
      const marks = Array.isArray(node.marks) ? node.marks : [];
      const link = marks.find((mark) => mark?.type === "link")?.attrs?.href;
      return node.text + (typeof link === "string" ? ` (${link})` : "");
    }
    if (node.type === "hardBreak") return "\n";
    if (node.content !== undefined && !Array.isArray(node.content))
      throw new Error("Invalid Jira description content");
    const content = ((node.content ?? []) as unknown[]).map(render).join("");
    if (
      ["paragraph", "heading", "listItem", "codeBlock", "blockquote", "tableRow"].includes(
        node.type,
      )
    )
      return `${content.trimEnd()}\n`;
    return content;
  }
  return render(value).trimEnd();
}
