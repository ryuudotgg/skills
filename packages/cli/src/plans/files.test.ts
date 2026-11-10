import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { walkFiles } from "./files.ts";
import { importStore } from "./import.ts";
import { publishQuarantine } from "./outbox.ts";
import { openStore, type Store } from "./store.ts";

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
