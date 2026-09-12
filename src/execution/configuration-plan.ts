import {
  type ResolvedConfiguration,
  requireAvailableSelections,
  validateResolvedConfiguration,
} from "../configuration/schema.ts";
import type { Ticket } from "../domain/model.ts";
import { buildLaunchPrompt } from "./launch-prompt.ts";

/** Pure configuration planning; performs no tracker, workspace, storage, or host operations. */
export interface InstructionInput {
  path: string;
  resolvedPath: string;
  version: string;
  content: string;
}

export function planConfiguredLaunch(input: {
  ticket: Ticket;
  configuration: ResolvedConfiguration;
  // Caller supplies agents verified for the selected host. For T3 these are its
  // configured providers, not standalone harness executables found on PATH.
  available: { hosts: readonly string[]; agents: readonly string[] };
  instructions?: { runtimeContract?: InstructionInput; roleTemplate?: InstructionInput };
}) {
  const configuration = validateResolvedConfiguration(input.configuration);
  requireAvailableSelections(configuration, input.available);
  const settings = configuration.settings;
  const references = configuration.project.instructions;
  for (const [key, path] of [
    ["runtimeContract", references?.runtime_contract],
    ["roleTemplate", references?.role_templates?.[input.ticket.kind]],
  ] as const) {
    const loaded = input.instructions?.[key];
    if (
      path !== loaded?.path ||
      (loaded && (!loaded.version || !loaded.content.trim() || !loaded.resolvedPath))
    )
      throw new Error(`Configured ${key} must be loaded with its content version before planning`);
  }
  return structuredClone({
    version: 1,
    state: "planned",
    dryRun: true,
    ticket: input.ticket,
    configuration,
    ...(settings.host === "t3"
      ? {
          t3: {
            provider: settings.agent,
            model: settings.model,
            thinking_effort: settings.effort,
            context_window: settings.context_window,
            runtime_mode: settings.runtime_mode,
            interaction_mode: settings.interaction_mode,
            open: configuration.project.t3.open,
            verification: "pending-host-preflight",
          },
        }
      : {}),
    instructions: Object.values(input.instructions ?? {}).map(
      ({ content: _content, ...source }) => source,
    ),
    prompt: buildLaunchPrompt(input.ticket, {
      tracker: configuration.project.tracker.jira.site,
      ...(input.instructions?.runtimeContract
        ? { runtimeContract: input.instructions.runtimeContract.resolvedPath }
        : {}),
      ...(input.instructions?.roleTemplate
        ? { roleTemplate: input.instructions.roleTemplate.content }
        : {}),
    }),
  });
}
