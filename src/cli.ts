#!/usr/bin/env bun
import { dispatch } from "./actions/command-line.ts";
import { createApplication } from "./application.ts";
import type { RuntimeServices } from "./runtime-services.ts";
import { notifyAboutUpdate } from "./update.ts";
import { VERSION } from "./version.ts";

export type { RuntimeServices } from "./runtime-services.ts";
export { VERSION } from "./version.ts";

export async function run(
  args: string[],
  write: (text: string) => void = console.log,
  services: RuntimeServices = {},
): Promise<void> {
  await dispatch(createApplication(services), args, write);
}

if (import.meta.main) {
  run(Bun.argv.slice(2))
    .then(() =>
      notifyAboutUpdate({
        currentVersion: VERSION,
        interactive: Boolean(process.stdout.isTTY && process.stderr.isTTY),
        json: Bun.argv.slice(2).includes("--json"),
      }),
    )
    .catch((error: unknown) => {
      console.error(`wayfinder: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
}
