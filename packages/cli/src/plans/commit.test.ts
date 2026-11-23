import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER, renderTrail } from "skills-core";
import { chainOf, trailRecord, trusting } from "../test/authored.ts";
import { appendLog, commitPlans, updateIndex } from "./commit.ts";
import { importStore, Refusal } from "./import.ts";
import {
  appendEvent,
  markPending,
  openStore,
  pendingViews,
  storePath,
  trailEntries,
  write,
  type Store,
} from "./store.ts";
import * as stores from "./store.ts";
import { applyRemoteEvents } from "./sync.ts";
import { closePlan } from "./verbs.ts";

const temporary: string[] = [];

afterEach(() => {
  mock.restore();
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

test("a row write keeps the view's mode", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  chmodSync(index, 0o664);

  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tDOING\t");
  expect(statSync(index).mode & 0o777).toBe(0o664);
});

function crashAfterCommit(env: NodeJS.ProcessEnv): void {
  const store = openStore(storePath(env));
  try {
    write(store, () => {
      markPending(store, "log.tsv");
      appendEvent(store, {
        kind: "trail",
        at: Date.parse("2026-11-01T00:00:00Z"),
        entry: {
          ts: "2026-11-01T00:00:00Z",
          project: "Skills",
          id: "001",
          event: "thread",
          detail: "t2",
          line: "2026-11-01T00:00:00Z\tSkills\t001\tthread\tt2",
        },
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

async function refusal(attempt: Promise<unknown>): Promise<string> {
  const error = await attempt.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );

  expect(error).toBeInstanceOf(Refusal);
  return (error as Refusal).message;
}

test("a view that is not UTF-8 refuses like a hand edit", async () => {
  const { root, env, index, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  appendFileSync(index, new Uint8Array([0xff]));
  const indexBytes = readFileSync(index);
  expect(await refusal(updateIndex(index, (rows) => rows.length))).toBe(
    `${index} changed outside the store, run skills plans import to take the edit in`,
  );

  appendFileSync(log, new Uint8Array([0xff]));
  const logBytes = readFileSync(log);
  expect(await refusal(appendLog("Skills", "001", "thread", "t2", env))).toBe(
    `${log} changed outside the store, run skills plans import to take the edit in`,
  );

  mkdirSync(join(root, "Other"));
  const other = join(root, "Other", "index.tsv");
  writeFileSync(other, [COLUMNS.join("\t"), row("001", "other"), ""].join("\n"));
  appendFileSync(other, new Uint8Array([0xff]));
  const otherBytes = readFileSync(other);
  expect(await refusal(updateIndex(other, () => undefined))).toBe(
    `${other} is not in the store yet, run skills plans import`,
  );

  expect(readFileSync(index)).toEqual(indexBytes);
  expect(readFileSync(log)).toEqual(logBytes);
  expect(readFileSync(other)).toEqual(otherBytes);
});

test("an index that is not UTF-8 pending its own write stays on disk while another write lands", async () => {
  const { root, env, index } = plans();
  mkdirSync(join(root, "Other"));
  const other = join(root, "Other", "index.tsv");
  writeFileSync(other, [COLUMNS.join("\t"), row("001", "other"), ""].join("\n"));
  await appendLog("Skills", "001", "thread", "t1", env);

  const store = openStore(storePath(env));
  try {
    write(store, () => markPending(store, "Other/index.tsv"));
  } finally {
    store.db.close();
  }

  appendFileSync(other, new Uint8Array([0xff]));
  const otherBytes = readFileSync(other);

  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tDOING\t");
  expect(readFileSync(other)).toEqual(otherBytes);
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
        kind: "row",
        type: "row",
        at: Date.now(),
        project: "Skills",
        row: { ...emptyRow(), id: "001", slug: "first", status },
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

function staging(folder: string): boolean {
  return readdirSync(folder).some((name) => name.endsWith(".tmp"));
}

function saveWhileStaging(path: string, bytes: string): () => boolean {
  const fsync = fs.fsyncSync;
  let staged: boolean | undefined;
  spyOn(fs, "fsyncSync").mockImplementation((descriptor) => {
    fsync(descriptor);
    if (staged !== undefined) return;

    staged = staging(join(path, ".."));
    writeFileSync(path, bytes);
  });

  return () => staged === true;
}

async function refusedWhileStaging(env: NodeJS.ProcessEnv, index: string): Promise<string> {
  const message = await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  }).catch((error: Error) => error.message);

  mock.restore();
  const store = openStore(storePath(env));
  try {
    expect(pendingViews(store)).toContain("Skills/index.tsv");
  } finally {
    store.db.close();
  }

  expect(staging(join(index, ".."))).toBe(false);
  return message as string;
}

test("a view saved while its write stages keeps the saved bytes", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const edited = readFileSync(index, "utf8").replace("\t-\n", "\thand note\n");
  const staged = saveWhileStaging(index, edited);

  expect(await refusedWhileStaging(env, index)).toBe(
    `the write is in the store, but ${index} changed outside the store, run skills plans import to take the edit in`,
  );

  expect(staged()).toBe(true);
  expect(readFileSync(index, "utf8")).toBe(edited);
});

test("a missing view saved while its write stages keeps the created bytes", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const created = readFileSync(index, "utf8").replace("\t-\n", "\tcreated\n");
  rmSync(index);
  const staged = saveWhileStaging(index, created);

  expect(await refusedWhileStaging(env, index)).toBe(
    `the write is in the store, but ${index} changed outside the store, run skills plans import to take the edit in`,
  );

  expect(staged()).toBe(true);
  expect(readFileSync(index, "utf8")).toBe(created);
});

function createBeforeLink(path: string, bytes: string): void {
  const link = fs.linkSync;
  spyOn(fs, "linkSync").mockImplementation((from, to) => {
    if (to === path) writeFileSync(path, bytes);
    link(from, to);
  });
}

test("a trail created just before its repair links keeps the created bytes", async () => {
  const { env, index, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const created = `${readFileSync(log, "utf8")}2026-11-01T00:00:00Z\tSkills\t001\tthread\thand\n`;
  rmSync(log);
  createBeforeLink(log, created);

  await updateIndex(index, (rows) => {
    rows[0]!.status = "DOING";
  });

  mock.restore();
  expect(readFileSync(index, "utf8")).toContain("001\tfirst\tDOING\t");
  expect(readFileSync(log, "utf8")).toBe(created);
});

test("a missing index saved just before its write links refuses like a hand edit", async () => {
  const { env, index } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const created = readFileSync(index, "utf8").replace("\t-\n", "\tcreated\n");
  rmSync(index);
  createBeforeLink(index, created);

  expect(await refusedWhileStaging(env, index)).toBe(
    `the write is in the store, but ${index} changed outside the store, run skills plans import to take the edit in`,
  );

  expect(readFileSync(index, "utf8")).toBe(created);
});

function inStore<T>(env: NodeJS.ProcessEnv, use: (store: Store) => T): T {
  const store = openStore(storePath(env));
  try {
    return use(store);
  } finally {
    store.db.close();
  }
}

function rendered(env: NodeJS.ProcessEnv): string {
  return inStore(env, (store) => renderTrail(trailEntries(store)));
}

test("a trail write appends without reading an earlier trail event", async () => {
  const { env, log } = plans();
  await importStore(env);

  inStore(env, (store) =>
    store.db.run(
      `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
       VALUES (?, 'legacy', 0, 0, '1970-01-01T00:00:00Z', 'Skills', '001', 'note', 1, '{not json')`,
      [crypto.randomUUID()],
    ),
  );

  const before = readFileSync(log, "utf8");
  await appendLog("Skills", "001", "thread", "t1", env);

  const after = readFileSync(log, "utf8");
  expect(after.slice(0, before.length)).toBe(before);
  expect(after.slice(before.length)).toMatch(/^\S+\tSkills\t001\tthread\tt1\n$/);
});

test("a trail write appends twenty lines that match the full render", async () => {
  const { env, log } = plans();
  await importStore(env);

  for (let line = 1; line <= 20; line++)
    await appendLog("Skills", "001", "thread", `t${line}`, env);

  expect(readFileSync(log, "utf8").split("\n")).toHaveLength(23);
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full after a crash left the trail pending", async () => {
  const { env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  crashAfterCommit(env);

  await appendLog("Skills", "001", "thread", "t3", env);

  expect(readFileSync(log, "utf8")).toContain("\tthread\tt2\n");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when the trail is gone from disk", async () => {
  const { env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  rmSync(log);

  await appendLog("Skills", "001", "thread", "t2", env);

  expect(readFileSync(log, "utf8")).toContain("\tthread\tt1\n");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when the trail was accepted by its render", async () => {
  const { env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);
  inStore(env, (store) =>
    store.db.run("UPDATE views SET current = 'other' WHERE path = 'log.tsv'"),
  );

  const render = spyOn(stores, "renderView");
  await appendLog("Skills", "001", "thread", "t2", env);

  expect(render.mock.calls.filter(([, relative]) => relative === "log.tsv")).toHaveLength(2);
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

function insertTrail(
  store: Store,
  wall: number,
  detail: string,
  quarantined: string | null,
): string {
  const id = Bun.randomUUIDv7("hex", wall);
  const ts = new Date(wall).toISOString().replace(/\.\d{3}Z$/, "Z");
  store.db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload, quarantined)
     VALUES (?, 'other', ?, 0, ?, 'Skills', '001', 'thread', 0, ?, ?)`,
    [
      id,
      wall,
      ts,
      JSON.stringify({ detail, line: `${ts}\tSkills\t001\tthread\t${detail}` }),
      quarantined,
    ],
  );

  return id;
}

test("a trail write renders in full when the write holds a trail event it did not append", async () => {
  const { env, log } = plans();
  await importStore(env);

  await appendLog("Skills", "001", "thread", "t1", env, undefined, (tx) => {
    insertTrail(tx.store, Date.parse("2026-11-01T00:00:00Z"), "other", null);
  });

  expect(readFileSync(log, "utf8")).toContain("\tthread\tother\n");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when the write adds a trail event before it logs", async () => {
  const { root, env, log } = plans();
  await importStore(env);

  await commitPlans(root, {}, (trail, _rows, _record, _world, tx) => {
    const at = Date.parse("2026-11-01T00:00:00Z");
    const entry = {
      ts: "2026-11-01T00:00:00Z",
      project: "Skills",
      id: "001",
      event: "thread",
      detail: "first",
      line: "2026-11-01T00:00:00Z\tSkills\t001\tthread\tfirst",
    };

    appendEvent(tx.store, { kind: "trail", at, entry });
    trail.log("Skills", "001", "thread", "t1");
  });

  expect(readFileSync(log, "utf8")).toContain("\tthread\tfirst\n");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when an earlier event it readmits sorts after its own", async () => {
  const { env, log } = plans();
  await importStore(env);
  const ahead = inStore(env, (store) =>
    insertTrail(store, Date.now() + 3_600_000, "ahead", "held"),
  );

  await appendLog("Skills", "001", "thread", "t1", env, undefined, (tx) => {
    tx.store.db.run("UPDATE events SET quarantined = NULL WHERE id = ?", [ahead]);
  });

  expect(readFileSync(log, "utf8").trimEnd().split("\n").at(-1)).toEndWith("\tthread\tahead");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when another writer commits before its publish", async () => {
  const { env, log } = plans();
  await importStore(env);
  const held = inStore(env, (store) => {
    markPending(store, "log.tsv");
    return insertTrail(store, Date.now() - 60_000, "held", null);
  });

  await appendLog("Skills", "001", "thread", "t1", env);
  expect(readFileSync(log, "utf8")).toContain("\tthread\theld\n");

  const commit = stores.write;
  let writes = 0;
  spyOn(stores, "write").mockImplementation((store, edit) => {
    if (++writes === 2)
      inStore(env, (other) => {
        markPending(other, "log.tsv");
        other.db.run("UPDATE events SET quarantined = 'revoked' WHERE id = ?", [held]);
      });

    return commit(store, edit);
  });

  await appendLog("Skills", "001", "thread", "t2", env);

  expect(writes).toBe(2);
  expect(readFileSync(log, "utf8")).not.toContain("\tthread\theld\n");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});

test("a trail write renders in full when a remote line sorts before the newest local one", async () => {
  const { root, env, log } = plans();
  await appendLog("Skills", "001", "thread", "t1", env);

  const remote = trailRecord(crypto.randomUUID(), Date.now() - 60_000, 0, "050");
  await applyRemoteEvents(root, { events: chainOf([remote]), blobs: [] }, trusting);

  const lines = readFileSync(log, "utf8").trimEnd().split("\n");
  expect(lines.at(-2)).toEndWith("\tSkills\t050\tstart\tfeat/050");
  expect(lines.at(-1)).toEndWith("\tthread\tt1");
  expect(readFileSync(log, "utf8")).toBe(rendered(env));

  await appendLog("Skills", "001", "thread", "t2", env);
  expect(readFileSync(log, "utf8")).toBe(rendered(env));
});
