import { join } from "node:path";

export function dataDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const root = environment.LOCALAPPDATA;
    if (!root) throw new Error("LOCALAPPDATA is not set");
    return join(root, "Wayfinder CLI");
  }
  if (process.platform === "darwin") {
    const home = environment.HOME;
    if (!home) throw new Error("HOME is not set");
    return join(home, "Library", "Application Support", "wayfinder");
  }
  const root = environment.XDG_STATE_HOME;
  if (root) return join(root, "wayfinder");
  const home = environment.HOME;
  if (!home) throw new Error("HOME is not set");
  return join(home, ".local", "state", "wayfinder");
}

export function databasePath(environment: NodeJS.ProcessEnv = process.env): string {
  return join(dataDirectory(environment), "wayfinder.db");
}
