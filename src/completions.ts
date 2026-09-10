import { availableActions } from "./actions/catalog.ts";
import type { ActionTree } from "./actions/definition.ts";
export type CompletionShell = "bash" | "fish" | "zsh";

export function completionCandidates(tree: ActionTree, words: readonly string[]): string[] {
  const entries = availableActions(tree);
  const children = entries
    .filter((entry) => words.every((part, index) => entry.command[index] === part))
    .flatMap((entry) => entry.command[words.length] ?? []);
  if (children.length) return [...new Set(children)];
  const entry = entries.find((entry) =>
    entry.command.every((part, index) => words[index] === part),
  );
  if (!entry) return [];
  return [
    ...Object.entries(entry.action.fields)
      .filter(([, field]) => !field.positional)
      .map(([name]) => `--${name}`),
    "--help",
    "--json",
  ].filter((option) => !words.includes(option));
}

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return `# bash completion for wayfinder
_wayfinder() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  local prefix="\${COMP_WORDS[*]:1:COMP_CWORD-1}"
  local choices
  choices="$(wayfinder completions bash --at "$prefix")" || return
  COMPREPLY=( $(compgen -W "$choices" -- "$current") )
}
complete -F _wayfinder wayfinder
`;
    case "zsh":
      return `#compdef wayfinder
_wayfinder() {
  local -a choices
  local prefix="\${(j: :)words[2,CURRENT-1]}"
  choices=(\${(f)"$(wayfinder completions zsh --at "$prefix")"})
  compadd -- $choices
}
compdef _wayfinder wayfinder
`;
    case "fish":
      return `function __wayfinder_candidates
  set -l words (commandline -opc)
  set -e words[1]
  set -l prefix ""
  if test (count $words) -gt 0
    set prefix (string join ' ' -- $words)
  end
  wayfinder completions fish --at "$prefix"
end
complete -c wayfinder -f -a '(__wayfinder_candidates)'
`;
  }
}
export function parseCompletionShell(value: string | undefined): CompletionShell {
  if (value === "bash" || value === "zsh" || value === "fish") return value;
  throw new Error("completions requires one of: bash, zsh, fish");
}
