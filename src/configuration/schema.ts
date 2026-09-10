/** Portable configuration validation and resolution; no filesystem or runtime discovery. */
export const SETTING_KEYS = [
  "host",
  "agent",
  "model",
  "effort",
  "context_window",
  "runtime_mode",
  "interaction_mode",
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type PersonalSettings = Partial<Record<SettingKey, string>>;
export interface RepositoryConfiguration {
  github: string;
  path: string;
  worktree_root: string;
  base_branch: string;
}
export interface MapConfiguration {
  repository: string;
  claim_status: string;
  available_statuses: string[];
  claim_comment_required?: boolean;
}
export interface SetupRecipe {
  version: string;
  steps: Array<{
    argv: string[];
    location: "source" | "workspace";
    scripts: Array<{ path: string; version: string }>;
  }>;
}
export interface ProjectConfiguration {
  version: 1;
  repositories: Record<string, RepositoryConfiguration>;
  maps: Record<string, MapConfiguration>;
  tracker: { jira: { site: string; cli?: string } };
  t3: {
    provider?: string;
    model?: string;
    thinking_effort?: string;
    context_window?: string;
    runtime_mode?: string;
    interaction_mode?: string;
    open?: "none" | "browser";
  };
  defaults: PersonalSettings;
  required: PersonalSettings;
  instructions?: {
    runtime_contract?: string;
    role_templates?: Partial<Record<"task" | "research" | "prototype" | "decision", string>>;
  };
  setup?: SetupRecipe;
}
export interface ResolvedConfiguration {
  version: 1;
  source: { path: string; version: string };
  project: ProjectConfiguration;
  settings: PersonalSettings;
  sources: Partial<Record<SettingKey, "default" | "personal" | "required">>;
}

function invalid(path: string): never {
  throw new Error(`Invalid configuration at ${path}`);
}
export function configObject(
  value: unknown,
  keys: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path);
  const object = value as Record<string, unknown>;
  // Do not echo unknown keys or supplied values: they may contain credentials.
  if (Object.keys(object).some((key) => !keys.includes(key))) invalid(path);
  return object;
}
export function hasControlCharacters(value: string): boolean {
  return [...value].some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}
