import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { configurationStore } from "../persistence/configuration.ts";
import type { PersonalSettings } from "./schema.ts";
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
    return configurationStore(database).readPersonal(projectPath);
  } finally {
    database.close();
  }
}
