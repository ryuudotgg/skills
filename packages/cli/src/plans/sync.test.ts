import { Database } from "bun:sqlite";
import { afterEach, expect, setSystemTime, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COLUMNS, eventHash, hex, LOG_HEADER, parseId, type IndexRow } from "skills-core";
import type { Io } from "../io.ts";
import { appendLog, recordWorkingCopies, updateIndex } from "./commit.ts";
import { importStore } from "./import.ts";
import {
  closeVerb,
  fileVerb,
  linkVerb,
  listVerb,
  renumberVerb,
  showVerb as showIssue,
} from "./issues.ts";
import { checkoutVerb, historyVerb, showVerb } from "./revisions.ts";
import { chainOf, chained, revoking, sign, trailRecord, trusting } from "../test/authored.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { counts, fetchFailed, queuedFetches } from "./outbox.ts";
import { latestRevision, openStore, sha256, type Store } from "./store.ts";
import {
  applyRemoteEvents,
  authoredHash,
  type AuthoredEvent,
  type RemoteBatch,
  type RemoteBlob,
  type RemoteRecord,
  setSyncMeta,
  syncMeta,
  type SyncMeta,
} from "./sync.ts";

const temporary: string[] = [];

afterEach(() => {
  setSystemTime();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "skills-sync-"));
  temporary.push(root);
  return root;
}

function row(id: string, slug: string, status = "TODO"): IndexRow {
  return Object.fromEntries(
    COLUMNS.map((column) => [column, "-"]).concat([
      ["id", id],
      ["slug", slug],
      ["status", status],
      ["pri", "P1"],
      ["effort", "S"],
      ["updated", "2026-11-07"],
    ]),
  ) as IndexRow;
}

async function fixture(): Promise<string> {
  const root = join(scratch(), "a");
  mkdirSync(join(root, "Skills", "done"), { recursive: true });

  const rows = [row("001", "one"), row("002", "two")];
  const lines = rows.map((entry) => COLUMNS.map((column) => entry[column]).join("\t"));
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    `${[COLUMNS.join("\t"), ...lines].join("\n")}\n`,
  );

  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  writeFileSync(join(root, "Skills", "001-one.md"), "# 001 one\n");
  writeFileSync(join(root, "Skills", "002-two.md"), "# 002 two\n");

  await importStore({ PLANS_DIR: root });
  return root;
}

function recalled(root: string, word: string): string[] {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    const hits = db
      .query("SELECT ref FROM recall WHERE recall MATCH ? ORDER BY ref")
      .all(`"${word}"`) as { ref: string }[];

    return hits.map((hit) => hit.ref);
  } finally {
    db.close();
  }
}

function fork(root: string, name: string): string {
  const copy = join(root, "..", name);
  cpSync(root, copy, { recursive: true });

  const db = new Database(join(copy, "plans.db"));
  db.run("UPDATE meta SET value = ? WHERE key = 'machine'", [crypto.randomUUID()]);
  db.close();

  return copy;
}

type Row = Omit<RemoteRecord, "legacy" | "payload"> & { legacy: number; payload: string };

function authored(root: string): RemoteBatch {
  const store = openStore(join(root, "plans.db"));
  try {
    const rows = store.db
      .query(
        `SELECT id, machine, wall, counter, ts, project, plan, type, legacy, payload FROM events
         WHERE machine = ? ORDER BY wall, counter, id`,
      )
      .all(store.machine) as Row[];

    const events: AuthoredEvent[] = [];

    let previous: string | null = null;
    for (const [index, stored] of rows.entries()) {
      const record = {
        ...stored,
        legacy: stored.legacy === 1,
        payload: JSON.parse(stored.payload),
      };

      const event = sign(record, index + 1, previous);
      events.push(event);
      previous = authoredHash(event);
    }

    const blobs = store.db
      .query(
        `SELECT r.event, r.sha256, b.bytes FROM revisions r JOIN blobs b ON b.sha256 = r.sha256
         WHERE r.machine = ?`,
      )
      .all(store.machine) as RemoteBlob[];

    return { events, blobs };
  } finally {
    store.db.close();
  }
}

