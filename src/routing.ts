import type { Capability, CapabilitySet } from "./domain.ts";
import { capabilities, requireCapabilities } from "./domain.ts";

export const CONFIGURATION_LAYER_ORDER = [
  "harness",
  "user",
  "repository",
  "workspace",
  "group",
  "map",
  "ticket",
  "cli",
] as const;

export type ConfigurationLayer = (typeof CONFIGURATION_LAYER_ORDER)[number];

export interface ExecutionSettings {
  harness?: string;
  model?: string;
  effort?: string;
  context?: string;
  requiredCapabilities?: CapabilitySet;
}

export type LayeredExecutionSettings = Partial<Record<ConfigurationLayer, ExecutionSettings>>;

export interface ResolvedExecutionRoute extends ExecutionSettings {
  harness: string;
  sources: Partial<Record<keyof ExecutionSettings, ConfigurationLayer>>;
}

/**
 * Resolves named configuration scopes in one fixed order. Scalars use the most
 * specific non-empty value; required capabilities accumulate across all scopes.
 */
export function resolveExecutionRoute(layers: LayeredExecutionSettings): ResolvedExecutionRoute {
  const resolved: ExecutionSettings = {};
  const sources: ResolvedExecutionRoute["sources"] = {};
  const requiredCapabilities: CapabilitySet = {};

  for (const name of CONFIGURATION_LAYER_ORDER) {
    const layer = layers[name];
    if (!layer) continue;
    for (const key of ["harness", "model", "effort", "context"] as const) {
      const value = layer[key];
      if (value === undefined || value === "") continue;
      resolved[key] = value as never;
      sources[key] = name;
    }
    for (const capability of enabledCapabilities(layer.requiredCapabilities)) {
      requiredCapabilities[capability] = true;
    }
  }

  if (!resolved.harness) throw new Error("No harness is configured for this execution");
  if (Object.keys(requiredCapabilities).length > 0) {
    resolved.requiredCapabilities = requiredCapabilities;
    const source = mostSpecificCapabilitySource(layers);
    if (source) sources.requiredCapabilities = source;
  }
  return { ...resolved, harness: resolved.harness, sources };
}

/** Backward-compatible low-to-high scalar merge for protocol-major v1 callers. */
export function resolveExecutionSettings(
  ...layers: readonly ExecutionSettings[]
): ExecutionSettings {
  const resolved: ExecutionSettings = {};
  const requiredCapabilities: CapabilitySet = {};
  for (const layer of layers) {
    for (const key of ["harness", "model", "effort", "context"] as const) {
      const value = layer[key];
      if (value !== undefined && value !== "") resolved[key] = value as never;
    }
    for (const capability of enabledCapabilities(layer.requiredCapabilities)) {
      requiredCapabilities[capability] = true;
    }
  }
  if (Object.keys(requiredCapabilities).length > 0) {
    resolved.requiredCapabilities = requiredCapabilities;
  }
  return resolved;
}

/** Validates every requested routing feature against the selected harness. */
export function validateExecutionRoute(route: ExecutionSettings, available: CapabilitySet): void {
  const required = { ...route.requiredCapabilities };
  if (route.model) required.model_selection = true;
  if (route.effort) required.reasoning_selection = true;
  if (route.context) required.context_selection = true;
  requireCapabilities(available, required);
}

function enabledCapabilities(set: CapabilitySet | undefined): Capability[] {
  if (!set) return [];
  return (Object.keys(set) as Capability[]).filter((capability) => set[capability]);
}

function mostSpecificCapabilitySource(
  layers: LayeredExecutionSettings,
): ConfigurationLayer | undefined {
  for (const name of CONFIGURATION_LAYER_ORDER.toReversed()) {
    if (enabledCapabilities(layers[name]?.requiredCapabilities).length > 0) return name;
  }
  return undefined;
}

export function executionCapabilities(route: ExecutionSettings): CapabilitySet {
  return capabilities(
    ...(route.model ? (["model_selection"] as const) : []),
    ...(route.effort ? (["reasoning_selection"] as const) : []),
    ...(route.context ? (["context_selection"] as const) : []),
    ...enabledCapabilities(route.requiredCapabilities),
  );
}