export function configString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim() || hasControlCharacters(value)) invalid(path);
  return value;
}
function strings(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.length) invalid(path);
  return value.map((item) => configString(item, path));
}
function dictionary<T>(
  value: unknown,
  path: string,
  parse: (value: unknown) => T,
): Record<string, T> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(path);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [configString(key, path), parse(entry)]),
  );
}
export function validatePersonalSettings(value: unknown): PersonalSettings {
  const item = configObject(value, SETTING_KEYS, "settings");
  const result: PersonalSettings = {};
  for (const key of SETTING_KEYS)
    if (item[key] !== undefined) result[key] = configString(item[key], `settings.${key}`);
  if (
    result.runtime_mode &&
    !["approval-required", "auto-accept-edits", "auto", "full-access"].includes(result.runtime_mode)
  )
    invalid("settings.runtime_mode");
  if (result.interaction_mode && !["default", "plan"].includes(result.interaction_mode))
    invalid("settings.interaction_mode");
  return result;
}
export function validateProjectConfiguration(value: unknown): ProjectConfiguration {
  const item = configObject(
    value,
    [
      "version",
      "repositories",
      "maps",
      "tracker",
      "t3",
      "defaults",
      "required",
      "instructions",
      "setup",
    ],
    "project",
  );
  if (item.version !== 1) invalid("version");
  const repositories = dictionary(item.repositories, "repositories", (value) => {
    const r = configObject(value, ["github", "path", "worktree_root", "base_branch"], "repository");
    const github = configString(r.github, "repository.github");
    if (!/^[\w.-]+\/[\w.-]+$/.test(github)) invalid("repository.github");
    return {
      github,
      path: configString(r.path, "repository.path"),
      worktree_root: configString(r.worktree_root, "repository.worktree_root"),
      base_branch: configString(r.base_branch, "repository.base_branch"),
    };
  });
  const maps = dictionary(item.maps, "maps", (value) => {
    const m = configObject(
      value,
      ["repository", "claim_status", "available_statuses", "claim_comment_required"],
      "map",
    );
    const repository = configString(m.repository, "map.repository");
    if (!Object.hasOwn(repositories, repository)) invalid("map.repository");
    if (m.claim_comment_required !== undefined && typeof m.claim_comment_required !== "boolean")
      invalid("map.claim_comment_required");
    return {
      repository,
      claim_status: configString(m.claim_status, "map.claim_status"),
      available_statuses: strings(m.available_statuses, "map.available_statuses"),
      ...(m.claim_comment_required === undefined
        ? {}
        : { claim_comment_required: m.claim_comment_required as boolean }),
    };
  });
  const tracker = configObject(item.tracker, ["jira"], "tracker");
  const jira = configObject(tracker.jira, ["site", "cli"], "tracker.jira");
  const site = configString(jira.site, "tracker.jira.site");
  try {
    const url = new URL(site);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      invalid("tracker.jira.site");
  } catch {
    invalid("tracker.jira.site");
  }
  const t3 = configObject(
    item.t3 ?? {},
    [
      "provider",
      "model",
      "thinking_effort",
      "context_window",
      "runtime_mode",
      "interaction_mode",
      "open",
    ],
    "t3",
  );
  for (const value of Object.values(t3)) configString(value, "t3");
  if (t3.open !== undefined && t3.open !== "none" && t3.open !== "browser") invalid("t3.open");
  const result: ProjectConfiguration = {
    version: 1,
    repositories,
    maps,
    tracker: {
      jira: {
        site,
        ...(jira.cli === undefined ? {} : { cli: configString(jira.cli, "tracker.jira.cli") }),
      },
    },
    t3: t3 as ProjectConfiguration["t3"],
    defaults: validatePersonalSettings(item.defaults ?? {}),
    required: validatePersonalSettings(item.required ?? {}),
  };
  validatePersonalSettings(t3Defaults(result));
  if (item.instructions !== undefined) {
    const i = configObject(
      item.instructions,
      ["runtime_contract", "role_templates"],
      "instructions",
    );
    result.instructions = {};
    if (i.runtime_contract !== undefined)
      result.instructions.runtime_contract = configString(
        i.runtime_contract,
        "instructions.runtime_contract",
      );
    if (i.role_templates !== undefined) {
      const templates = configObject(
        i.role_templates,
        ["task", "research", "prototype", "decision"],
        "instructions.role_templates",
      );
      result.instructions.role_templates = Object.fromEntries(
        Object.entries(templates).map(([key, value]) => [
          key,
          configString(value, "instructions.role_templates"),
        ]),
      );
    }
  }
  if (item.setup !== undefined) {
    const setup = configObject(item.setup, ["version", "steps"], "setup");
    if (!Array.isArray(setup.steps) || !setup.steps.length) invalid("setup.steps");
    result.setup = {
      version: configString(setup.version, "setup.version"),
      steps: setup.steps.map((value) => {
        const step = configObject(value, ["argv", "location", "scripts"], "setup.step");
        if (step.location !== "source" && step.location !== "workspace")
          invalid("setup.step.location");
        if (!Array.isArray(step.scripts)) invalid("setup.step.scripts");
        return {
          argv: strings(step.argv, "setup.step.argv"),
          location: step.location,
          scripts: step.scripts.map((value) => {
            const script = configObject(value, ["path", "version"], "setup.step.script");
            return {
              path: configString(script.path, "setup.step.script.path"),
              version: configString(script.version, "setup.step.script.version"),
            };
          }),
        };
      }),
    };
  }
  return result;
}
function t3Defaults(project: ProjectConfiguration): PersonalSettings {
  const mapping = {
    provider: "agent",
    model: "model",
    thinking_effort: "effort",
    context_window: "context_window",
    runtime_mode: "runtime_mode",
    interaction_mode: "interaction_mode",
  } as const;
  const defaults: PersonalSettings = { host: "t3" };
  for (const [key, setting] of Object.entries(mapping)) {
    const value = project.t3[key as keyof typeof mapping];
    if (value !== undefined) defaults[setting] = value;
  }
  return defaults;
}
export function resolveProjectConfiguration(
  project: ProjectConfiguration,
  personal: PersonalSettings,
  source: ResolvedConfiguration["source"],
): ResolvedConfiguration {
  project = validateProjectConfiguration(project);
  personal = validatePersonalSettings(personal);
  const settings = { ...t3Defaults(project), ...project.defaults };
  const sources: ResolvedConfiguration["sources"] = {};
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined) sources[key] = "default";
    if (personal[key] !== undefined) {
      settings[key] = personal[key];
      sources[key] = "personal";
    }
    const required = project.required[key];
    if (required !== undefined) {
      if (personal[key] !== undefined && personal[key] !== required)
        throw new Error(
          `Personal ${key} conflicts with project requirement in ${source.path}; change the project requirement or follow its default`,
        );
      settings[key] = required;
      sources[key] = "required";
    }
  }
  return structuredClone({ version: 1, source, project, settings, sources });
}
export function requireAvailableSelections(
  config: ResolvedConfiguration,
  available: { hosts: readonly string[]; agents: readonly string[] },
): void {
  for (const [key, options] of [
    ["host", available.hosts],
    ["agent", available.agents],
  ] as const) {
    const selection = config.settings[key];
    if (!selection || !options.includes(selection))
      throw new Error(
        `Configured ${key} unavailable. Available supported alternatives: ${options.join(", ") || "none"}. Select explicitly; no substitution was made.`,
      );
  }
}

/** Validate persisted snapshots without re-reading today's defaults. */
export function validateResolvedConfiguration(value: unknown): ResolvedConfiguration {
  const item = configObject(
    value,
    ["version", "source", "project", "settings", "sources"],
    "resolved",
  );
  if (item.version !== 1) invalid("resolved.version");
  const source = configObject(item.source, ["path", "version"], "resolved.source");
  const settings = validatePersonalSettings(item.settings);
  const sources = configObject(item.sources, SETTING_KEYS, "resolved.sources");
  const personal: PersonalSettings = {};
  for (const key of SETTING_KEYS) {
    if (
      sources[key] !== undefined &&
      !["default", "personal", "required"].includes(sources[key] as string)
    )
      invalid("resolved.sources");
    if (sources[key] === "personal" && settings[key] !== undefined) personal[key] = settings[key];
  }
  const resolved = resolveProjectConfiguration(
    validateProjectConfiguration(item.project),
    personal,
    {
      path: configString(source.path, "resolved.source.path"),
      version: configString(source.version, "resolved.source.version"),
    },
  );
  for (const key of SETTING_KEYS)
    if (resolved.settings[key] !== settings[key] || resolved.sources[key] !== sources[key])
      invalid("resolved.settings");
  return resolved;
}