function capture(root: string): Io & { stdout: string; stderr: string } {
  const io = {
    cwd: "/",
    env: { PLANS_DIR: root },
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

async function history(root: string, key: string): Promise<string> {
  const io = capture(root);
  expect(await historyVerb(["Skills", key], "usage", io)).toBe(0);
  return io.stdout;
}

async function views(root: string): Promise<string[]> {
  return [
    readFileSync(join(root, "Skills", "index.tsv"), "utf8"),
    readFileSync(join(root, "log.tsv"), "utf8"),
    await history(root, "001"),
    await history(root, "002"),
  ];
}

async function diverge(root: string, id: string, slug: string, note: string): Promise<void> {
  await updateIndex(join(root, "Skills", "index.tsv"), (rows) => {
    rows.push(row(id, slug));
  });

  await appendLog("Skills", id, "start", `feat/${slug}`, { PLANS_DIR: root });
  writeFileSync(join(root, "Skills", "001-one.md"), `# 001 one\n\n${note}\n`);
  await recordWorkingCopies(root, [join(root, "Skills", "001-one.md")]);
}

function quarantine(root: string, id: string): string | null {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    const event = db.query("SELECT quarantined FROM events WHERE id = ?").get(id) as {
      quarantined: string | null;
    };

    return event.quarantined;
  } finally {
    db.close();
  }
}

function opened(event: AuthoredEvent): RemoteRecord {
  return JSON.parse(new TextDecoder().decode(event.envelope)) as RemoteRecord;
}

function trailOf(root: string): string {
  return readFileSync(join(root, "log.tsv"), "utf8");
}

test("merges two stores in both orders", async () => {
  const a = await fixture();
  const b = fork(a, "b");

  await diverge(a, "010", "from-a", "edited on a");
  await diverge(b, "020", "from-b", "edited on b");
  writeFileSync(join(b, "Skills", "002-two.md"), "# 002 two\n\nonly on b\n");
  await recordWorkingCopies(b, [join(b, "Skills", "002-two.md")]);

  const fromA = authored(a);
  const fromB = authored(b);

  const intoA = await applyRemoteEvents(a, fromB, trusting);
  const intoB = await applyRemoteEvents(b, fromA, trusting);
  expect(intoA.applied).toBeGreaterThan(0);
  expect(intoB.applied).toBeGreaterThan(0);
  expect(intoA.refused).toEqual([]);

  const [indexA, trailA, ...historyA] = await views(a);
  expect(await views(b)).toEqual([indexA!, trailA!, ...historyA]);

  expect(indexA).toContain("010\tfrom-a");
  expect(indexA).toContain("020\tfrom-b");
  expect(trailA).toContain("feat/from-a");
  expect(trailA).toContain("feat/from-b");

  expect(historyA[0]!.trim().split("\n")).toHaveLength(3);
  expect(historyA[1]!.trim().split("\n")).toHaveLength(2);

  const again = await applyRemoteEvents(a, fromB, trusting);
  expect(again.applied).toBe(0);
  expect(again.skipped).toBe(fromB.events.length);
  expect(await views(a)).toEqual([indexA!, trailA!, ...historyA]);

  const showA = capture(a);
  const showB = capture(b);
  expect(await showVerb(["Skills", "001"], "usage", showA)).toBe(0);
  expect(await showVerb(["Skills", "001"], "usage", showB)).toBe(0);
  expect(showA.stdout).toBe(showB.stdout);

  const blocked = capture(a);
  writeFileSync(join(a, "Skills", "001-one.md"), "# 001 one\n\nedited on a\n");
  expect(await checkoutVerb(["Skills", "001"], "usage", blocked)).toBe(1);
  expect(blocked.stderr).toContain("move it out of the plans directory");

  rmSync(join(a, "Skills", "001-one.md"));
  const taken = capture(a);
  expect(await checkoutVerb(["Skills", "001"], "usage", taken)).toBe(0);
  expect(readFileSync(join(a, "Skills", "001-one.md"), "utf8")).toBe(showA.stdout);

  const store = openStore(join(a, "plans.db"));
  expect(latestRevision(store, join("Skills", "001-one.md"))).toBe(
    sha256("# 001 one\n\nedited on a\n"),
  );

  store.db.close();
});

test("rejects an event with a bad signature", async () => {
  const a = await fixture();
  const [event] = chained(crypto.randomUUID(), ["030"]);
  const forged = { ...event!, signature: new Uint8Array(32) };

  const applied = await applyRemoteEvents(a, { events: [forged], blobs: [] }, trusting);
  expect(applied.quarantined.signature).toBe(1);
  expect(applied.applied).toBe(0);
  expect(quarantine(a, forged.id)).toBe("signature");
  expect(readFileSync(join(a, "log.tsv"), "utf8")).not.toContain("feat/030");

  const [other] = chained(crypto.randomUUID(), ["031"]);
  const misnamed = sign(opened(other!), other!.sequence, other!.previous, crypto.randomUUID());

  const named = await applyRemoteEvents(a, { events: [misnamed], blobs: [] }, trusting);
  expect(named.quarantined.malformed).toBe(1);
  expect(readFileSync(join(a, "log.tsv"), "utf8")).not.toContain("feat/031");
});

test("rejects a second event at a used sequence", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const [first] = chained(machine, ["040"]);
  const [second] = chained(machine, ["041"]);

  await applyRemoteEvents(a, { events: [first!], blobs: [] }, trusting);
  const applied = await applyRemoteEvents(a, { events: [second!], blobs: [] }, trusting);

  expect(applied.quarantined.sequence).toBe(1);
  expect(quarantine(a, second!.id)).toBe("sequence");

  const trail = readFileSync(join(a, "log.tsv"), "utf8");
  expect(trail).toContain("feat/040");
  expect(trail).not.toContain("feat/041");
});

test("refuses a blob whose sha256 differs from its event", async () => {
  const a = await fixture();
  const b = fork(a, "b");
  writeFileSync(join(b, "Skills", "002-two.md"), "# 002 two\n\n## Notes\n\nfrom b\n");
  await recordWorkingCopies(b, [join(b, "Skills", "002-two.md")]);

  const batch = authored(b);
  const [blob] = batch.blobs;
  const tampered = {
    event: blob!.event,
    sha256: blob!.sha256,
    bytes: new TextEncoder().encode("# 002 two\n\nforged\n"),
  };

  const applied = await applyRemoteEvents(a, { events: batch.events, blobs: [tampered] }, trusting);
  expect(applied.refused).toEqual([blob!.event]);
  expect(applied.blobs).toBe(0);
  expect(applied.queued).toBe(1);
  expect((await history(a, "002")).trim().split("\n").at(-1)).toEndWith("\t(fetching)");

  const show = capture(a);
  expect(await showVerb(["Skills", "002"], "usage", show)).toBe(1);
  expect(show.stderr).toContain("still fetching");
  expect(recalled(a, "from")).toEqual([]);

  const landed = await applyRemoteEvents(a, { events: [], blobs: [blob!] }, trusting);
  expect(landed.blobs).toBe(1);
  expect((await history(a, "002")).trim().split("\n").at(-1)).not.toContain("(fetching)");
  expect(recalled(a, "from")).toEqual(["002"]);

  const db = new Database(join(a, "plans.db"), { readonly: true });
  expect(db.query("SELECT count(*) AS n FROM blob_fetches").get()).toEqual({ n: 0 });
  db.close();
});

test("never folds an event off a revoked author's committed chain", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const genuine = chained(machine, ["050", "051", "052"]);
  const [forged] = chained(machine, ["059"]);
  const verifier = revoking(machine, { sequence: 2, hash: authoredHash(genuine[1]!) });

  await applyRemoteEvents(a, { events: [forged!], blobs: [] }, trusting);
  expect(readFileSync(join(a, "log.tsv"), "utf8")).toContain("feat/059");

  const applied = await applyRemoteEvents(a, { events: genuine, blobs: [] }, verifier);
  expect(applied.quarantined.revoked).toBe(1);

  expect(quarantine(a, forged!.id)).toBe("revoked");
  expect(quarantine(a, genuine[0]!.id)).toBeNull();
  expect(quarantine(a, genuine[1]!.id)).toBeNull();
  expect(quarantine(a, genuine[2]!.id)).toBe("revoked");

  const trail = readFileSync(join(a, "log.tsv"), "utf8");
  expect(trail).toContain("feat/050");
  expect(trail).toContain("feat/051");
  expect(trail).not.toContain("feat/052");
  expect(trail).not.toContain("feat/059");
});

