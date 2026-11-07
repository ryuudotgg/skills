import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import type { Io } from "../io.ts";
import { importStore, importVerb } from "./import.ts";
import { openStore, storePath } from "./store.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function row(id: string, slug: string, note = "-"): string {
  return [id, slug, "TODO", "P1", "S", "-", "-", "-", "2026-10-31", note].join("\t");
}

function trail(...lines: string[]): string {
  return LOG_HEADER + lines.map((line) => `${line}\n`).join("");
}

function plans(): { root: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(join(tmpdir(), "skills-import-"));
  temporary.push(root);

  mkdirSync(join(root, "Skills", "done"), { recursive: true });
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    [COLUMNS.join("\t"), row("001", "first"), row("002", "second"), ""].join("\n"),
  );

  writeFileSync(join(root, "Skills", "002-second.md"), "# 002 second\n");
  writeFileSync(join(root, "Skills", "ctx-batch.md"), "# ctx-batch\n");
  writeFileSync(join(root, "Skills", "done", "001-first.md"), "# 001 first\n");
  writeFileSync(join(root, "Skills", "notes.md"), "not a plan\n");
  writeFileSync(
    join(root, "log.tsv"),
    trail(
      "2026-10-31T10:00:00Z\tSkills\t001\tstart\tfeat/first",
      "2026-10-31T09:00:00Z\tSkills\t001\thandover\tlegacy name",
    ),
  );

  return { root, env: { PLANS_DIR: root } };
}

function capture(env: NodeJS.ProcessEnv): Io & { stdout: string; stderr: string } {
  const io = {
    cwd: "/",
    env,
    capture: true,
    stdout: "",
    stderr: "",
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };

  return io;
}

function storeFiles(root: string): string[] {
  return readdirSync(root).filter((name) => name.startsWith("plans.db"));
}

test("a first import counts every row, trail line and working copy, and a rerun counts none", async () => {
  const { root, env } = plans();
  const io = capture(env);

  expect(await importVerb([], "skills plans import", io)).toBe(0);
  expect(io.stdout).toBe("imported 2 rows, 2 events, 3 files\n");
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(storeFiles(root)).toContain("plans.db");
});

test("a rerun imports new trail lines, changed rows and changed working copies", async () => {
  const { root, env } = plans();
  await importStore(env);

  appendFileSync(join(root, "log.tsv"), "2026-10-31T11:00:00Z\tSkills\t002\tthread\tcheck\n");
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    [COLUMNS.join("\t"), row("001", "first"), row("002", "second", "edited"), ""].join("\n"),
  );

  writeFileSync(join(root, "Skills", "002-second.md"), "# 002 second, revised\n");

  expect(await importStore(env)).toEqual({ rows: 1, events: 1, files: 1 });
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
});

test("rows sharing an id under different slugs import as separate rows", async () => {
  const { root, env } = plans();
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    [COLUMNS.join("\t"), row("021", "design"), row("021", "spike"), ""].join("\n"),
  );

  expect((await importStore(env)).rows).toBe(2);
  expect((await importStore(env)).rows).toBe(0);
});

test("an edit to an imported trail line refuses naming the line and changes nothing", async () => {
  const { root, env } = plans();
  await importStore(env);

  const log = join(root, "log.tsv");
  const original = readFileSync(log, "utf8");
  writeFileSync(log, original.replace("legacy name", "rewritten"));

  const io = capture(env);
  expect(await importVerb([], "skills plans import", io)).toBe(1);
  expect(io.stderr).toBe(
    `import refused: ${log}:3: changed after import; save the edit, move the file aside and run skills plans import again, which writes the store's copy back\n`,
  );

  writeFileSync(log, original);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
});

test("a line that does not round trip refuses a first import and leaves no store", async () => {
  const { root, env } = plans();
  const index = join(root, "Skills", "index.tsv");
  writeFileSync(
    index,
    [COLUMNS.join("\t"), row("001", "first"), `${row("002", "second")}\r`, ""].join("\n"),
  );

  const io = capture(env);
  expect(await importVerb([], "skills plans import", io)).toBe(1);
  expect(io.stderr).toBe(`import refused: ${index}:3: does not round trip through the store\n`);
  expect(storeFiles(root)).toEqual([]);
});

test("a refused rerun rolls back and leaves the store as it was", async () => {
  const { root, env } = plans();
  await importStore(env);

  appendFileSync(join(root, "log.tsv"), "2026-10-31T11:00:00Z\tSkills\t002\tthread\tcheck\n");
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    `${COLUMNS.join("\t")}\n${row("001", "first")}\n`,
  );

  await expect(importStore(env)).rejects.toThrow("does not round trip through the store");

  writeFileSync(
    join(root, "Skills", "index.tsv"),
    [COLUMNS.join("\t"), row("001", "first"), row("002", "second"), ""].join("\n"),
  );

  expect(await importStore(env)).toEqual({ rows: 0, events: 1, files: 0 });
});

