export interface ExecutionSettings {
  harness?: string;
  model?: string;
  effort?: string;
}

/** Applies settings from lowest to highest precedence. Empty values do not erase prior choices. */
export function resolveExecutionSettings(
  ...layers: readonly ExecutionSettings[]
): ExecutionSettings {
  const resolved: ExecutionSettings = {};
  for (const layer of layers) {
    if (layer.harness) resolved.harness = layer.harness;
    if (layer.model) resolved.model = layer.model;
    if (layer.effort) resolved.effort = layer.effort;
  }
  return resolved;
}
