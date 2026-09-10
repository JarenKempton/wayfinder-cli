import { actionUsage, availableActions } from "./actions/catalog.ts";
import type { ActionTree } from "./actions/definition.ts";
export function manPage(version: string, tree: ActionTree): string {
  return `.TH WAYFINDER 1 "" "wayfinder ${version}" "User Commands"
.SH NAME
wayfinder \\- portable work orchestration for agents
.SH SYNOPSIS
.B wayfinder
.I command
[…]
.SH DESCRIPTION
Wayfinder discovers eligible work from maps and coordinates claims, deterministic
workspaces, harness launches, supervision, and recovery. Tracker state remains the
durable coordination truth.
.SH COMMANDS
${availableActions(tree)
  .map((entry) => `.TP\n.B ${actionUsage(entry)}\n${entry.action.description}`)
  .join("\n")}
.SH ENVIRONMENT
.TP
.B WAYFINDER_NO_UPDATE_CHECK
Set to 1 to disable update notifications.
.TP
.B WAYFINDER_UPDATE_URL
Override the release metadata endpoint. Intended for controlled installations and tests.
.SH FILES
Wayfinder stores local state under the platform-specific user state directory. Secrets must
not be placed in ordinary configuration, command arguments, logs, or receipts.
.SH EXIT STATUS
Returns zero on success and non-zero when input, capability, safety, or verification checks fail.
.SH SEE ALSO
Project documentation: https://github.com/JarenKempton/wayfinder-cli
`;
}