test("a missing log the store holds is written back from the store", async () => {
  const { root, env } = plans();
  await importStore(env);

  const log = readFileSync(join(root, "log.tsv"), "utf8");
  rmSync(join(root, "log.tsv"));
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(join(root, "log.tsv"), "utf8")).toBe(log);
});

test("imported trail lines keep their time, line and legacy flag on a monotonic clock", async () => {
  const { env } = plans();
  await importStore(env);

  const store = openStore(storePath(env));
  const events = store.db
    .query("SELECT wall, counter, ts, type, legacy, payload FROM events ORDER BY seq LIMIT 2")
    .all() as {
    wall: number;
    counter: number;
    ts: string;
    type: string;
    legacy: number;
    payload: string;
  }[];

  store.db.close();
  expect(
    events.map(({ payload, ...event }) => ({ ...event, line: JSON.parse(payload).line })),
  ).toEqual([
    {
      wall: Date.parse("2026-10-31T10:00:00Z"),
      counter: 0,
      ts: "2026-10-31T10:00:00Z",
      type: "start",
      legacy: 0,
      line: "2026-10-31T10:00:00Z\tSkills\t001\tstart\tfeat/first",
    },
    {
      wall: Date.parse("2026-10-31T10:00:00Z"),
      counter: 1,
      ts: "2026-10-31T09:00:00Z",
      type: "handover",
      legacy: 1,
      line: "2026-10-31T09:00:00Z\tSkills\t001\thandover\tlegacy name",
    },
  ]);
});

test("trail lines named like row events stay in the trail as legacy events", async () => {
  const { root, env } = plans();
  appendFileSync(join(root, "log.tsv"), "2026-10-31T11:00:00Z\tSkills\t002\trow\tby hand\n");
  appendFileSync(join(root, "log.tsv"), "2026-10-31T11:00:01Z\tSkills\t-\tthread\tad hoc\n");

  expect(await importStore(env)).toEqual({ rows: 2, events: 4, files: 3 });

  const store = openStore(storePath(env));
  const legacy = store.db.query("SELECT type FROM events WHERE legacy = 1 ORDER BY seq").all();

  store.db.close();
  expect(legacy).toEqual([{ type: "handover" }, { type: "row" }, { type: "thread" }]);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
});

test("a first import leaves a WAL store and clears a dead build's leftovers", async () => {
  const { root, env } = plans();
  writeFileSync(join(root, "plans.db.1.dead.tmp"), "abandoned");
  writeFileSync(join(root, "plans.db.1.dead.tmp-journal"), "abandoned");

  await importStore(env);

  const db = new Database(join(root, "plans.db"), { readonly: true });
  const mode = db.query("PRAGMA journal_mode").get();

  db.close();
  expect(mode).toEqual({ journal_mode: "wal" });
  expect(storeFiles(root).filter((name) => name.includes(".tmp"))).toEqual([]);
});

test("a changed middle row keeps its place and a missing index the store holds comes back", async () => {
  const { root, env } = plans();
  const index = join(root, "Skills", "index.tsv");
  writeFileSync(
    index,
    [COLUMNS.join("\t"), row("001", "first"), row("002", "second"), row("003", "third"), ""].join(
      "\n",
    ),
  );

  await importStore(env);
  writeFileSync(
    index,
    [
      COLUMNS.join("\t"),
      row("001", "first"),
      row("002", "second", "edited"),
      row("003", "third"),
      "",
    ].join("\n"),
  );

  expect(await importStore(env)).toEqual({ rows: 1, events: 0, files: 0 });

  const edited = readFileSync(index, "utf8");
  rmSync(index);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(index, "utf8")).toBe(edited);
});

test("an empty view the store imported comes back once it goes missing", async () => {
  const { root, env } = plans();
  mkdirSync(join(root, "Empty"));
  writeFileSync(join(root, "Empty", "index.tsv"), `${COLUMNS.join("\t")}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  await importStore(env);
  rmSync(join(root, "Empty", "index.tsv"));
  rmSync(join(root, "log.tsv"));

  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(join(root, "Empty", "index.tsv"), "utf8")).toBe(`${COLUMNS.join("\t")}\n`);
  expect(readFileSync(join(root, "log.tsv"), "utf8")).toBe(LOG_HEADER);
});

test("import takes no arguments", async () => {
  const { env } = plans();
  const io = capture(env);

  expect(await importVerb(["Skills"], "skills plans import", io)).toBe(2);
  expect(io.stderr).toBe("usage: skills plans import\n");
});
