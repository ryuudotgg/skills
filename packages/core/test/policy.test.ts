import { expect, test } from "bun:test";
import {
  digestsOf,
  sceneAt,
  screened,
  sessionList,
  WITHHELD_REF,
  type FeedEvent,
} from "skills-core";

let next = 0;
function event(project: string, plan: string, type: string, payload: unknown, wall = 0): FeedEvent {
  next++;
  const at = wall || next * 1000;
  return {
    id: `e${next}`,
    machine: "studio",
    wall: at,
    counter: 0,
    ts: new Date(at).toISOString(),
    project,
    plan,
    type,
    legacy: false,
    payload,
  };
}

function session(project: string, id: string, wall = 0): FeedEvent {
  const record = {
    host: "claude",
    session: id,
    branch: "feat/one",
    plans: ["001"],
    source: "scan",
    started: "2026-11-04T09:00:00Z",
  };

  return event(project, "001", "session", record, wall);
}

function policy(project: string, value: string, wall = 0): FeedEvent {
  return event(project, "-", "policy", { policy: value }, wall);
}

function row(project: string, id: string, status: string, blocked = "-"): FeedEvent {
  const fields = { slug: "sync", pri: "P1", effort: "S", ctx: "-", branch: "-", note: "-" };
  const updated = "2026-11-04";
  return event(project, id, "row", {
    row: { id, status, blocked_by: blocked, updated, ...fields },
  });
}

function transcript(digest: string, blob: string): FeedEvent {
  const record = { host: "claude", session: "s-1", digest, digestBlob: blob };
  return event("Alpha", "001", "transcript", record);
}

test("an off project drops its events and every session it shares with another project", () => {
  const { events, sessions } = screened([
    session("Alpha", "s-1"),
    event("Beta", "001", "session-stats", {
      host: "claude",
      session: "s-1",
      models: {},
      tools: {},
    }),
    session("Beta", "s-2"),
    policy("Alpha", "off"),
  ]);

  expect(JSON.stringify(events)).not.toContain("Alpha");
  expect(JSON.stringify(events)).not.toContain('"s-1"');
  expect([...sessions]).toEqual([["claude\ts-2", "redacted"]]);
});

test("a blocker in an off project is dropped once released and withheld while open", () => {
  const { events } = screened([
    row("Alpha", "003", "DONE"),
    row("Alpha", "004", "DOING"),
    event("Alpha", "#2", "issue-closed", { reason: "fixed", resolvedBy: [] }),
    row("Beta", "001", "TODO", "Alpha/003,Alpha#2,002"),
    row("Beta", "002", "TODO", "Alpha/004,Alpha/003"),
    event("Beta", "#1", "issue", { n: 1, title: "needs sync", body: null, from: "Alpha/003" }),
    event("Beta", "#1", "issue-link", { ref: "Alpha/003", kind: "blocks" }),
    policy("Alpha", "off"),
  ]);

  expect(events.map((each) => each.type)).toEqual(["row", "row", "issue"]);
  expect(events[0]?.payload).toMatchObject({ row: { blocked_by: "002" } });
  expect(events[1]?.payload).toMatchObject({ row: { blocked_by: WITHHELD_REF } });
  expect(events[2]?.payload).toMatchObject({ from: null });
});

test("a digest keeps its week and every other line when it names an off project", () => {
  const markdown = [
    "## Closes",
    "",
    "- Alpha 001 shell",
    "- Beta 001 sync",
    "",
    "## Token spend",
    "",
    "- opus 1000 tokens",
    "",
  ].join("\n");

  const scene = sceneAt(
    [
      row("Alpha", "001", "DONE"),
      row("Beta", "001", "DONE"),
      event("-", "-", "digest", { week: "2026-W45", markdown }, Date.parse("2026-11-10T00:00:00Z")),
      policy("Alpha", "off", Date.parse("2026-11-10T01:00:00Z")),
    ],
    undefined,
    Date.parse("2026-11-11T00:00:00Z"),
  );

  const [digest] = digestsOf(scene.events);
  expect(digest?.week).toBe("2026-W45");
  expect(digest?.markdown).toContain("- Beta 001 sync");
  expect(digest?.markdown).toContain("- opus 1000 tokens");
  expect(digest?.markdown).not.toContain("Alpha");
});

test("the newest policy governs a cut taken before it, so time travel cannot uncover it", () => {
  const feed = [session("Alpha", "s-1", 1_000), policy("Alpha", "off", 50_000)];
  expect(sceneAt(feed, 10_000, 99_000).events).toEqual([]);

  const stats = [session("Alpha", "s-1", 1_000), policy("Alpha", "stats", 50_000)];
  const scene = sceneAt(stats, 10_000, 99_000);
  expect(sessionList(scene.events, scene.sessions).map((each) => each.policy)).toEqual(["stats"]);
});

test("a session joining a stricter project later is held to it at an earlier cut", () => {
  const stats = { host: "claude", session: "s-1", models: {}, tools: {} };
  const joined = event("Beta", "001", "session-stats", stats, 60_000);
  const feed = [session("Alpha", "s-1", 1_000), policy("Beta", "stats", 2_000), joined];

  const scene = sceneAt(feed, 10_000, 99_000);
  expect(sessionList(scene.events, scene.sessions).map((each) => each.policy)).toEqual(["stats"]);
});

test("a deleted digest blob leaves the session with no digest, not an older one", () => {
  const [older, newer] = ["a".repeat(64), "b".repeat(64)];
  const feed = [session("Alpha", "s-1"), transcript(older, "c".repeat(32))];
  const kept = sceneAt([...feed, transcript(newer, "d".repeat(32))], undefined, 0);
  expect(sessionList(kept.events, kept.sessions)[0]?.digest).toBe(newer);

  const tombstone = event("Alpha", "-", "blob-deleted", { blob: "d".repeat(32) });
  const deleted = sceneAt([...feed, transcript(newer, "d".repeat(32)), tombstone], undefined, 0);
  expect(sessionList(deleted.events, deleted.sessions)[0]?.digest).toBeNull();
});

test("a blocker an off project releases after the cut still holds the row at the cut", () => {
  const blocked = row("Beta", "001", "TODO", "Alpha/003");
  const feed = [
    row("Alpha", "003", "DOING"),
    blocked,
    row("Alpha", "003", "DONE"),
    policy("Alpha", "off"),
  ];

  const before = screened(feed, blocked.wall).events;
  expect(before.map((each) => each.payload)).toMatchObject([{ row: { blocked_by: WITHHELD_REF } }]);

  const after = screened(feed).events;
  expect(after.map((each) => each.payload)).toMatchObject([{ row: { blocked_by: "-" } }]);
});

test("a session with stats but no session event still lists, on no branch", () => {
  const stats = {
    host: "codex",
    session: "s-3",
    models: {},
    tools: { Bash: 2 },
    start: "2026-11-04T09:00:00Z",
    end: null,
  };

  const scene = sceneAt([event("Beta", "-", "session-stats", stats)], undefined, 0);

  expect(sessionList(scene.events, scene.sessions)).toMatchObject([
    {
      host: "codex",
      session: "s-3",
      project: "Beta",
      branch: "-",
      tools: 2,
      start: "2026-11-04T09:00:00Z",
    },
  ]);
});
