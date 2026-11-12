import { expect, test } from "bun:test";
import { feedLines, type FeedEvent, type SyncState } from "skills-core";
import { startFeed, startSync, type FeedSnapshot } from "../src/client.ts";

function event(id: string, wall: number): FeedEvent {
  return {
    id,
    machine: "studio",
    wall,
    counter: 0,
    ts: new Date(wall).toISOString(),
    project: "Alpha",
    plan: "001",
    type: "start",
    legacy: false,
    payload: { detail: "check", line: "" },
  };
}

type Answer = { status: number; body: string };

function feedOf(answers: Answer[]) {
  const asked: { path: string; authorization: string | null }[] = [];
  const snapshots: FeedSnapshot[] = [];
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const stop = startFeed({
    token: "secret",
    every: 0,
    clock: () => 7,
    onChange: (snapshot) => snapshots.push(snapshot),
    fetch: async (path, init) => {
      asked.push({ path, authorization: new Headers(init.headers).get("Authorization") });

      const answer = answers.shift();
      if (!answer) {
        settle();
        return new Promise<Response>(() => {});
      }

      return new Response(answer.body, { status: answer.status });
    },
  });

  return { asked, snapshots, done, stop };
}

test("the client sends the token, advances the cursor and keeps it across an empty batch", async () => {
  const feed = feedOf([
    { status: 200, body: feedLines([event("a", 1), event("b", 2)]) },
    { status: 200, body: "" },
    { status: 200, body: feedLines([event("c", 3)]) },
  ]);

  await feed.done;
  feed.stop();

  expect(feed.asked.map((each) => each.path)).toEqual([
    "/feed",
    "/feed?after=b",
    "/feed?after=b",
    "/feed?after=c",
  ]);

  expect(feed.asked.every((each) => each.authorization === "Bearer secret")).toBe(true);
  expect(feed.snapshots.at(-1)?.events.map((each) => each.id)).toEqual(["a", "b", "c"]);
});

test("a 410 drops what the tab holds and reads the feed from the start", async () => {
  const feed = feedOf([
    { status: 200, body: feedLines([event("a", 1)]) },
    { status: 410, body: "unknown cursor" },
    { status: 200, body: feedLines([event("z", 9)]) },
  ]);

  await feed.done;
  feed.stop();

  expect(feed.asked.map((each) => each.path).slice(0, 3)).toEqual([
    "/feed",
    "/feed?after=a",
    "/feed",
  ]);

  expect(feed.snapshots.at(-1)?.events.map((each) => each.id)).toEqual(["z"]);
});

test("a 401 stops polling and says so", async () => {
  const feed = feedOf([{ status: 401, body: "missing or wrong token" }]);
  await Bun.sleep(20);

  expect(feed.asked).toHaveLength(1);
  expect(feed.snapshots.at(-1)?.status).toEqual({ kind: "unauthorized" });
});

test("a server error shows the reason the server gave and polling goes on", async () => {
  const feed = feedOf([
    { status: 503, body: "plans.db schema 1, this release reads 2\n" },
    { status: 200, body: feedLines([event("a", 1)]) },
  ]);

  await feed.done;
  feed.stop();

  expect(feed.snapshots[0]?.status).toEqual({
    kind: "unreachable",
    reason: "plans.db schema 1, this release reads 2",
  });

  expect(feed.snapshots.at(-1)?.status).toEqual({ kind: "live" });
});

test("the sync poller sends the token, reports each new state once and keeps the last through a 503", async () => {
  const synced: SyncState = {
    state: "synced",
    lastSync: "2026-11-06T12:00:00.000Z",
    queue: 0,
    conflicts: 0,
  };

  const offline: SyncState = { state: "offline", reason: "the hub does not answer" };
  const answers: Answer[] = [
    { status: 503, body: "the first hub sync is still running" },
    { status: 200, body: JSON.stringify(synced) },
    { status: 200, body: JSON.stringify(synced) },
    { status: 200, body: "not json" },
    { status: 200, body: JSON.stringify(offline) },
  ];

  const asked: { path: string; authorization: string | null }[] = [];
  const states: SyncState[] = [];
  let settle = () => {};
  const done = new Promise<void>((resolve) => {
    settle = resolve;
  });

  const stop = startSync({
    token: "secret",
    every: 0,
    onChange: (state) => states.push(state),
    fetch: async (path, init) => {
      asked.push({ path, authorization: new Headers(init.headers).get("Authorization") });

      const answer = answers.shift();
      if (!answer) settle();
      return new Response((answer ?? { body: JSON.stringify(offline) }).body, {
        status: answer?.status ?? 200,
      });
    },
  });

  await done;
  stop();

  expect(asked[0]).toEqual({ path: "/sync", authorization: "Bearer secret" });
  expect(states).toEqual([synced, offline]);
});
