import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLUMNS,
  ISSUE_CLOSED,
  ISSUE_FILED,
  ISSUE_LINK,
  issuePlan,
  issueRef,
  LOG_HEADER,
  secondStamp,
} from "skills-core";
import { walkFiles } from "./files.ts";
import { importStore } from "./import.ts";
import { publishQuarantine } from "./outbox.ts";
import { appendEvent, openStore, storedIssues, type Store } from "./store.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

async function plans(files: readonly string[]): Promise<{ root: string; store: Store }> {
  const root = mkdtempSync(join(tmpdir(), "plans-files-"));
  mkdirSync(join(root, "Skills", "deep"), { recursive: true });
  writeFileSync(join(root, "Skills", "index.tsv"), `${COLUMNS.join("\t")}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  for (const file of files) writeFileSync(join(root, file), `${file}\n`);

  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  cleanup.push(() => {
    try {
      store.db.close();
    } catch {}

    rmSync(root, { recursive: true, force: true });
  });

  return { root, store };
}

function recordedPaths(store: Store): string[] {
  const rows = store.db.query("SELECT path FROM files ORDER BY seq").all() as { path: string }[];
  return rows.map((row) => row.path);
}

const OPEN = { deadline: Number.POSITIVE_INFINITY, bytes: Number.POSITIVE_INFINITY };

test("a walk resumes after the last path an interrupted run reached", async () => {
  const { root, store } = await plans(["Skills/a.txt", "Skills/deep/b.txt", "Skills/deep.txt"]);
  store.db.run("INSERT INTO meta (key, value) VALUES ('file_walk', 'Skills/deep.txt')");

  walkFiles(store, root, OPEN);
  expect(recordedPaths(store)).toEqual(["Skills/deep/b.txt"]);

  walkFiles(store, root, OPEN);
  expect(recordedPaths(store)).toEqual(["Skills/deep/b.txt", "Skills/a.txt", "Skills/deep.txt"]);
  expect(store.db.query("SELECT 1 FROM meta WHERE key = 'file_walk'").get()).toBeNull();
});

test("a walk out of time keeps its place", async () => {
  const { root, store } = await plans(["Skills/a.txt"]);

  walkFiles(store, root, { deadline: 0, bytes: Number.POSITIVE_INFINITY });
  expect(recordedPaths(store)).toEqual([]);

  walkFiles(store, root, OPEN);
  expect(recordedPaths(store)).toEqual(["Skills/a.txt"]);
});

test("a project whose index.tsv is gone is still walked", async () => {
  const { root, store } = await plans(["Skills/a.txt"]);
  walkFiles(store, root, OPEN);

  rmSync(join(root, "Skills", "index.tsv"));
  writeFileSync(join(root, "Skills", "b.txt"), "b\n");
  mkdirSync(join(root, "Loose"));
  writeFileSync(join(root, "Loose", "c.txt"), "c\n");
  walkFiles(store, root, OPEN);

  expect(recordedPaths(store)).toEqual(["Skills/a.txt", "Skills/b.txt"]);
});

test("a walk that only passes directories still moves its place forward", async () => {
  const { root, store } = await plans(["Skills/z.txt"]);
  for (const name of ["d0", "d1", "d2"]) mkdirSync(join(root, "Skills", "deep", name));

  let calls = 0;
  const now = spyOn(Date, "now").mockImplementation(() => (calls++ < 4 ? 0 : 1e15));
  try {
    walkFiles(store, root, { deadline: 1, bytes: Number.POSITIVE_INFINITY });
  } finally {
    now.mockRestore();
  }

  const cursor = store.db.query("SELECT value FROM meta WHERE key = 'file_walk'").get() as {
    value: string;
  };

  expect(cursor.value).toMatch(/^Skills\/deep\/d[0-2]$/);
  expect(recordedPaths(store)).toEqual([]);

  walkFiles(store, root, OPEN);
  expect(recordedPaths(store)).toEqual(["Skills/z.txt"]);
});

test("republished quarantined revisions keep their parent chain", async () => {
  const { root, store } = await plans(["Skills/a.txt"]);
  walkFiles(store, root, OPEN);

  for (const text of ["one\n", "two\n"]) {
    writeFileSync(join(root, "Skills", "a.txt"), text);
    utimesSync(join(root, "Skills", "a.txt"), new Date(), new Date(Date.now() + 1000));
    walkFiles(store, root, OPEN);
  }

  const [first, ...later] = store.db.query("SELECT event FROM files ORDER BY seq").all() as {
    event: string;
  }[];

  const revoked = later.map((row) => row.event);
  const author = "a".repeat(32);
  for (const [index, id] of revoked.entries())
    store.db.run(
      "UPDATE events SET author = ?, sequence = ?, quarantined = 'revoked' WHERE id = ?",
      [author, index + 2, id],
    );

  store.db.run("INSERT INTO meta (key, value) VALUES ('hub_held', ?)", [
    JSON.stringify({ device: author, through: 0 }),
  ]);

  store.db.close();
  const reopened = openStore(join(root, "plans.db"));
  cleanup.unshift(() => reopened.db.close());
  await publishQuarantine(root, reopened, "b".repeat(32));

  const copies = reopened.db
    .query(
      `SELECT e.id, json_extract(e.payload, '$.parent') AS parent FROM files f
       JOIN events e ON e.id = f.event AND e.quarantined IS NULL ORDER BY f.seq`,
    )
    .all() as { id: string; parent: string | null }[];

  expect(copies.map((copy) => copy.parent)).toEqual([null, first!.event, copies[1]!.id]);
});

test("a held unsigned revision follows its republished parent", async () => {
  const { root, store } = await plans(["Skills/a.txt"]);
  walkFiles(store, root, OPEN);

  for (const text of ["one\n", "two\n"]) {
    writeFileSync(join(root, "Skills", "a.txt"), text);
    utimesSync(join(root, "Skills", "a.txt"), new Date(), new Date(Date.now() + 1000));
    walkFiles(store, root, OPEN);
  }

  const [, signed, unsigned] = store.db.query("SELECT event FROM files ORDER BY seq").all() as {
    event: string;
  }[];

  const author = "a".repeat(32);
  store.db.run("UPDATE events SET author = ?, sequence = 2, quarantined = 'revoked' WHERE id = ?", [
    author,
    signed!.event,
  ]);

  store.db.run("INSERT INTO meta (key, value) VALUES ('hub_held', ?)", [
    JSON.stringify({ device: author, through: 0 }),
  ]);

  store.db.close();
  const reopened = openStore(join(root, "plans.db"));
  cleanup.unshift(() => reopened.db.close());
  await publishQuarantine(root, reopened, "b".repeat(32));

  const copy = reopened.db
    .query(
      `SELECT e.id FROM files f JOIN events e ON e.id = f.event
       WHERE e.quarantined IS NULL AND e.id NOT IN (SELECT event FROM files LIMIT 1)
         AND e.id <> ? ORDER BY f.seq DESC LIMIT 1`,
    )
    .get(unsigned!.event) as { id: string };

  const parent = reopened.db
    .query("SELECT json_extract(payload, '$.parent') AS parent FROM events WHERE id = ?")
    .get(unsigned!.event) as { parent: string };

  expect(parent.parent).toBe(copy.id);
});

const FILED_AT = Date.UTC(2026, 10, 1);
function issueAt(seconds: number, n: number) {
  return {
    kind: "stored",
    at: FILED_AT + seconds * 1000,
    project: "Skills",
    plan: issuePlan(n),
  } as const;
}

function fileAt(store: Store, seconds: number, title: string): string {
  return appendEvent(store, {
    ...issueAt(seconds, 1),
    type: ISSUE_FILED,
    payload: { n: 1, title, body: null, from: null },
  });
}

async function rivals(): Promise<{ root: string; store: Store; second: string }> {
  const { root, store } = await plans([]);
  fileAt(store, 0, "first");
  return { root, store, second: fileAt(store, 1, "second") };
}

function moveOf(store: Store, filing: string): string {
  return appendEvent(store, {
    ...issueAt(9, 2),
    type: ISSUE_FILED,
    payload: { n: 2, title: "second", body: filing, from: null, moved: filing },
  });
}

async function republish(root: string, store: Store, revoked: readonly string[]): Promise<Store> {
  const author = "a".repeat(32);
  for (const [index, id] of revoked.entries())
    store.db.run(
      "UPDATE events SET author = ?, sequence = ?, quarantined = 'revoked' WHERE id = ?",
      [author, index + 2, id],
    );

  store.db.run("INSERT INTO meta (key, value) VALUES ('hub_held', ?)", [
    JSON.stringify({ device: author, through: 0 }),
  ]);

  store.db.close();
  const reopened = openStore(join(root, "plans.db"));
  cleanup.unshift(() => reopened.db.close());
  await publishQuarantine(root, reopened, "b".repeat(32));

  return reopened;
}

function filings(store: Store) {
  return storedIssues(store, "Skills").map((issue) => ({
    ref: issueRef(issue),
    title: issue.title,
    rivals: issue.rivals.length,
    filed: issue.filed,
    state: issue.state.kind,
    links: issue.links,
  }));
}

function visibleSeconds(store: Store) {
  return store.db
    .query(
      `SELECT id, json_extract(payload, '$.moved') AS moved, json_extract(payload, '$.body') AS body
       FROM events WHERE quarantined IS NULL AND type = ? AND json_extract(payload, '$.title') = ?
       ORDER BY wall, counter`,
    )
    .all(ISSUE_FILED, "second") as { id: string; moved: string | null; body: string | null }[];
}

const MOVED: ReturnType<typeof filings> = [
  {
    ref: "Skills#1",
    title: "first",
    rivals: 0,
    filed: secondStamp(FILED_AT),
    state: "open",
    links: [],
  },
  {
    ref: "Skills#2",
    title: "second",
    rivals: 0,
    filed: secondStamp(FILED_AT + 1000),
    state: "open",
    links: [],
  },
];

test("a republished move names the copy of the filing it moved", async () => {
  const { root, store, second } = await rivals();
  const move = moveOf(store, second);
  const reopened = await republish(root, store, [second, move]);

  expect(filings(reopened)).toEqual(MOVED);

  const [filed, moved] = visibleSeconds(reopened);
  expect([second, move]).not.toContain(filed!.id);
  expect(moved).toEqual({ id: expect.any(String), moved: filed!.id, body: second });
});

test("an unsigned move follows its republished filing", async () => {
  const { root, store, second } = await rivals();
  const move = moveOf(store, second);
  const reopened = await republish(root, store, [second]);

  expect(filings(reopened)).toEqual(MOVED);

  const [filed, moved] = visibleSeconds(reopened);
  expect(filed!.id).not.toBe(second);
  expect(moved).toEqual({ id: move, moved: filed!.id, body: second });
});

test("a republished link and close stay with the filing they name", async () => {
  const { root, store, second } = await rivals();
  const made = [
    appendEvent(store, {
      ...issueAt(2, 1),
      type: ISSUE_LINK,
      payload: { ref: "Skills/900", kind: "blocks", filing: second },
    }),
    appendEvent(store, {
      ...issueAt(3, 1),
      type: ISSUE_CLOSED,
      payload: { reason: "done", resolvedBy: [], filing: second },
    }),
  ];

  const move = moveOf(store, second);
  const reopened = await republish(root, store, [second, ...made, move]);
  const [first, moved] = MOVED;

  expect(filings(reopened)).toEqual([
    first!,
    { ...moved!, state: "closed", links: [{ ref: "Skills/900", kind: "blocks" }] },
  ]);
});

test("a rewrite with the same size and mtime right after a walk is still recorded", async () => {
  const { root, store } = await plans([]);
  const path = join(root, "Skills", "a.txt");
  const stamp = new Date();

  writeFileSync(path, "one\n");
  utimesSync(path, stamp, stamp);
  walkFiles(store, root, OPEN);

  writeFileSync(path, "two\n");
  utimesSync(path, stamp, stamp);
  walkFiles(store, root, OPEN);

  expect(recordedPaths(store)).toEqual(["Skills/a.txt", "Skills/a.txt"]);
});

test("a walk learns an unchanged file from its shape without opening it", async () => {
  const names = ["a", "b", "c", "d", "e"].map((name) => `Skills/${name}.txt`);
  const { root, store } = await plans(names);
  walkFiles(store, root, OPEN);
  store.db.run("UPDATE file_stats SET checked = mtime + 60000");

  const opens = spyOn(fs, "openSync");
  const queries = spyOn(store.db, "query");
  cleanup.push(
    () => opens.mockRestore(),
    () => queries.mockRestore(),
  );

  const opened = () => opens.mock.calls.map(([path]) => String(path).slice(root.length + 1));
  const shapeReads = () => queries.mock.calls.filter(([sql]) => /FROM file_stats/.test(sql)).length;
  const events = () =>
    (store.db.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;

  const before = events();

  opens.mockClear();
  queries.mockClear();
  walkFiles(store, root, OPEN);

  expect(opened()).toEqual([]);
  expect(shapeReads()).toBe(1);
  expect(events()).toBe(before);

  writeFileSync(join(root, "Skills", "c.txt"), "a longer c\n");
  opens.mockClear();
  walkFiles(store, root, OPEN);

  expect(opened()).toEqual(["Skills/c.txt"]);
  expect(recordedPaths(store)).toEqual([...names, "Skills/c.txt"]);
});

test("a walk stops at a file the byte allowance defers and starts there next time", async () => {
  const { root, store } = await plans(["Skills/a.txt", "Skills/b.txt", "Skills/c.txt"]);
  const small = { deadline: Number.POSITIVE_INFINITY, bytes: 1 };

  walkFiles(store, root, small);
  expect(recordedPaths(store)).toEqual(["Skills/a.txt"]);

  walkFiles(store, root, small);
  expect(recordedPaths(store)).toEqual(["Skills/a.txt", "Skills/b.txt"]);

  walkFiles(store, root, small);
  expect(recordedPaths(store)).toEqual(["Skills/a.txt", "Skills/b.txt", "Skills/c.txt"]);
});

test("a file that grows between its stat and its read is left for the next walk", async () => {
  const { root, store } = await plans(["Skills/a.txt"]);
  const real = fs.fstatSync;
  const stale = spyOn(fs, "fstatSync").mockImplementation(((fd: number) => {
    const stat = real(fd);
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { size: 2 });
  }) as typeof fs.fstatSync);

  try {
    walkFiles(store, root, OPEN);
  } finally {
    stale.mockRestore();
  }

  expect(recordedPaths(store)).toEqual([]);

  walkFiles(store, root, OPEN);
  expect(recordedPaths(store)).toEqual(["Skills/a.txt"]);
});
