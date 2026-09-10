import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { type PersonalSettings, validatePersonalSettings } from "./schema.ts";
export function readPersonalSettings(statePath: string, projectPath: string): PersonalSettings {
  if (!existsSync(statePath)) return {};
  const database = new Database(statePath, { readonly: true, strict: true });
  try {
    if (
      !database
        .query(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='configuration_overrides'",
        )
        .get()
    )
      return {};
    const row = database
      .query("SELECT settings_json FROM configuration_overrides WHERE project_path=?")
      .get(projectPath) as { settings_json: string } | null;
    if (!row) return {};
    let settings: unknown;
    try {
      settings = JSON.parse(row.settings_json);
    } catch {
      throw new Error("Invalid local configuration record");
    }
    return validatePersonalSettings(settings);
  } finally {
    database.close();
  }
}
