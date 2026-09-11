import { type DocSection, getDocPageSync, text } from "@optique/core";
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
  return formatDocPageAsMan({ sections }, { name: "wayfinder", section: 1, version });
}
