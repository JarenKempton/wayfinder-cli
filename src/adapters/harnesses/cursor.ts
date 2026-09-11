import type { HarnessProfile } from "./profiles.ts";

export const cursor: HarnessProfile = {
  argv: ["cursor-agent", "-p", "{prompt}"],
  platforms: ["darwin", "linux"],
};
