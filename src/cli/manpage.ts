import { type DocSection, ensureNonEmptyString, getDocPageSync, text } from "@optique/core";
import { formatDocPageAsMan } from "@optique/man";
import { availableActions } from "./catalog.ts";
import type { ActionTree } from "./definition.ts";
export function manPage(version: string, tree: ActionTree): string {
  const sections: DocSection[] = availableActions(tree).map(({ command, action }) => ({
    title: command.join(" "),
    entries: [
      {
        term: { type: "command", name: command.join(" "), children: action.parser.usage },
        description: [text(action.description)],
      },
      ...(getDocPageSync(action.parser)?.sections.flatMap((section) => section.entries) ?? []),
    ],
  }));
  const operational: Record<string, Record<string, string>> = {
    ENVIRONMENT: {
      WAYFINDER_NO_UPDATE_CHECK: "Set to 1 to disable update notifications.",
      WAYFINDER_UPDATE_URL:
        "Override the release metadata endpoint for controlled installations and tests.",
      "VISUAL / EDITOR":
        "Editor executable used by config edit when --editor is omitted; arguments are not shell-expanded.",
      "XDG_STATE_HOME / HOME / LOCALAPPDATA":
        "Select the platform-specific state directory described under FILES.",
    },
    FILES: {
      "wayfinder.toml":
        "Project defaults, requirements and instruction/setup references. Secrets must not be placed in ordinary configuration, command arguments, logs, or receipts.",
      "wayfinder.db":
        "Local state and personal choices: $XDG_STATE_HOME/wayfinder (or $HOME/.local/state/wayfinder) on Linux; $HOME/Library/Application Support/wayfinder on macOS; %LOCALAPPDATA%/Wayfinder CLI on Windows.",
      "update-check.json": "Update-check timestamp, stored beside wayfinder.db.",
    },
    "EXIT STATUS": {
      "0 / non-zero":
        "Zero on success; non-zero when input, capability, safety or verification checks fail.",
    },
    "SEE ALSO": { "Project documentation": "https://github.com/JarenKempton/wayfinder-cli" },
  };
  sections.push(
    ...Object.entries(operational).map(([title, entries]) => ({
      title,
      entries: Object.entries(entries).map(([metavar, description]) => {
        ensureNonEmptyString(metavar);
        return { term: { type: "argument" as const, metavar }, description: [text(description)] };
      }),
    })),
  );
  return formatDocPageAsMan({ sections }, { name: "wayfinder", section: 1, version });
}
