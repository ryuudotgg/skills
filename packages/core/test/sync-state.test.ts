import { expect, test } from "bun:test";
import { parseSync, syncText, type SyncState } from "skills-core";

const now = Date.parse("2026-11-06T12:00:00Z");

test("each sync state round trips through JSON and parseSync", () => {
  const states: SyncState[] = [
    { state: "local only" },
    { state: "offline", reason: "the hub at http://127.0.0.1:9 does not answer" },
    { state: "synced", lastSync: "2026-11-06T11:59:56.000Z", queue: 0, conflicts: 0 },
    {
      state: "synced",
      lastSync: "2026-11-06T11:00:00.000Z",
      queue: 3,
      conflicts: 1,
      reconciled: "2026-11-05T09:00:00.000Z",
    },
  ];

  for (const state of states) expect(parseSync(JSON.stringify(state))).toEqual(state);
});

test("parseSync refuses anything but the three states", () => {
  const bad = [
    "null",
    "[]",
    '{"state":"syncing"}',
    '{"state":"offline"}',
    '{"state":"synced","lastSync":"never","queue":0,"conflicts":0}',
    '{"state":"synced","lastSync":"2026-11-06T11:00:00Z","queue":-1,"conflicts":0}',
    '{"state":"synced","lastSync":"2026-11-06T11:00:00Z","queue":0,"conflicts":0,"reconciled":5}',
  ];

  for (const text of bad) expect(() => parseSync(text)).toThrow("not a sync state");
});

test("syncText reads the sync state the way the shell shows it", () => {
  expect(syncText({ state: "local only" }, now)).toBe("local only");
  expect(syncText({ state: "offline", reason: "connection refused" }, now)).toBe(
    "offline: connection refused",
  );

  expect(
    syncText({ state: "synced", lastSync: "2026-11-06T11:59:56Z", queue: 0, conflicts: 0 }, now),
  ).toBe("synced 4 s ago, queue 0, conflicts 0");

  expect(
    syncText(
      {
        state: "synced",
        lastSync: "2026-11-06T10:00:00Z",
        queue: 2,
        conflicts: 1,
        reconciled: "2026-11-05T09:00:00.000Z",
      },
      now,
    ),
  ).toBe("synced 2 h ago, queue 2, conflicts 1, reconciled 2026-11-05T09:00:00.000Z");
});

test("a last sync stamped a moment after the browser's clock reads as 0 s ago", () => {
  expect(
    syncText({ state: "synced", lastSync: "2026-11-06T12:00:01Z", queue: 0, conflicts: 0 }, now),
  ).toBe("synced 0 s ago, queue 0, conflicts 0");
});
