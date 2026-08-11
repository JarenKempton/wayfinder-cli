import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaimCollisionError } from "../src/contracts.ts";
import type { ActorRef, MapRef, TicketRef } from "../src/domain.ts";
import {
  formatMarkdownTracker,
  MarkdownTrackerAdapter,
  type MarkdownTrackerDocument,
} from "../src/markdown-tracker.ts";

const map = "markdown:local:fixtures:map:map-1" as MapRef;
const blocker = "markdown:local:fixtures:ticket:a" as TicketRef;
const ticket = "markdown:local:fixtures:ticket:b" as TicketRef;
const owner = "jaren" as ActorRef;
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "wayfinder-markdown-"));
  directories.push(directory);
  const path = join(directory, "tracker.md");
  const document: MarkdownTrackerDocument = {
    format: "wayfinder-markdown-tracker",
    version: 1,
    maps: [{ ref: map, title: "Reference map", order: 0, context: [] }],
    tickets: [
      {
        ref: blocker,
        map,
        title: "First",
        kind: "research",
        state: "open",
        status: "To Do",
        order: 0,
        comments: [],
        artifacts: [],
      },
      {
        ref: ticket,
        map,
        title: "Second",
        kind: "task",
        state: "open",
        status: "To Do",
        order: 1,
        dependencies: [{ blocking: blocker, blocked: ticket, kind: "blocks" }],
        comments: [],
        artifacts: [],
      },
    ],
  };
  await writeFile(path, formatMarkdownTracker(document));
  return new MarkdownTrackerAdapter(path);
}
const claimRequest = (expectedVersion: string, target = blocker) => ({
  claim: "wayfinder-claim:first" as const,
  run: "wayfinder-run:first" as const,
  ticket: target,
  owner,
  leaseExpiresAt: "2099-01-01T00:15:00.000Z",
  expectedVersion,
});
describe("MarkdownTrackerAdapter", () => {
  test("advertises capabilities and derives dependency frontier", async () => {
    const adapter = await fixture();
    expect(await adapter.describe()).toMatchObject({
      native_maps: true,
      conditional_update: true,
      resolution_comments: true,
    });
    expect((await adapter.frontier({ map })).map((item) => item.ref)).toEqual([blocker]);
  });
  test("claims, renews without a comment, and rejects stale versions", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    const request = claimRequest(before.version);
    await adapter.claim(request);
    await adapter.verifyClaim(request);
    expect((await adapter.read()).tickets[0]?.comments).toHaveLength(1);
    const snapshot = await adapter.snapshotClaimState(blocker);
    const renewal = {
      claim: request.claim,
      ticket: blocker,
      expectedVersion: snapshot.version,
      leaseExpiresAt: "2099-01-01T00:20:00.000Z",
    };
    await adapter.renewLease(renewal);
    await adapter.verifyLease(renewal);
    expect((await adapter.read()).tickets[0]?.comments).toHaveLength(1);
    await expect(adapter.claim(claimRequest(before.version, ticket))).rejects.toBeInstanceOf(
      ClaimCollisionError,
    );
  });
  test("restores exact claim fields while preserving audit history", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    const request = claimRequest(before.version);
    await adapter.claim(request);
    const restore = { ticket: blocker, claim: request.claim, originalSnapshot: before };
    await adapter.restoreClaimState(restore);
    await adapter.verifyRestored(restore);
    const restored = (await adapter.read()).tickets[0];
    expect(restored?.assignee).toBeUndefined();
    expect(restored?.claim).toBeUndefined();
    expect(restored?.comments).toHaveLength(2);
  });
  test("release and stale reclaim obey matching ownership", async () => {
    const adapter = await fixture();
    const before = await adapter.snapshotClaimState(blocker);
    const first = { ...claimRequest(before.version), leaseExpiresAt: "2000-01-01T00:00:00.000Z" };
    await adapter.claim(first);
    const claimed = await adapter.snapshotClaimState(blocker);
    const reclaim = {
      staleClaim: first.claim,
      claim: "wayfinder-claim:second" as const,
      run: "wayfinder-run:second" as const,
      ticket: blocker,
      owner,
      authorizedBy: owner,
      leaseExpiresAt: "2099-01-01T00:30:00.000Z",
      expectedVersion: claimed.version,
      originalSnapshot: before,
    };
    await adapter.reclaim(reclaim);
    await adapter.verifyReclaimed(reclaim);
    expect((await adapter.read()).tickets[0]?.comments.at(-1)).toContain("Reclaimed");
    const current = await adapter.snapshotClaimState(blocker);
    await adapter.releaseClaim({
      claim: reclaim.claim,
      ticket: blocker,
      originalSnapshot: before,
      expectedVersion: current.version,
      authorizedBy: owner,
    });
    await expect(
      adapter.restoreClaimState({
        ticket: blocker,
        claim: reclaim.claim,
        originalSnapshot: before,
      }),
    ).rejects.toBeInstanceOf(ClaimCollisionError);
  });
  test("resolution closes, unblocks, and permits exactly one map pointer", async () => {
    const adapter = await fixture();
    await expect(adapter.resolve(blocker, "")).rejects.toThrow("resolution comment");
    await adapter.resolve(blocker, "Evidence passed.", ["https://example.test/pr/1"]);
    expect((await adapter.frontier({ map })).map((item) => item.ref)).toEqual([ticket]);
    await adapter.appendMapContext(map, blocker, "Verified.");
    await expect(adapter.appendMapContext(map, blocker, "duplicate")).rejects.toBeInstanceOf(
      ClaimCollisionError,
    );
    const document = await adapter.read();
    expect(document.tickets[0]).toMatchObject({
      state: "closed",
      artifacts: ["https://example.test/pr/1"],
    });
    expect(document.maps[0]?.context).toHaveLength(1);
    expect(await readFile(adapter.path, "utf8")).toContain("### Decisions so far");
  });
  test("lock collision is explicit and leaves state untouched", async () => {
    const adapter = await fixture();
    await writeFile(`${adapter.path}.lock`, "busy");
    await expect(adapter.comment(blocker, "no write")).rejects.toBeInstanceOf(ClaimCollisionError);
    expect((await adapter.read()).tickets[0]?.comments).toEqual([]);
  });
});
