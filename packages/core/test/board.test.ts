import { expect, test } from "bun:test";
import {
  boardRows,
  eventFrom,
  recordOf,
  trailEntry,
  type EventDraft,
  type IndexRow,
  type PlanEvent,
} from "skills-core";

const HOUR = 3_600_000;

const NOW = Date.parse("2026-11-10T12:00:00Z");

const SINCE = "2026-11-10T08:00:00.000Z";

const doing: IndexRow = {
  id: "001",
  slug: "sync",
  status: "DOING",
  pri: "P1",
  effort: "S",
  blocked_by: "-",
  ctx: "-",
  branch: "feat/sync",
  updated: "2026-11-10",
  note: "-",
};

function event(draft: EventDraft, machine = "m-laptop"): PlanEvent {
  const at = draft.kind === "trail" ? Date.parse(draft.entry.ts) : draft.at;
  return eventFrom({ ...recordOf(draft), id: `${machine}-${at}`, wall: at, counter: 0, machine });
}

function start(at: number): PlanEvent {
  const ts = new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
  const entry = trailEntry({ ts, project: "P", id: "001", event: "start", detail: "feat/sync" });
  return event({ kind: "trail", at, entry });
}

function stored(type: string, at: number, payload: unknown, machine?: string): PlanEvent {
  return event(
    { kind: "stored", type, at, project: "P", plan: "001", payload } as EventDraft,
    machine,
  );
}

function lease(device: string, label: string, provisional: boolean): PlanEvent {
  const payload = { device, label, acquired: SINCE, expires: "2026-11-11T08:00:00.000Z" };
  return stored("lease", NOW - 4 * HOUR, {
    ...payload,
    pinned: false,
    provisional,
    operation: null,
  });
}

const row = event({ kind: "row", type: "row", at: NOW - 6 * HOUR, project: "P", row: doing });

const label = (machine: string, name: string) =>
  stored("machine", NOW - 7 * HOUR, { label: name }, machine);

test("a new start clears the heartbeat of an earlier stint, a later one counts", () => {
  const stint = [
    row,
    stored("heartbeat", NOW - 5 * HOUR, { branch: "feat/sync" }),
    start(NOW - HOUR),
  ];

  expect(boardRows(stint, NOW)[0]?.heartbeat).toBeUndefined();

  const beat = stored("heartbeat", NOW - 10 * 60_000, { branch: "feat/sync" });
  expect(boardRows([...stint, beat], NOW)[0]?.heartbeat).toEqual({ minutes: 10, stale: false });
});

test("a new start drops the thread bound before it, a later binding shows", () => {
  const thread = (at: number, id: string) => {
    const ts = new Date(at).toISOString().replace(/\.\d+Z$/, "Z");
    return event({
      kind: "trail",
      at,
      entry: trailEntry({ ts, project: "P", id: "001", event: "thread", detail: id }),
    });
  };

  const restarted = [
    row,
    start(NOW - 3 * HOUR),
    thread(NOW - 2 * HOUR, "t-old"),
    start(NOW - HOUR),
  ];

  expect(boardRows(restarted, NOW)[0]?.thread).toBeUndefined();
  expect(boardRows([...restarted, thread(NOW - 30 * 60_000, "t-new")], NOW)[0]?.thread).toBe(
    "t-new",
  );
});

test("heartbeat age reads the event's own time, not a wall a pulled clock moved forward", () => {
  const beat = stored("heartbeat", NOW - 45 * 60_000, { branch: "feat/sync" });
  const pushed = { ...beat, wall: NOW - 60_000 };
  expect(boardRows([row, start(NOW - HOUR), pushed], NOW)[0]?.heartbeat).toEqual({
    minutes: 45,
    stale: true,
  });
});

test("a PR on another branch than the row's stays off the board", () => {
  const pr = (branch: string, at: number) =>
    stored("pr", at, { pr: 9, branch, state: "merged", head: "abc", verdict: null, failing: [] });

  expect(boardRows([row, pr("feat/old", NOW - HOUR)], NOW)[0]?.pr).toBeUndefined();
  expect(
    boardRows([row, pr("feat/sync", NOW - 2 * HOUR), pr("feat/old", NOW - HOUR)], NOW)[0]?.pr?.pr,
  ).toBe(9);
});

test("a refused claim names its own machine and the holder, even beside the holder's lease", () => {
  const [board] = boardRows(
    [
      row,
      start(NOW - 5 * HOUR),
      lease("d-studio", "studio", false),
      lease("d-laptop", "laptop", true),
      stored("lease-conflict", NOW - 3 * HOUR, {
        device: "d-laptop",
        acquired: SINCE,
        holder: "d-studio",
        holderAcquired: SINCE,
        holderLabel: "studio",
      }),
    ],
    NOW,
  );

  expect([board?.machine, board?.conflict]).toEqual(["laptop", "studio"]);
});

test("without a conflict the confirmed holder names the machine, else a provisional one", () => {
  const starter = [label("m-laptop", "laptop"), row, start(NOW - 5 * HOUR)];
  const machineWith = (...leases: PlanEvent[]) =>
    boardRows([...starter, ...leases], NOW)[0]?.machine;

  expect(machineWith()).toBe("laptop");
  expect(machineWith(lease("d-x", "hub-name", true))).toBe("hub-name");
  expect(machineWith(lease("d-x", "hub-name", true), lease("d-studio", "studio", false))).toBe(
    "studio",
  );
});

test("a start from a machine with no machine event leaves the machine unknown", () => {
  expect(boardRows([row, start(NOW - HOUR)], NOW)[0]?.machine).toBeUndefined();
});
