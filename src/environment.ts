import type { AdapterRef, EnvironmentProfileRef, EnvironmentStartAuthorization } from "./domain.ts";

export interface EnvironmentSettings {
  adapter?: AdapterRef;
  profile?: EnvironmentProfileRef;
}

export interface ResolvedEnvironmentSettings {
  adapter: AdapterRef;
  profile: EnvironmentProfileRef;
}

/** Merge workspace, local, ticket/map, and invocation layers from lowest to highest precedence. */
export function resolveEnvironmentSettings(...layers: EnvironmentSettings[]): EnvironmentSettings {
  const resolved: EnvironmentSettings = {};
  for (const layer of layers) {
    if (layer.adapter !== undefined) resolved.adapter = layer.adapter;
    if (layer.profile !== undefined) resolved.profile = layer.profile;
  }
  return resolved;
}

/** Validate selection before any environment adapter is called. */
export function requireEnvironmentSettings(
  settings: EnvironmentSettings,
): ResolvedEnvironmentSettings {
  if (!settings.adapter) throw new Error("An environment adapter is required");
  if (!settings.profile) throw new Error("An environment profile is required");
  return { adapter: settings.adapter, profile: settings.profile };
}

/** Validate the explicit authority required before a side-effecting environment start. */
export function requireEnvironmentStartAuthorization(
  authorization?: EnvironmentStartAuthorization,
): EnvironmentStartAuthorization {
  if (!authorization) throw new Error("Environment start authorization is required");
  if (authorization.kind === "policy" && !authorization.policy?.trim()) {
    throw new Error("Environment automation policy must be named");
  }
  return authorization;
}
