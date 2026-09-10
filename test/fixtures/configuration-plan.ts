import { configurationVersion, parseProjectToml } from "../../src/configuration/files.ts";
import { INITIAL_CONFIGURATION } from "../../src/configuration/project-files.ts";
import { resolveProjectConfiguration } from "../../src/configuration/schema.ts";
import { planConfiguredLaunch } from "../../src/configuration-plan.ts";
import type { Ticket } from "../../src/domain.ts";

export const fakePlanningTicket: Ticket = {
  ref: "jira:example:TEST:ticket:TEST-491" as Ticket["ref"],
  map: "jira:example:TEST:map:TEST-470" as Ticket["map"],
  kind: "task",
  state: "open",
  status: "To Do",
  order: 0,
  title: "Carry complete ticket context",
  description:
    "OUTCOME\nBuild inspectable configuration.\n\nVERIFY (all must pass)\n- Prompt contains ticket title and description.\n- Plan includes a t3 block without starting a session.\n\nRULES\nUse fake tracker input only.",
};
export function fakeConfigurationPlan() {
  const configuration = resolveProjectConfiguration(
    parseProjectToml(INITIAL_CONFIGURATION),
    {},
    { path: "wayfinder.toml (fake input)", version: configurationVersion(INITIAL_CONFIGURATION) },
  );
  return planConfiguredLaunch({
    ticket: fakePlanningTicket,
    configuration,
    available: { hosts: ["t3"], agents: ["codex"] },
  });
}
if (import.meta.main) console.log(JSON.stringify(fakeConfigurationPlan(), null, 2));
