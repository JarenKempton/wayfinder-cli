import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkForUpdate, notifyAboutUpdate } from "../src/update.ts";

const release = (tag: string, prerelease = false) => ({
  tag_name: tag,
  prerelease,
  draft: false,
  html_url: `https://github.com/JarenKempton/wayfinder-cli/releases/tag/${tag}`,
});

describe("update notifications", () => {
  test("notifies interactive stable installations about newer stable releases", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "wayfinder-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.3",
      interactive: true,
      cachePath,
      now: () => new Date("2026-08-14T00:00:00Z"),
      fetch: async () => Response.json([release("v1.3.0"), release("v2.0.0-beta.1", true)]),
    });
    expect(result?.latestVersion).toBe("1.3.0");
    expect(JSON.parse(await readFile(cachePath, "utf8")).checkedAt).toBe(
      "2026-08-14T00:00:00.000Z",
    );
  });

  test("checks at most once per 24 hours", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "wayfinder-update-")), "cache.json");
    let requests = 0;
    const fetch = async () => {
      requests += 1;
      return Response.json([release("v1.3.0")]);
    };
    const base = {
      currentVersion: "1.2.3",
      interactive: true,
      cachePath,
      fetch,
    };
    await checkForUpdate({ ...base, now: () => new Date("2026-08-14T00:00:00Z") });
    expect(
      await checkForUpdate({ ...base, now: () => new Date("2026-08-14T23:59:59Z") }),
    ).toBeUndefined();
    expect(requests).toBe(1);
  });

  test("never checks for noninteractive, opted-out, CI, or development runs", async () => {
    let requests = 0;
    const fetch = async () => {
      requests += 1;
      return Response.json([]);
    };
    for (const options of [
      { currentVersion: "1.0.0", interactive: false },
      { currentVersion: "1.0.0", interactive: true, json: true },
      { currentVersion: "1.0.0", interactive: true, environment: { CI: "true" } },
      {
        currentVersion: "1.0.0",
        interactive: true,
        environment: { WAYFINDER_NO_UPDATE_CHECK: "1" },
      },
      { currentVersion: "0.1.0-dev", interactive: true },
    ]) {
      await checkForUpdate({ ...options, fetch });
    }
    expect(requests).toBe(0);
  });

  test("prerelease installations can see newer prereleases without downgrading", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "wayfinder-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.0-beta.1",
      interactive: true,
      cachePath,
      fetch: async () => Response.json([release("v1.3.0-beta.1", true)]),
    });
    expect(result?.latestVersion).toBe("1.3.0-beta.1");
  });

  test("uses SemVer precedence for prereleases and does not trust API ordering", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "wayfinder-update-")), "cache.json");
    const result = await checkForUpdate({
      currentVersion: "1.2.0-beta.2",
      interactive: true,
      cachePath,
      fetch: async () =>
        Response.json([
          release("v1.2.0-beta.3", true),
          release("v1.2.0-beta.11", true),
          release("v1.2.0-beta.alpha", true),
          release("v1.2.0-beta.4", true),
        ]),
    });
    expect(result?.latestVersion).toBe("1.2.0-beta.alpha");
  });

  test("records failed attempts so failure stays silent and is not retried for 24 hours", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wayfinder-update-"));
    const cachePath = join(directory, "cache.json");
    let requests = 0;
    const errors: string[] = [];
    const options = {
      currentVersion: "1.2.3",
      interactive: true,
      cachePath,
      now: () => new Date("2026-08-14T00:00:00Z"),
      fetch: async () => {
        requests += 1;
        throw new Error("offline");
      },
      writeError: (message: string) => errors.push(message),
    };
    await notifyAboutUpdate(options);
    await notifyAboutUpdate(options);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
    expect((await readdir(directory)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  test("injects a short timeout signal and writes an available update only to stderr", async () => {
    const cachePath = join(await mkdtemp(join(tmpdir(), "wayfinder-update-")), "cache.json");
    const signal = new AbortController().signal;
    const timeouts: number[] = [];
    const errors: string[] = [];
    await notifyAboutUpdate({
      currentVersion: "1.2.3",
      interactive: true,
      cachePath,
      timeoutSignal: (milliseconds) => {
        timeouts.push(milliseconds);
        return signal;
      },
      fetch: async (_input, init) => {
        expect(init?.signal).toBe(signal);
        return Response.json([release("v1.2.4")]);
      },
      writeError: (message) => errors.push(message),
    });
    expect(timeouts).toEqual([2_000]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Wayfinder 1.2.4 is available");
  });
});
