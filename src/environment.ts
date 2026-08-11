import type { EnvironmentProfile, EnvironmentServiceSelection } from "./domain.ts";

export interface EnvironmentSettings {
  profile?: string;
  services?: Record<string, EnvironmentServiceSelection>;
}

/** Merge repository, user, and invocation settings from lowest to highest precedence. */
export function resolveEnvironmentSettings(...layers: EnvironmentSettings[]): EnvironmentSettings {
  const resolved: EnvironmentSettings = {};
  for (const layer of layers) {
    if (layer.profile !== undefined) resolved.profile = layer.profile;
    if (layer.services !== undefined)
      resolved.services = { ...resolved.services, ...layer.services };
  }
  return resolved;
}

export function selectEnvironmentProfile(
  profiles: EnvironmentProfile[],
  settings: EnvironmentSettings,
): EnvironmentProfile {
  if (!settings.profile) throw new Error("An environment profile is required");
  const profile = profiles.find((candidate) => candidate.name === settings.profile);
  if (!profile) throw new Error(`Unknown environment profile: ${settings.profile}`);

  const services = new Map(profile.services.map((service) => [service.service, service]));
  for (const [name, selection] of Object.entries(settings.services ?? {})) {
    if (selection.service !== name) {
      throw new Error(`Service override key does not match selection: ${name}`);
    }
    if (!services.has(name)) throw new Error(`Unknown service override: ${name}`);
    services.set(name, selection);
  }
  return { name: profile.name, services: [...services.values()] };
}