test("refolds stored events once their author is revoked", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const events = chained(machine, ["060", "061", "062"]);
  await applyRemoteEvents(a, { events, blobs: [] }, trusting);

  expect(readFileSync(join(a, "log.tsv"), "utf8")).toContain("feat/062");
  expect(recalled(a, "062")).toEqual(["062"]);

  const verifier = revoking(machine, { sequence: 2, hash: authoredHash(events[1]!) });
  const applied = await applyRemoteEvents(a, { events: [], blobs: [] }, verifier);
  expect(applied.applied).toBe(0);

  const trail = readFileSync(join(a, "log.tsv"), "utf8");
  expect(trail).toContain("feat/061");
  expect(trail).not.toContain("feat/062");
  expect(quarantine(a, events[2]!.id)).toBe("revoked");

  expect(recalled(a, "061")).toEqual(["061"]);
  expect(recalled(a, "062")).toEqual([]);
});

function feedGeneration(root: string): string | undefined {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    const row = db.query("SELECT value FROM meta WHERE key = 'feed_generation'").get() as {
      value: string;
    } | null;

    return row?.value;
  } finally {
    db.close();
  }
}

test("a refold bumps the feed generation", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const events = chained(machine, ["065", "066", "067", "069"]);
  await applyRemoteEvents(a, { events: events.slice(0, 3), blobs: [] }, trusting);
  expect(feedGeneration(a)).toBeUndefined();

  const verifier = revoking(machine, { sequence: 2, hash: authoredHash(events[1]!) });
  await applyRemoteEvents(a, { events: [], blobs: [] }, verifier);
  expect(quarantine(a, events[2]!.id)).toBe("revoked");
  expect(feedGeneration(a)).toBe("1");

  const unrelated = chained(crypto.randomUUID(), ["068"]);
  await applyRemoteEvents(a, { events: unrelated, blobs: [] }, verifier);
  expect(feedGeneration(a)).toBe("1");

  await applyRemoteEvents(a, { events: [events[3]!], blobs: [] }, verifier);
  expect(quarantine(a, events[3]!.id)).toBe("revoked");
  expect(feedGeneration(a)).toBe("1");
});

type QueuedFetch = {
  sha256: string;
  locator: string;
  event: string;
  queued: number;
  attempts: number;
};

function inStore<T>(root: string, read: (store: Store) => T): T {
  const store = openStore(join(root, "plans.db"));
  try {
    return read(store);
  } finally {
    store.db.close();
  }
}

function fetchQueue(root: string): QueuedFetch[] {
  return inStore(
    root,
    (store) =>
      store.db
        .query("SELECT sha256, locator, event, queued, attempts FROM blob_fetches ORDER BY sha256")
        .all() as QueuedFetch[],
  );
}

function revisionRecord(machine: string, wall: number, plan: string, payload: object) {
  const captured = new Date(wall).toISOString();
  return {
    id: Bun.randomUUIDv7("hex", wall),
    machine,
    wall,
    counter: 0,
    ts: captured.replace(/\.\d{3}Z$/, "Z"),
    project: "Skills",
    plan,
    type: "revision",
    legacy: false,
    payload: { ...payload, captured },
  };
}

function copyRevision(machine: string, wall: number, text: string, locator: string): RemoteRecord {
  const path = join("Skills", "002-two.md");
  const size = Buffer.byteLength(text);
  return revisionRecord(machine, wall, "002", { path, sha256: sha256(text), size, blob: locator });
}

function fileRevision(machine: string, wall: number, text: string, locator: string): RemoteRecord {
  const digest = sha256(text);
  return revisionRecord(machine, wall, "-", {
    path: join("Skills", "notes.txt"),
    sha256: digest,
    size: Buffer.byteLength(text),
    executable: false,
    chunks: [{ sha256: digest, blob: locator }],
  });
}

const COPY = "# 002 two\n\nfrom the revoked author\n";

const NOTES = "notes from the revoked author\n";

const UNFETCHED = [sha256(COPY), sha256(NOTES)].sort();

async function unfetched(root: string) {
  const machine = crypto.randomUUID();
  const wall = Date.now();
  const events = chainOf([
    trailRecord(machine, wall, 0, "070"),
    copyRevision(machine, wall + 1, COPY, "c".repeat(32)),
    fileRevision(machine, wall + 2, NOTES, "d".repeat(32)),
  ]);

  await applyRemoteEvents(root, { events, blobs: [] }, trusting);

  const below = revoking(machine, { sequence: 1, hash: authoredHash(events[0]!) });
  const covering = revoking(machine, { sequence: 3, hash: authoredHash(events[2]!) });
  return { copy: events[1]!, file: events[2]!, below, covering };
}

test("a quarantined revision leaves no fetch queued", async () => {
  const a = await fixture();
  const { copy, file, below } = await unfetched(a);
  expect(fetchQueue(a).map((fetch) => fetch.sha256)).toEqual(UNFETCHED);
  expect(inStore(a, (store) => counts(store).fetching)).toBe(2);

  await applyRemoteEvents(a, { events: [], blobs: [] }, below);
  expect(quarantine(a, copy.id)).toBe("revoked");
  expect(quarantine(a, file.id)).toBe("revoked");
  expect(fetchQueue(a)).toEqual([]);
  expect(inStore(a, (store) => counts(store).fetching)).toBe(0);
});

