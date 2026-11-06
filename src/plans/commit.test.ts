import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLog, commitPlans, updateIndex } from "./commit.ts";
import { COLUMNS } from "./index-tsv.ts";
import { importStore } from "./import.ts";
import { appendEvent, markPending, openStore, storePath, write } from "./store.ts";
import { closePlan } from "./verbs.ts";
import { LOG_HEADER } from "./trail.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function row(id: string, slug: string, note = "-"): string {
  return [id, slug, "TODO", "P1", "S", "-", "-", "-", "2026-10-31", note].join("\t");
}

function plans(): { root: string; env: NodeJS.ProcessEnv; index: string; log: string } {
  const root = mkdtempSync(join(tmpdir(), "skills-commit-"));
  temporary.push(root);

  mkdirSync(join(root, "Skills"));

  const index = join(root, "Skills", "index.tsv");
  writeFileSync(index, [COLUMNS.join("\t"), row("001", "first"), ""].join("\n"));

  const log = join(root, "log.tsv");
  writeFileSync(log, `${LOG_HEADER}2026-10-31T10:00:00Z\tSkills\t001\tstart\tfeat/first\n`);
  return { root, env: { PLANS_DIR: root }, index, log };
}

function events(root: string): { type: string; plan: string }[] {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    return db.query("SELECT type, plan FROM events ORDER BY seq").all() as {
      type: string;
      plan: string;
    }[];
  } finally {
    db.close();
  }
}

test("a row write imports on first use and leaves a row event behind", async () => {
  const { root, index } = plans();

  await updateIndex(index, (rows) => {
    for (const entry of rows) entry.status = "DOING";
  });

  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tDOING\t");
  expect(events(root).map((event) => event.type)).toEqual(["start", "imported", "row"]);
  expect(await importStore({ PLANS_DIR: root })).toEqual({ rows: 0, events: 0, files: 0 });
});

test("an added row and its trail line commit together", async () => {
  const { root, index, log } = plans();

  await updateIndex(index, (rows, trail) => {
    rows.push({ ...rows[0]!, id: "002", slug: "second" });
    trail.log("Skills", "002", "start", "feat/second");
  });

  expect(events(root).slice(-2)).toEqual([
    { type: "start", plan: "002" },
    { type: "added", plan: "002" },
  ]);

  expect(readFileSync(log, "utf8").trimEnd().split("\n").at(-1)).toMatch(
    /\tSkills\t002\tstart\tfeat\/second$/,
  );
});

