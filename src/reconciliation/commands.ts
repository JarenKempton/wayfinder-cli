import { defineAction } from "../cli/definition.ts";
import type { RuntimeServices } from "../runtime-services.ts";
import { statusesInput } from "./inputs.ts";
import { reconcileStatuses } from "./repair.ts";
export function reconciliationActions(services: RuntimeServices) {
  return {
    reconcile: {
      statuses: defineAction({
        description:
          "Audit dependency-derived statuses; optionally plan repairs or use composed repair services.",
        input: statusesInput,
        handler: (input) => reconcileStatuses(input, services),
        render(result, json) {
          if (json || !("transitions" in result)) return [JSON.stringify(result, null, 2)];
          return [
            ...result.transitions.map((item) => `${item.ticket}\t${item.from} -> ${item.to}`),
            ...result.drift.map((item) => `${item.ticket}\tattention: ${item.from} -> ${item.to}`),
          ];
        },
      }),
    },
  };
}