test("a fetch another visible event still needs stays queued", async () => {
  const a = await fixture();
  const { below } = await unfetched(a);
  const digest = sha256(COPY);
  const locator = "e".repeat(32);

  const [shared] = chainOf([copyRevision(crypto.randomUUID(), Date.now() + 3, COPY, locator)]);
  await applyRemoteEvents(a, { events: [shared!], blobs: [] }, trusting);
  inStore(a, (store) => fetchFailed(store, [digest]));

  const [waiting] = fetchQueue(a).filter((fetch) => fetch.sha256 === digest);
  expect(waiting).toMatchObject({ locator: "c".repeat(32), attempts: 1 });

  setSystemTime(new Date(Date.now() + 60_000));
  await applyRemoteEvents(a, { events: [], blobs: [] }, below);
  expect(fetchQueue(a)).toEqual([waiting!]);
  expect(inStore(a, (store) => queuedFetches(store, 10))).toEqual([
    { sha256: digest, locator, event: shared!.id },
  ]);

  const blob = { event: shared!.id, sha256: digest, bytes: new TextEncoder().encode(COPY) };
  const landed = await applyRemoteEvents(a, { events: [], blobs: [blob] }, below);
  expect(landed.blobs).toBe(1);
  expect(landed.refused).toEqual([]);
  expect(fetchQueue(a)).toEqual([]);
});

test("a fetch orphaned before the upgrade is dropped once", async () => {
  const a = await fixture();
  const { below } = await unfetched(a);
  const text = "# 002 two\n\nstill visible\n";
  const [live] = chainOf([copyRevision(crypto.randomUUID(), Date.now() + 3, text, "e".repeat(32))]);
  await applyRemoteEvents(a, { events: [live!], blobs: [] }, trusting);

  const queued = fetchQueue(a);
  await applyRemoteEvents(a, { events: [], blobs: [] }, below);

  const needed = fetchQueue(a);
  expect(needed.map((fetch) => fetch.event)).toEqual([live!.id]);

  const leftByOlderCli = (swept: boolean) =>
    inStore(a, (store) => {
      for (const { sha256: digest, locator, event, queued: at, attempts } of queued)
        store.db.run(
          `INSERT OR IGNORE INTO blob_fetches (sha256, locator, event, queued, attempts)
           VALUES (?, ?, ?, ?, ?)`,
          [digest, locator, event, at, attempts],
        );

      if (!swept) store.db.run("DELETE FROM meta WHERE key = 'fetches_swept'");
    });

  leftByOlderCli(false);
  await applyRemoteEvents(a, { events: [], blobs: [] }, below);
  expect(fetchQueue(a)).toEqual(needed);

  leftByOlderCli(true);
  await applyRemoteEvents(a, { events: [], blobs: [] }, below);
  expect(fetchQueue(a)).toEqual(queued);
});

test("a restored revision queues its blob again", async () => {
  const a = await fixture();
  const { copy, file, below, covering } = await unfetched(a);
  inStore(a, (store) => fetchFailed(store, UNFETCHED));
  await applyRemoteEvents(a, { events: [], blobs: [] }, below);
  expect(fetchQueue(a)).toEqual([]);

  await applyRemoteEvents(a, { events: [], blobs: [] }, covering);
  expect(quarantine(a, copy.id)).toBeNull();
  expect(quarantine(a, file.id)).toBeNull();
  expect(fetchQueue(a).map(({ sha256: digest, attempts }) => ({ digest, attempts }))).toEqual(
    UNFETCHED.map((digest) => ({ digest, attempts: 0 })),
  );

  const blobs = [
    { event: copy.id, sha256: sha256(COPY), bytes: new TextEncoder().encode(COPY) },
    { event: file.id, sha256: sha256(NOTES), bytes: new TextEncoder().encode(NOTES) },
  ];

  const landed = await applyRemoteEvents(a, { events: [], blobs }, covering);
  expect(landed.blobs).toBe(2);
  expect(landed.refused).toEqual([]);
  expect(fetchQueue(a)).toEqual([]);
});

