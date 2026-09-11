declare const WAYFINDER_BUILD_VERSION: string | undefined;
export const VERSION =
  typeof WAYFINDER_BUILD_VERSION === "string" ? WAYFINDER_BUILD_VERSION : "0.1.0-dev";

// Release ownership is supplied by the build workflow, including forked releases.
declare const WAYFINDER_BUILD_RELEASES_URL: string | undefined;
export const RELEASES_URL =
  typeof WAYFINDER_BUILD_RELEASES_URL === "string" ? WAYFINDER_BUILD_RELEASES_URL : undefined;
