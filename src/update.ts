import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { updateCheckPath } from "./paths.ts";

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const RELEASES_URL = "https://api.github.com/repos/JarenKempton/wayfinder-cli/releases?per_page=20";

interface UpdateCache {
  checkedAt: string;
}

interface GitHubRelease {
  draft?: boolean;
  prerelease?: boolean;
  tag_name?: string;
  html_url?: string;
}

export interface UpdateCheckOptions {
  currentVersion: string;
  interactive: boolean;
  json?: boolean;
  environment?: NodeJS.ProcessEnv;
  cachePath?: string;
  now?: () => Date;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  intervalMs?: number;
  timeoutMs?: number;
  timeoutSignal?: (timeoutMs: number) => AbortSignal;
  writeError?: (text: string) => void;
}

export interface AvailableUpdate {
  currentVersion: string;
  latestVersion: string;
  url: string;
}

export async function checkForUpdate(
  options: UpdateCheckOptions,
): Promise<AvailableUpdate | undefined> {
  const environment = options.environment ?? process.env;
  if (
    !options.interactive ||
    options.json ||
    isEnabled(environment.CI) ||
    isEnabled(environment.WAYFINDER_NO_UPDATE_CHECK)
  ) {
    return undefined;
  }
  const current = parseVersion(options.currentVersion);
  if (!current) return undefined;
  if (current.prerelease[0] === "dev") return undefined;

  const now = options.now?.() ?? new Date();
  const cachePath = options.cachePath ?? updateCheckPath(environment);
  const cached = await readCache(cachePath);
  const interval = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const elapsed = cached ? now.getTime() - Date.parse(cached.checkedAt) : Number.POSITIVE_INFINITY;
  if (elapsed >= 0 && elapsed < interval) return undefined;

  // Persist the attempt before doing network I/O. A failed or interrupted GitHub
  // request must not cause every subsequent CLI invocation to retry it.
  await writeCache(cachePath, { checkedAt: now.toISOString() });

  const response = await (options.fetch ?? globalThis.fetch)(
    environment.WAYFINDER_UPDATE_URL ?? RELEASES_URL,
    {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "wayfinder-cli" },
      signal: (options.timeoutSignal ?? AbortSignal.timeout)(options.timeoutMs ?? 2_000),
    },
  );
  if (!response.ok) throw new Error(`release check returned HTTP ${response.status}`);
  const releases = (await response.json()) as GitHubRelease[];
  const allowPrerelease = current.prerelease.length > 0;
  const latest = releases.reduce<{ release: GitHubRelease; version: Version } | undefined>(
    (selected, release) => {
      if (release.draft || !release.tag_name || !release.html_url) return selected;
      if (!allowPrerelease && release.prerelease) return selected;
      const version = parseVersion(release.tag_name);
      if (!version || (selected && compareVersions(version, selected.version) <= 0))
        return selected;
      return { release, version };
    },
    undefined,
  );
  if (!latest?.release.tag_name || !latest.release.html_url) return undefined;
  if (compareVersions(latest.version, current) <= 0) return undefined;
  return {
    currentVersion: options.currentVersion,
    latestVersion: latest.release.tag_name.replace(/^v/, ""),
    url: latest.release.html_url,
  };
}

export async function notifyAboutUpdate(options: UpdateCheckOptions): Promise<void> {
  try {
    const update = await checkForUpdate(options);
    if (update) {
      (options.writeError ?? console.error)(
        `Wayfinder ${update.latestVersion} is available (current ${update.currentVersion}).\n` +
          `Install the new release from ${update.url}`,
      );
    }
  } catch {
    // Update availability must never make an otherwise valid command fail.
  }
}

interface Version {
  parts: [number, number, number];
  prerelease: string[];
}

function parseVersion(raw: string): Version | undefined {
  const match =
    /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      raw,
    );
  if (!match) return undefined;
  return {
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareVersions(left: Version, right: Version): number {
  for (let index = 0; index < left.parts.length; index += 1) {
    const difference = (left.parts[index] ?? 0) - (right.parts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = left.prerelease[index];
    const rightPart = right.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumeric = /^\d+$/.test(leftPart);
    const rightNumeric = /^\d+$/.test(rightPart);
    if (leftNumeric && rightNumeric) return Number(leftPart) - Number(rightPart);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftPart < rightPart ? -1 : 1;
  }
  return 0;
}

function isEnabled(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value.toLowerCase() !== "false" && value !== "0";
}

async function readCache(path: string): Promise<UpdateCache | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as UpdateCache;
    return typeof parsed.checkedAt === "string" && Number.isFinite(Date.parse(parsed.checkedAt))
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}
