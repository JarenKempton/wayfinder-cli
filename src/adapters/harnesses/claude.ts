import type { HarnessProfile } from "./profiles.ts";

export const claude: HarnessProfile = {
  argv: ["claude", "-p", "{prompt}"],
  platforms: ["darwin", "linux"],
};
