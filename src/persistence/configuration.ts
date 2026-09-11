import type { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-zod";
import {
  validatePersonalSettings,
  validateResolvedConfiguration,
} from "../configuration/schema.ts";

export const configurationOverrides = sqliteTable("configuration_overrides", {
  project_path: text().primaryKey(),
  settings_json: text().notNull(),
});
export const executionConfigurations = sqliteTable("execution_configurations", {
  run_ref: text().primaryKey(),
  snapshot_json: text().notNull(),
});
function decode(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new Error("Invalid local configuration record");
  }
}
const settingsRow = createSelectSchema(configurationOverrides).transform((row) =>
  validatePersonalSettings(decode(row.settings_json)),
);
const snapshotRow = createSelectSchema(executionConfigurations).transform((row) =>
  validateResolvedConfiguration(decode(row.snapshot_json)),
);

/** Wrap the caller's connection, preserving its read-only and transaction settings. */
export function configurationStore(database: Database) {
  const db = drizzle(database);
  return {
    readPersonal(projectPath: string) {
      const row = databaseOperation(() =>
        db
          .select()
          .from(configurationOverrides)
          .where(eq(configurationOverrides.project_path, projectPath))
          .get(),
      );
      return row ? settingsRow.parse(row) : {};
    },
    savePersonal(projectPath: string, input: unknown) {
      const settings = validatePersonalSettings(input);
      if (!Object.keys(settings).length) {
        databaseOperation(() =>
          db
            .delete(configurationOverrides)
            .where(eq(configurationOverrides.project_path, projectPath))
            .run(),
        );
      } else {
        const values = { project_path: projectPath, settings_json: JSON.stringify(settings) };
        databaseOperation(() =>
          db
            .insert(configurationOverrides)
            .values(values)
            .onConflictDoUpdate({
              target: configurationOverrides.project_path,
              set: { settings_json: values.settings_json },
            })
            .run(),
        );
      }
      return settings;
    },
    saveSnapshot(run: string, input: unknown) {
      const snapshot = validateResolvedConfiguration(input);
      databaseOperation(() =>
        db
          .insert(executionConfigurations)
          .values({ run_ref: run, snapshot_json: JSON.stringify(snapshot) })
          .run(),
      );
    },
    readSnapshot(run: string) {
      const row = databaseOperation(() =>
        db
          .select()
          .from(executionConfigurations)
          .where(eq(executionConfigurations.run_ref, run))
          .get(),
      );
      return row ? snapshotRow.parse(row) : undefined;
    },
  };
}

// Driver errors can include bound values. Keep SQL and parameters out of CLI diagnostics.
function databaseOperation<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    throw new Error("Local configuration database operation failed");
  }
}