test("migrates revision texts into blobs and one revision event each", () => {
  const root = scratch();
  const path = join(root, "plans.db");
  const db = new Database(path);
  db.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.run(`CREATE TABLE events (seq INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE,
    machine TEXT NOT NULL, wall INTEGER NOT NULL, counter INTEGER NOT NULL, ts TEXT NOT NULL,
    project TEXT NOT NULL, plan TEXT NOT NULL, type TEXT NOT NULL, legacy INTEGER NOT NULL,
    payload TEXT NOT NULL)`);

  db.run("CREATE INDEX events_project ON events (project, type)");
  db.run("CREATE INDEX events_clock ON events (wall, counter)");
  db.run(
    "CREATE TABLE views (path TEXT PRIMARY KEY, current TEXT, pending INTEGER NOT NULL DEFAULT 0)",
  );

  db.run(`CREATE TABLE revisions (seq INTEGER PRIMARY KEY, project TEXT NOT NULL,
    path TEXT NOT NULL, sha256 TEXT NOT NULL, text BLOB NOT NULL, captured TEXT NOT NULL,
    machine TEXT NOT NULL)`);

  db.run("INSERT INTO meta VALUES ('machine', 'm')");

  const captured = "2026-11-01T10:00:00.123Z";
  const wall = Date.parse(captured);
  db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
     VALUES ('e', 'm', ?, 0, '2026-11-01T10:00:00Z', 'Skills', '001', 'start', 0,
       '{"detail":"x","line":"x"}')`,
    [wall],
  );

  for (const [file, text] of [
    ["Skills/001-one.md", "a"],
    ["Skills/ctx-batch.md", "b"],
    ["Skills/done/001-one.md", "a"],
  ] as const)
    db.run(
      "INSERT INTO revisions (project, path, sha256, text, captured, machine) VALUES (?, ?, ?, ?, ?, 'm')",
      ["Skills", file, sha256(text), Buffer.from(text), captured],
    );

  db.run("PRAGMA user_version = 2");
  db.close();

  const store = openStore(path);
  const events = store.db
    .query("SELECT wall, counter, plan, payload FROM events WHERE type = 'revision' ORDER BY seq")
    .all() as { wall: number; counter: number; plan: string; payload: string }[];

  expect(events.map(({ wall: at, counter, plan }) => [at, counter, plan])).toEqual([
    [wall, 1, "001"],
    [wall, 2, "ctx-batch"],
    [wall, 3, "001"],
  ]);

  const [first, second, third] = events.map((event) => JSON.parse(event.payload));
  expect(second).toEqual({
    path: "Skills/ctx-batch.md",
    sha256: sha256("b"),
    captured,
    size: 1,
    blob: expect.stringMatching(/^[0-9a-f]{32}$/),
  });

  expect(third.blob).toBe(first.blob);
  expect(second.blob).not.toBe(first.blob);

  expect(store.db.query("SELECT count(*) AS n FROM blobs").get()).toEqual({ n: 2 });
  const columns = store.db.query("PRAGMA table_info(revisions)").all() as { name: string }[];
  expect(columns.map((column) => column.name)).not.toContain("text");
  store.db.close();
});

test("keeps the sync cursors and checkpoint in meta", async () => {
  const a = await fixture();
  const store = openStore(join(a, "plans.db"));
  try {
    expect(syncMeta(store)).toEqual({ pushed: 0, pulled: 0 } as SyncMeta);

    const checkpoint = { fingerprint: "f", head: "h", length: 3, epoch: 1 };
    setSyncMeta(store, { device: "d", pulledId: "e", checkpoint });

    expect(syncMeta(store)).toMatchObject({ device: "d", pulledId: "e", checkpoint });
    expect(store.machine).not.toBe("d");
  } finally {
    store.db.close();
  }

  await applyRemoteEvents(
    a,
    { events: [], blobs: [], meta: { pulled: 7, pulledId: "x" } },
    trusting,
  );

  const after = openStore(join(a, "plans.db"));
  expect(syncMeta(after)).toMatchObject({ pulled: 7, pulledId: "x" });
  after.db.close();
});

test("a replayed cutoff event cannot carry a forged predecessor", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const genuine = chained(machine, ["070", "071"]);
  const cutoff = { sequence: 2, hash: authoredHash(genuine[1]!) };

  const forged = sign(trailRecord(machine, Date.now() + 5, 0, "079"), 1, null);
  const replayed = sign(opened(genuine[1]!), 2, authoredHash(forged));
  expect(replayed.envelope).toEqual(genuine[1]!.envelope);

  const verifier = revoking(machine, cutoff);
  await applyRemoteEvents(a, { events: [forged, replayed], blobs: [] }, verifier);
  expect(quarantine(a, replayed.id)).toBe("revoked");
  expect(trailOf(a)).not.toContain("feat/071");

  await applyRemoteEvents(a, { events: genuine, blobs: [] }, verifier);
  expect(quarantine(a, forged.id)).toBe("revoked");
  expect(quarantine(a, genuine[1]!.id)).toBeNull();
  expect(trailOf(a)).not.toContain("feat/079");
  expect(trailOf(a)).toContain("feat/071");

  const db = new Database(join(a, "plans.db"), { readonly: true });
  const kept = db
    .query("SELECT count(*) AS n FROM events WHERE id LIKE ?")
    .get(`${genuine[1]!.id}/%`);

  db.close();
  expect(kept).toEqual({ n: 1 });
});

test("a malformed event keeps its ancestors on the committed chain", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const now = Date.now();
  const broken = trailRecord(machine, now + 1, 0, "081");
  const lying = {
    ...broken,
    payload: { detail: "feat/081", line: `${broken.ts}\tSkills\t001\tdone\tx` },
  };

  const events = chainOf([
    trailRecord(machine, now, 0, "080"),
    lying,
    trailRecord(machine, now + 2, 0, "082"),
  ]);

  const cutoff = { sequence: 3, hash: authoredHash(events[2]!) };

  await applyRemoteEvents(a, { events, blobs: [] }, revoking(machine, cutoff));
  expect(quarantine(a, events[0]!.id)).toBeNull();
  expect(quarantine(a, events[1]!.id)).toBe("malformed");
  expect(quarantine(a, events[2]!.id)).toBeNull();
  expect(trailOf(a)).not.toContain("\tdone\tx");
});

test("a verified delivery replaces one that failed its signature", async () => {
  const a = await fixture();
  const [event] = chained(crypto.randomUUID(), ["090"]);

  await applyRemoteEvents(
    a,
    { events: [{ ...event!, signature: new Uint8Array(32) }], blobs: [] },
    trusting,
  );

  expect(quarantine(a, event!.id)).toBe("signature");

  const applied = await applyRemoteEvents(a, { events: [event!], blobs: [] }, trusting);
  expect(applied.applied).toBe(1);
  expect(quarantine(a, event!.id)).toBeNull();
  expect(trailOf(a)).toContain("feat/090");
});

test("bad headers and names are quarantined without failing the batch", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const now = Date.now();
  const zero = sign(trailRecord(machine, now, 0, "100"), 0, null);

  const nul = { ...trailRecord(crypto.randomUUID(), now, 0, "101"), project: "Skills\u0000" };
  const named = sign(nul, 1, null);
  const [good] = chained(crypto.randomUUID(), ["102"]);
  const root = sign(
    { ...trailRecord(crypto.randomUUID(), now, 0, "103"), project: "plans.db" },
    1,
    null,
  );

  const late = { ...trailRecord(crypto.randomUUID(), now, 0, "104"), wall: 2 ** 48 };
  const far = sign(late, 1, null);
  const events = [zero, named, good!, root, far];

  const applied = await applyRemoteEvents(a, { events, blobs: [] }, trusting);
  expect(applied.quarantined.malformed).toBe(4);
  expect(applied.applied).toBe(1);
  expect(trailOf(a)).toContain("feat/102");
});

test("applies after a view was written but its record did not commit", async () => {
  const a = await fixture();
  await applyRemoteEvents(
    a,
    { events: chained(crypto.randomUUID(), ["110"]), blobs: [] },
    trusting,
  );

  const db = new Database(join(a, "plans.db"));
  db.run("UPDATE views SET current = 'stale', pending = 1 WHERE path = 'log.tsv'");
  db.close();

  await applyRemoteEvents(
    a,
    { events: chained(crypto.randomUUID(), ["111"]), blobs: [] },
    trusting,
  );

  expect(trailOf(a)).toContain("feat/111");
});

test("a revoked author folds nothing the committed chain does not prove", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const events = chained(machine, ["120", "121", "122"]);
  const verifier = revoking(machine, { sequence: 2, hash: authoredHash(events[1]!) });

  await applyRemoteEvents(a, { events: [events[0]!, events[2]!], blobs: [] }, verifier);
  expect(quarantine(a, events[0]!.id)).toBe("revoked");
  expect(quarantine(a, events[2]!.id)).toBe("revoked");
  expect(trailOf(a)).not.toContain("feat/120");

  await applyRemoteEvents(a, { events: [events[1]!], blobs: [] }, verifier);
  expect(quarantine(a, events[0]!.id)).toBeNull();
  expect(trailOf(a)).toContain("feat/120");
  expect(trailOf(a)).toContain("feat/121");
  expect(trailOf(a)).not.toContain("feat/122");
});

test("a revoked author is not refolded by an unrelated batch", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const events = chained(machine, ["130", "131"]);
  const verifier = revoking(machine, { sequence: 1, hash: authoredHash(events[0]!) });
  await applyRemoteEvents(a, { events, blobs: [] }, verifier);

  writeFileSync(join(a, "log.tsv"), `${trailOf(a)}hand edit\n`);
  const other = chained(crypto.randomUUID(), ["132"]);
  const db = new Database(join(a, "plans.db"));
  const before = db.query("SELECT count(*) AS n FROM cutoffs").get();
  db.close();

  expect(before).toEqual({ n: 1 });
  await expect(applyRemoteEvents(a, { events: other, blobs: [] }, verifier)).rejects.toThrow(
    "changed outside the store",
  );

  await expect(applyRemoteEvents(a, { events: [], blobs: [] }, verifier)).resolves.toMatchObject({
    applied: 0,
  });
});

test("a forged event below a gap in the committed chain never folds", async () => {
  const a = await fixture();
  const machine = crypto.randomUUID();
  const events = chained(machine, ["140", "141", "142"]);
  const forged = sign(trailRecord(machine, Date.now() + 9, 0, "149"), 1, null);
  const verifier = revoking(machine, { sequence: 3, hash: authoredHash(events[2]!) });

  await applyRemoteEvents(a, { events: [forged, events[2]!], blobs: [] }, verifier);
  expect(trailOf(a)).not.toContain("feat/149");
  expect(trailOf(a)).toContain("feat/142");

  await applyRemoteEvents(a, { events: [events[0]!, events[1]!], blobs: [] }, verifier);
  expect(trailOf(a)).toContain("feat/140");
  expect(trailOf(a)).toContain("feat/141");
  expect(trailOf(a)).not.toContain("feat/149");
});

test("a rejected event touches no view", async () => {
  const a = await fixture();
  const bad = { ...row("150", "bad"), id: "150" };
  const record: RemoteRecord = {
    id: Bun.randomUUIDv7(),
    machine: crypto.randomUUID(),
    wall: Date.now(),
    counter: 0,
    ts: "2026-11-08T00:00:00Z",
    project: "Elsewhere",
    plan: "150",
    type: "added",
    legacy: false,
    payload: { row: bad },
  };

  const invalid = sign(record, 0, null);
  writeFileSync(join(a, "log.tsv"), `${trailOf(a)}hand edit\n`);

  const applied = await applyRemoteEvents(a, { events: [invalid], blobs: [] }, trusting);
  expect(applied.quarantined.malformed).toBe(1);
  expect(existsSync(join(a, "Elsewhere"))).toBe(false);
});

test("the authored hash is core's event hash", async () => {
  const [first] = chained(crypto.randomUUID(), ["160"]);
  const second = sign(opened(first!), 2, authoredHash(first!), Bun.randomUUIDv7());
  for (const event of [first!, second]) {
    const core = {
      ...event,
      author: parseId(event.author),
      previous: Uint8Array.from(Buffer.from(event.previous, "hex")),
      envelope: new Uint8Array(event.envelope),
      signature: new Uint8Array(event.signature),
    };

    expect(hex(await eventHash(core))).toBe(authoredHash(event));
  }
});

type IssueVerb = (args: readonly string[], usage: string, io: Io) => Promise<number>;

async function issues(root: string, verb: IssueVerb, args: readonly string[]) {
  const io = capture(root);
  const code = await verb(args, "usage", io);
  return { code, stdout: io.stdout, stderr: io.stderr };
}

async function seeded(): Promise<string> {
  const root = await fixture();
  for (const n of [1, 2, 3, 4, 5]) await issues(root, fileVerb, ["Skills", `seed ${n}`]);
  return root;
}

function at(root: string, wall: number, verb: IssueVerb, args: readonly string[]) {
  setSystemTime(new Date(wall));
  return issues(root, verb, args);
}

async function syncAll(roots: readonly string[]): Promise<void> {
  const batches = roots.map(authored);
  for (const [target, root] of roots.entries())
    for (const [source, batch] of batches.entries())
      if (source !== target) await applyRemoteEvents(root, batch, trusting);
}

function eventIds(root: string): string[] {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    const rows = db.query("SELECT id FROM events ORDER BY id").all() as { id: string }[];
    return rows.map((one) => one.id);
  } finally {
    db.close();
  }
}

function stamp(wall: number): string {
  return new Date(wall).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function future(): number {
  return Math.ceil(Date.now() / 1000) * 1000 + 60_000;
}

function cli(root: string, args: readonly string[]) {
  const home = scratch();
  const bin = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
  const env = { ...suiteEnvironment(), PLANS_DIR: root, SKILLS_CONF: join(home, "skills.conf") };

  writeFileSync(join(home, "skills.conf"), "DELIVERY=hands-off\n");
  return runCommand([bin, ...args], { cwd: home, env, timeout: 60_000 });
}

async function frontierOf(root: string): Promise<{ ready: string[]; text: string }> {
  const run = await cli(root, ["plans", "frontier", "Skills"]);
  expect(run.code).toBe(0);
  const lines = run.stdout.split("\n");
  const ready = lines.slice(1, lines.indexOf("")).map((line) => line.split(" ")[0]!);
  return { ready, text: run.stdout };
}

function blockedBy(root: string, id: string): string | undefined {
  const lines = readFileSync(join(root, "Skills", "index.tsv"), "utf8").split("\n");
  const cells = lines.find((line) => line.startsWith(`${id}\t`))?.split("\t");
  return cells?.[COLUMNS.indexOf("blocked_by")];
}

test("each link and close follows its filing through sync and a renumber", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const wall = future();

  expect((await at(a, wall, fileVerb, ["Skills", "first"])).stdout).toBe("Skills#6\n");
  expect((await at(a, wall + 1000, closeVerb, ["Skills#6", "done"])).code).toBe(0);
  expect(
    (await at(b, wall + 60_000, fileVerb, ["Skills", "second", "--blocks", "Skills/002"])).stdout,
  ).toBe("Skills#6\n");

  const fromA = authored(a);
  const fromB = authored(b);
  await applyRemoteEvents(a, fromB, trusting);
  await applyRemoteEvents(b, fromA, trusting);
  setSystemTime();

  const second = ["second", "from -", `filed ${stamp(wall + 60_000)}`, "open", "blocks Skills/002"];
  const expected = [
    "Skills#6 conflict: first | second, run skills issues renumber Skills#6",
    "",
    "first",
    "from -",
    `filed ${stamp(wall)}`,
    "closed: done",
    "",
    ...second,
    "",
  ].join("\n");

  const sent = new Set([...fromA.events, ...fromB.events].map((event) => event.id));

  for (const root of [a, b]) {
    expect(await issues(root, showIssue, ["Skills#6"])).toEqual({
      code: 0,
      stdout: expected,
      stderr: "",
    });

    expect(eventIds(root).filter((id) => !sent.has(id))).toEqual([]);

    const frontier = await frontierOf(root);
    expect(frontier.ready).not.toContain("002");
    expect(frontier.text).toMatch(/^002 .* waits on Skills#6$/m);
  }

  expect((await at(a, wall + 120_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  await syncAll([a, b]);
  setSystemTime();

  for (const root of [a, b]) {
    expect((await issues(root, showIssue, ["Skills#7"])).stdout).toBe(`${second.join("\n")}\n\n`);
    expect((await issues(root, showIssue, ["Skills#6"])).stdout).toBe(
      `first\nfrom -\nfiled ${stamp(wall)}\nclosed: done\n\n`,
    );

    expect(blockedBy(root, "002")).toBe("Skills#7");
    expect(blockedBy(root, "001")).toBe("-");
  }

  expect((await at(a, wall + 180_000, closeVerb, ["Skills#7", "done"])).code).toBe(0);
  await syncAll([a, b]);
  setSystemTime();

  for (const root of [a, b]) expect((await frontierOf(root)).ready).toContain("002");
});

test("renumber keeps the old ref on a row a filing left behind also blocks", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const wall = future();

  await at(a, wall, fileVerb, ["Skills", "first", "--blocks", "Skills/002"]);
  await at(b, wall + 60_000, fileVerb, ["Skills", "second", "--blocks", "Skills/002"]);
  await syncAll([a, b]);

  expect((await at(a, wall + 120_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  setSystemTime();

  expect(blockedBy(a, "002")).toBe("Skills#6,Skills#7");
});

test("a row added apart from a renumber waits where its filing moved", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const wall = future();

  await at(a, wall, fileVerb, ["Skills", "first"]);
  await at(b, wall + 60_000, fileVerb, ["Skills", "second"]);
  await applyRemoteEvents(a, authored(b), trusting);

  expect((await at(a, wall + 120_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  expect((await at(a, wall + 180_000, closeVerb, ["Skills#6", "done"])).code).toBe(0);
  setSystemTime();

  expect((await cli(b, ["plans", "add", "Skills", "three", "P2", "S", "Skills#6", "-"])).code).toBe(
    0,
  );

  await syncAll([a, b]);

  for (const root of [a, b]) {
    const frontier = await frontierOf(root);
    expect(frontier.ready).not.toContain("003");
    expect(frontier.text).toMatch(/^003 .* waits on Skills#6$/m);
  }

  expect(await issues(a, linkVerb, ["Skills#7", "003"])).toMatchObject({
    code: 1,
    stderr: "issues link: Skills/003 waits on Skills#7, so it cannot resolve it\n",
  });

  expect(
    (await cli(a, ["plans", "set-row", "Skills", "003", "BLOCKED", "feat/three", "held"])).code,
  ).toBe(0);

  expect((await at(a, wall + 240_000, closeVerb, ["Skills#7", "done"])).code).toBe(0);
  setSystemTime();

  expect(readFileSync(join(a, "Skills", "index.tsv"), "utf8")).toMatch(
    /^003\tthree\tTODO\t.*\tunblocked by Skills#7$/m,
  );

  await syncAll([a, b]);
  setSystemTime();

  for (const root of [a, b]) expect((await frontierOf(root)).ready).toContain("003");
});

test("a second renumber keeps every filing a row waits on through its old number", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const c = fork(a, "c");
  const wall = future();

  await at(a, wall, fileVerb, ["Skills", "first"]);
  await at(b, wall + 60_000, fileVerb, ["Skills", "second"]);
  await applyRemoteEvents(a, authored(b), trusting);
  expect((await at(a, wall + 120_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  setSystemTime();

  const add = ["plans", "add", "Skills", "three", "P2", "S", "Skills#6", "-"];
  expect((await cli(b, add)).code).toBe(0);
  expect((await cli(c, ["plans", "add", "Skills", "three", "P2", "S", "-", "-"])).code).toBe(0);
  expect(
    (await at(c, wall + 90_000, fileVerb, ["Skills", "third", "--blocks", "Skills/003"])).stdout,
  ).toBe("Skills#6\n");

  await syncAll([a, b, c]);

  expect((await at(a, wall + 180_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#8\n");
  setSystemTime();

  expect(blockedBy(a, "003")).toBe("Skills#6,Skills#8");
  writeFileSync(join(a, "Skills", "003-three.md"), "# 003 three\n");
  expect((await cli(a, add)).stderr).toBe("");
  expect((await issues(a, showIssue, ["Skills#6"])).stdout).not.toContain("blocks Skills/003");
  expect((await issues(a, linkVerb, ["Skills#6", "003"])).stderr).toBe("");

  for (const n of [6, 8])
    expect((await at(a, wall + 200_000 + n, closeVerb, [`Skills#${n}`, "done"])).code).toBe(0);

  setSystemTime();
  expect((await frontierOf(a)).text).toMatch(/^003 .* waits on Skills#6$/m);

  expect((await at(a, wall + 240_000, closeVerb, ["Skills#7", "done"])).code).toBe(0);
  setSystemTime();
  expect((await frontierOf(a)).ready).toContain("003");
});

test("renumber moves the latest filing in event order, one per run", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const c = fork(a, "c");
  const wall = future();
  for (const [index, [root, title]] of [
    [a, "first"],
    [b, "second"],
    [c, "third"],
  ].entries())
    expect((await at(root!, wall + index * 60_000, fileVerb, ["Skills", title!])).stdout).toBe(
      "Skills#6\n",
    );

  await syncAll([a, b, c]);

  const later = wall + 180_000;
  expect((await at(a, later, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  expect((await at(a, later, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#8\n");

  await syncAll([a, b, c]);

  for (const root of [a, b, c])
    expect((await issues(root, showIssue, ["Skills#6"])).stdout).toBe(
      `first\nfrom -\nfiled ${stamp(wall)}\nopen\n\n`,
    );

  expect((await issues(c, listVerb, ["Skills"])).stdout.split("\n").slice(5)).toEqual([
    "Skills#6\topen\tfirst\t-",
    "Skills#7\topen\tthird\t-",
    "Skills#8\topen\tsecond\t-",
    "",
  ]);

  expect(await issues(b, renumberVerb, ["Skills#6"])).toEqual({
    code: 1,
    stdout: "",
    stderr: "issues renumber: Skills#6 has no conflict\n",
  });
});

async function filedApart(): Promise<{ a: string; b: string; wall: number; second: string }> {
  const a = await seeded();
  const b = fork(a, "b");
  const wall = future();

  await at(a, wall, fileVerb, ["Skills", "first"]);
  await at(b, wall + 60_000, fileVerb, ["Skills", "second", "--blocks", "Skills/002"]);
  await syncAll([a, b]);

  const second = `second\nfrom -\nfiled ${stamp(wall + 60_000)}\nopen\nblocks Skills/002\n\n`;
  return { a, b, wall, second };
}

test("a filing renumbered apart on two stores lands under one number", async () => {
  const { a, b, wall, second } = await filedApart();

  expect((await at(a, wall + 120_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  expect((await at(b, wall + 180_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  await syncAll([a, b]);
  setSystemTime();

  for (const root of [a, b]) {
    expect((await issues(root, showIssue, ["Skills#6"])).stdout).toBe(
      `first\nfrom -\nfiled ${stamp(wall)}\nopen\n\n`,
    );

    expect((await issues(root, showIssue, ["Skills#7"])).stdout).toBe(second);
    expect(blockedBy(root, "002")).toBe("Skills#7");
    expect(await issues(root, renumberVerb, ["Skills#7"])).toEqual({
      code: 1,
      stdout: "",
      stderr: "issues renumber: Skills#7 has no conflict\n",
    });
  }
});

test("a filing renumbered apart to two numbers lands under the later move's", async () => {
  for (const moved of [90_000, 150_000]) {
    const { a, b, wall, second } = await filedApart();

    expect((await at(b, wall + moved, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
    expect((await at(a, wall + 120_000, fileVerb, ["Skills", "other"])).stdout).toBe("Skills#7\n");

    expect((await at(a, wall + 180_000, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#8\n");
    await syncAll([a, b]);
    setSystemTime();

    for (const root of [a, b]) {
      expect((await issues(root, showIssue, ["Skills#7"])).stdout).toBe(
        `other\nfrom -\nfiled ${stamp(wall + 120_000)}\nopen\n\n`,
      );

      expect((await issues(root, showIssue, ["Skills#8"])).stdout).toBe(second);
      expect(blockedBy(root, "002")).toBe("Skills#8");
    }
  }
});

test("a ref filed twice refuses close, link, --resolves and blocked_by until renumbered", async () => {
  const a = await seeded();
  const b = fork(a, "b");
  const wall = future();

  await at(a, wall, fileVerb, ["Skills", "first"]);
  await at(b, wall + 60_000, fileVerb, ["Skills", "second"]);
  await applyRemoteEvents(a, authored(b), trusting);
  setSystemTime();

  const refusal = "Skills#6 is filed more than once, run skills issues renumber Skills#6 first";
  expect((await issues(a, closeVerb, ["Skills#6", "done"])).stderr).toBe(
    `issues close: ${refusal}\n`,
  );

  expect((await issues(a, linkVerb, ["Skills#6", "001"])).stderr).toBe(`issues link: ${refusal}\n`);

  const home = scratch();
  const bin = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
  const env = {
    ...suiteEnvironment(),
    PLANS_DIR: a,
    SKILLS_CONF: join(home, "skills.conf"),
  };

  writeFileSync(join(home, "skills.conf"), "DELIVERY=hands-off\n");
  const add = (args: readonly string[]) =>
    runCommand([bin, "plans", "add", "Skills", ...args], { cwd: home, env, timeout: 60_000 });

  const resolving = await add(["three", "P2", "S", "-", "-", "--resolves", "Skills#6"]);
  expect(resolving.code).toBe(1);
  expect(resolving.stderr).toContain(refusal);

  const blocked = await add(["four", "P2", "S", "Skills#6", "-"]);
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toBe(`blocked_by Skills#6: ${refusal}\n`);

  expect((await issues(a, renumberVerb, ["Skills#6"])).stdout).toBe("Skills#7\n");
  expect((await issues(a, closeVerb, ["Skills#6", "done"])).code).toBe(0);
});
