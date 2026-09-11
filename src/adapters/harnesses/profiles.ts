import { z } from "zod";
import { claude } from "./claude.ts";
import { codex } from "./codex.ts";
import { cursor } from "./cursor.ts";
import { opencode } from "./opencode.ts";
import { pi } from "./pi.ts";

export interface HarnessProfile {
  argv: readonly [string, ...string[]];
  platforms?: readonly NodeJS.Platform[];
}

// Registration is the only inventory; discovery and name validation derive from it.
export const namedHarnesses = { pi, claude, codex, cursor, opencode };
export type NamedHarnessName = keyof typeof namedHarnesses;
export const namedHarnessNameSchema = z.custom<NamedHarnessName>(
  (value) => typeof value === "string" && Object.hasOwn(namedHarnesses, value),
  "Unknown harness",
);
