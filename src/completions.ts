export type CompletionShell = "bash" | "fish" | "zsh";

const commands = [
  "doctor",
  "resolve",
  "frontier",
  "reconcile",
  "adapter",
  "runs",
  "claim",
  "supervisor",
  "stop",
  "recover",
  "version",
  "completions",
  "man",
] as const;

export function completionScript(shell: CompletionShell): string {
  switch (shell) {
    case "bash":
      return `# bash completion for wayfinder
_wayfinder() {
  local current="\${COMP_WORDS[COMP_CWORD]}"
  if [[ COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${commands.join(" ")}" -- "$current") )
  fi
}
complete -F _wayfinder wayfinder
`;
    case "zsh":
      return `#compdef wayfinder
_wayfinder() {
  local -a commands
  commands=(${commands.map((command) => `'${command}'`).join(" ")})
  _describe 'command' commands
}
compdef _wayfinder wayfinder
`;
    case "fish":
      return `${commands
        .map((command) => `complete -c wayfinder -f -n '__fish_use_subcommand' -a ${command}`)
        .join("\n")}\n`;
  }
}

export function parseCompletionShell(value: string | undefined): CompletionShell {
  if (value === "bash" || value === "zsh" || value === "fish") return value;
  throw new Error("completions requires one of: bash, zsh, fish");
}
