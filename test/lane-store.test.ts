import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneAuthority, LaneEvent, LaneEventKind } from "../src/lane.ts";
import { LaneStore } from "../src/lane-store.ts";
import { laneStorePath } from "../src/paths.ts";

const LANE = "wf-lane:JWB-326";
const TICKET = "JWB-326";

const orchestrator: LaneAuthority = { principal: "alice", role: "orchestrator" };
const worker: LaneAuthority = { principal: "w-quinn", role: "worker", laneScope: LANE };
const supervisor: LaneAuthority = { principal: "sup-a", role: "supervisor" };

let clock = 0;
function at(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, clock)).toISOString();
}

function ev(
  kind: LaneEventKind,
  authority: LaneAuthority,
  overrides: Partial<LaneEvent> = {},
): LaneEvent {
  return {
    kind,
    lane: LANE,
    at: at(),
    actor: authority.principal,
    role: authority.role,
    ...overrides,
  };
}

function withStore(run: (store: LaneStore, path: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-lane-"));
  const path = join(directory, "lanes.db");
  const store = new LaneStore(path);
  try {
    run(store, path);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("append authorizes, projects, and persists typed events with seq = version", () => {
  withStore((store) => {
    const created = store.append(
      ev("lane.created", orchestrator, { ticket: TICKET }),
      orchestrator,
    );
    expect(created).toMatchObject({ ok: true, seq: 1 });
    if (!created.ok) return;
    expect(created.record.state).toBe("queued");

    store.append(ev("lane.preparing", orchestrator), orchestrator);
    const running = store.append(ev("lane.running", worker), worker);
    expect(running).toMatchObject({ ok: true, seq: 3 });
    if (!running.ok) return;
    expect(running.record.state).toBe("running");
    expect(running.seq).toBe(running.record.version);
  });
});

test("append rejects unauthorized events before any write", () => {
  withStore((store) => {
    store.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    store.append(ev("lane.preparing", orchestrator), orchestrator);
    store.append(ev("lane.running", worker), worker);

    // Worker cannot mutate a different lane.
    const crossLane = store.append(ev("lane.running", worker, { lane: "wf-lane:other" }), worker);
    expect(crossLane).toMatchObject({ ok: false, code: "unauthorized_scope" });

    // Worker cannot emit an orchestrator-only verb.
    const escalate = store.append(ev("lane.approved", worker), worker);
    expect(escalate).toMatchObject({ ok: false, code: "unauthorized_capability" });

    // The rejected events left no trace in the durable log.
    expect(store.events(LANE)).toHaveLength(3);
  });
});

test("append rejects illegal transitions and writes nothing", () => {
  withStore((store) => {
    store.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    store.append(ev("lane.preparing", orchestrator), orchestrator);
    store.append(ev("lane.running", worker), worker);
    store.append(ev("lane.ready_for_validation", worker), worker);

    const before = store.events(LANE).length;
    const illegal = store.append(ev("lane.blocked", worker), worker);
    expect(illegal).toMatchObject({ ok: false, code: "illegal_transition" });
    expect(store.events(LANE)).toHaveLength(before);
  });
});

test("a fresh store instance re-derives identical lane state from the durable log", () => {
  const directory = mkdtempSync(join(tmpdir(), "wayfinder-lane-"));
  const path = join(directory, "lanes.db");
  try {
    const first = new LaneStore(path);
    first.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    first.append(ev("lane.preparing", orchestrator), orchestrator);
    first.append(ev("lane.running", worker), worker);
    first.append(
      ev("lane.service_announced", worker, { service: { name: "web", port: 3000 } }),
      worker,
    );
    const before = first.project(LANE);
    first.close();

    // A brand-new instance re-attaches to the same file with no in-memory handoff.
    const second = new LaneStore(path);
    try {
      const after = second.project(LANE);
      expect(after).toEqual(before);
      expect(after?.state).toBe("running");
      expect(after?.services).toHaveLength(1);
    } finally {
      second.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("status exposes stable machine-readable projection, history, and count", () => {
  withStore((store) => {
    store.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    store.append(ev("lane.preparing", orchestrator), orchestrator);
    store.append(ev("lane.running", worker), worker);

    const status = store.status(LANE);
    expect(status).toBeDefined();
    if (!status) return;
    expect(status.eventCount).toBe(3);
    expect(status.record.state).toBe("running");
    expect(status.history).toEqual([
      {
        seq: 1,
        kind: "lane.created",
        actor: "alice",
        role: "orchestrator",
        at: expect.any(String),
      },
      {
        seq: 2,
        kind: "lane.preparing",
        actor: "alice",
        role: "orchestrator",
        at: expect.any(String),
      },
      { seq: 3, kind: "lane.running", actor: "w-quinn", role: "worker", at: expect.any(String) },
    ]);
    expect(store.status("wf-lane:missing")).toBeUndefined();
  });
});

test("lanes lists every known lane's projection", () => {
  withStore((store) => {
    store.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    store.append(
      ev("lane.created", orchestrator, { lane: "wf-lane:JWB-999", ticket: "JWB-999" }),
      orchestrator,
    );
    const lanes = store.lanes();
    expect(lanes.map((l) => l.lane)).toEqual(["wf-lane:JWB-326", "wf-lane:JWB-999"]);
  });
});

test("global policy is orchestrator-only and reads back durably", () => {
  withStore((store) => {
    const denied = store.setPolicy("merge_gate", "blocked", worker, at());
    expect(denied).toMatchObject({ ok: false, code: "unauthorized_capability" });
    expect(store.setPolicy("merge_gate", "blocked", supervisor, at())).toMatchObject({
      ok: false,
      code: "unauthorized_capability",
    });

    const ok = store.setPolicy("merge_gate", "blocked", orchestrator, at());
    expect(ok).toEqual({ ok: true });
    expect(store.policy("merge_gate")).toBe("blocked");

    // Upsert overwrites in place.
    store.setPolicy("merge_gate", "open", orchestrator, at());
    expect(store.policy("merge_gate")).toBe("open");
    expect(store.policies()).toEqual([
      { key: "merge_gate", value: "open", updatedBy: "alice", updatedAt: expect.any(String) },
    ]);
    expect(store.policy("missing")).toBeUndefined();
  });
});

test("the durable log enforces optimistic concurrency via UNIQUE(lane, seq)", () => {
  withStore((store, path) => {
    store.append(ev("lane.created", orchestrator, { ticket: TICKET }), orchestrator);
    const current = store.project(LANE);
    expect(current?.version).toBe(1);

    // A competing writer that computed the same next seq (2) must be rejected by
    // the constraint rather than silently interleaving. Insert seq 2 twice.
    const raw = new Database(path, { strict: true });
    try {
      const insert = (seq: number) =>
        raw
          .query(
            `INSERT INTO lane_events (lane, seq, kind, actor, role, at, payload_json)
             VALUES ($lane, $seq, 'lane.preparing', 'alice', 'orchestrator', $at, '{}')`,
          )
          .run({ lane: LANE, seq, at: at() });
      insert(2);
      expect(() => insert(2)).toThrow(/UNIQUE/i);
    } finally {
      raw.close();
    }
  });
});

test("laneStorePath resolves under the platform data directory", () => {
  const linux = laneStorePath({ XDG_STATE_HOME: "/xdg", HOME: "/home/u" } as NodeJS.ProcessEnv);
  if (process.platform === "linux") {
    expect(linux).toBe("/xdg/wayfinder/lanes.db");
  }
  // Always ends in the canonical file name on every platform.
  expect(laneStorePath().endsWith("lanes.db")).toBe(true);
});

test("append requires a non-empty store path", () => {
  expect(() => new LaneStore("")).toThrow(/path is required/);
});
