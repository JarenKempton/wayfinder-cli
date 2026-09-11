import type { HarnessProfile } from "./profiles.ts";

export const codex: HarnessProfile = {
  argv: ["codex", "exec", "{prompt}"],
  platforms: ["darwin", "linux"],
};