test("a hand edit refuses the next write until import takes it in", async () => {
  const { root, env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  writeFileSync(index, readFileSync(index, "utf8").replace("\t-\n", "\thand note\n"));
  const edited = readFileSync(index, "utf8");

  const touch = () => updateIndex(index, (rows) => rows.length);
  expect(await touch().catch((error: Error) => error.message)).toBe(
    `${index} changed outside the store, run skills plans import to take the edit in`,
  );

  expect(readFileSync(index, "utf8")).toBe(edited);

  await appendLog("Skills", "001", "thread", "t2", env);
  expect(await importStore(env)).toEqual({ rows: 1, events: 0, files: 0 });

  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  expect(readFileSync(index, "utf8")).toContain("\tDOING\t");
  expect(readFileSync(index, "utf8")).toContain("\thand note\n");
  expect(events(root).filter((event) => event.type === "row")).toHaveLength(2);
});

function crashAfterCommit(env: NodeJS.ProcessEnv): void {
  const store = openStore(storePath(env));
  try {
    write(store, () => {
      markPending(store, "log.tsv");
      appendEvent(store, {
        type: "thread",
        at: Date.parse("2026-11-01T00:00:00Z"),
        ts: "2026-11-01T00:00:00Z",
        project: "Skills",
        plan: "001",
        payload: { detail: "t2", line: "2026-11-01T00:00:00Z\tSkills\t001\tthread\tt2" },
      });
    });
  } finally {
    store.db.close();
  }
}

test("a view left behind by a crash before the rename is repaired by the next write", async () => {
  const { root, env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  crashAfterCommit(env);

  writeFileSync(join(root, "Skills", "index.tsv"), readFileSync(join(root, "Skills", "index.tsv")));
  await expect(importStore(env)).rejects.toThrow("has a write that has not reached it yet");

  await commitPlans(root, { index: "Skills" }, () => undefined);

  expect(readFileSync(log, "utf8").trimEnd().split("\n").slice(-1)).toEqual([
    "2026-11-01T00:00:00Z\tSkills\t001\tthread\tt2",
  ]);

  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
});

test("a trail the store created but never wrote is written by the next write anywhere", async () => {
  const { root, env, log } = plans();
  rmSync(log);
  await updateIndex(join(root, "Skills", "index.tsv"), () => undefined);
  crashAfterCommit(env);

  expect(existsSync(log)).toBe(false);
  await commitPlans(root, { index: "Skills" }, () => undefined);
  expect(readFileSync(log, "utf8")).toBe(
    `${LOG_HEADER}2026-11-01T00:00:00Z\tSkills\t001\tthread\tt2\n`,
  );
});

test("a close refused by a hand edited trail leaves the plan file where it was", async () => {
  const { root, env, index, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const plan = join(root, "Skills", "001-first.md");
  writeFileSync(plan, "# 001 first\n\n## Landed\n\nDropped.\n");
  writeFileSync(log, `${readFileSync(log, "utf8")}hand\tline\n`);

  const result = await closePlan({
    index,
    project: "Skills",
    id: "001",
    status: "DROPPED",
    note: "not needed",
    stamp: async () => "unused",
    dryRun: false,
    env,
  });

  expect(result).toEqual({
    kind: "refused",
    reason: `${log} changed outside the store, run skills plans import to take the edit in`,
    draftless: undefined,
  });

  expect(existsSync(plan)).toBe(true);
  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tTODO\t");
});

test("an index the store never saw refuses unless it holds only the header", async () => {
  const { root, env } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  mkdirSync(join(root, "Fresh"));
  const fresh = join(root, "Fresh", "index.tsv");
  writeFileSync(fresh, `${COLUMNS.join("\t")}\n`);

  await updateIndex(fresh, (rows) => rows.push({ ...emptyRow(), id: "001", slug: "one" }));
  expect(readFileSync(fresh, "utf8").split("\n")[1]).toStartWith("001\tone\t");

  mkdirSync(join(root, "Full"));
  const full = join(root, "Full", "index.tsv");
  writeFileSync(full, [COLUMNS.join("\t"), row("001", "kept"), ""].join("\n"));

  await expect(updateIndex(full, () => undefined)).rejects.toThrow(
    `${full} is not in the store yet, run skills plans import`,
  );
});

function emptyRow(): Record<(typeof COLUMNS)[number], string> {
  return Object.fromEntries(COLUMNS.map((column) => [column, "-"])) as Record<
    (typeof COLUMNS)[number],
    string
  >;
}

function crashAfterRowCommit(env: NodeJS.ProcessEnv, status: string): void {
  const store = openStore(storePath(env));
  try {
    write(store, () => {
      markPending(store, "Skills/index.tsv");
      appendEvent(store, {
        type: "row",
        at: Date.now(),
        project: "Skills",
        plan: "001",
        payload: { row: { ...emptyRow(), id: "001", slug: "first", status } },
      });
    });
  } finally {
    store.db.close();
  }
}

test("an index edited while its write was unfinished keeps the committed write", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  crashAfterRowCommit(env, "DOING");

  writeFileSync(index, readFileSync(index, "utf8").replace("\t-\n", "\thand note\n"));
  await expect(importStore(env)).rejects.toThrow(
    "changed while a write to it was unfinished, so import cannot take the edit in without undoing that write; save the edit, move the file aside and run skills plans import again",
  );

  rmSync(index);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tDOING\t");
});

test("a trail edited while its write was unfinished names the way out", async () => {
  const { env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  crashAfterCommit(env);
  writeFileSync(log, `${readFileSync(log, "utf8")}hand\tline\n`);

  await expect(importStore(env)).rejects.toThrow(
    "move the file aside and run skills plans import again, which writes the store's copy back",
  );

  rmSync(log);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(log, "utf8").trimEnd().split("\n").at(-1)).toBe(
    "2026-11-01T00:00:00Z\tSkills\t001\tthread\tt2",
  );
});

test("import writes back a view moved aside, so index commands work again", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  const before = readFileSync(index, "utf8");

  rmSync(index);
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
  expect(readFileSync(index, "utf8")).toBe(before);
});

test("a view accepted by its render keeps publishing after the write changes it", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const store = openStore(storePath(env));
  try {
    store.db.run("UPDATE views SET current = NULL");
  } finally {
    store.db.close();
  }

  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  await updateIndex(index, (rows) => {
    rows[0]!.status = "REVIEW";
  });

  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tREVIEW\t");
  expect(await importStore(env)).toEqual({ rows: 0, events: 0, files: 0 });
});

test("a trail moved aside comes back on the next write of any kind", async () => {
  const { env, index, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  const trail = readFileSync(log, "utf8");

  rmSync(log);
  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  expect(readFileSync(log, "utf8")).toBe(trail);
});
