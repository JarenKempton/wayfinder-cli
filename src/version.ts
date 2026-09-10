declare const WAYFINDER_BUILD_VERSION: string | undefined;
export const VERSION =
  typeof WAYFINDER_BUILD_VERSION === "string" ? WAYFINDER_BUILD_VERSION : "0.1.0-dev";
