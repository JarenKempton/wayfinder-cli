export function manPage(version: string): string {
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
.TP
.B doctor
Check whether the executable and local state directory are usable.
.TP
.B resolve REFERENCE
Normalize a qualified tracker reference.
.TP
.B frontier --input FILE [--scope REFERENCE] [--json]
Evaluate a read-only frontier from normalized ticket input.
.TP
.B reconcile statuses SCOPE --input FILE [--repair [--dry-run]] [--json]
Audit dependency-derived statuses and, when a conforming service is present, repair them.
.TP
.B adapter list|describe|test|conformance
Inspect or verify adapter capabilities.
.TP
.B runs list|show|export
Inspect durable local run state.
.TP
.B claim show CLAIM-ID
Inspect durable local claim state.
.TP
.B supervisor status
Inspect runs requiring supervision.
.TP
.B completions bash|zsh|fish
Print a shell completion script to standard output.
.TP
.B man
Print this manual page in roff format.
.TP
.B version
Print the embedded build version.
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
