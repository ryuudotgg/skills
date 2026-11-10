import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { appendLog } from "../plans/commit.ts";
import { importStore } from "../plans/import.ts";
import { counts } from "../plans/outbox.ts";
import { appendEvent, openStore, write, type Store } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import { connect, type Fetch } from "./client.ts";
import { enrolled, init, invite, join as joinVault, settle, type Deps } from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { LONG_BUDGET, syncVerb } from "./sync.ts";

setDefaultTimeout(60_000);

const DAY = 24 * 60 * 60 * 1000;

const MIB = 1024 * 1024;

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Machine = { root: string; store: Store; deps: Deps; lines: string[] };

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function machine(seed: boolean, fetcher: Fetch = fetch): Promise<Machine> {
  const root = scratch("hub-files-");
  if (seed) {
    mkdirSync(join(root, "Skills", "done"), { recursive: true });
    const row = ["001", "one", "TODO", "P1", "S", "-", "-", "-", "2026-11-07", "-"].join("\t");
    writeFileSync(join(root, "Skills", "index.tsv"), `${COLUMNS.join("\t")}\n${row}\n`);
    writeFileSync(join(root, "log.tsv"), LOG_HEADER);
    writeFileSync(join(root, "Skills", "001-one.md"), "# 001 one\n");
  }

  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  cleanup.push(() => store.db.close());

  const lines: string[] = [];
  const deps: Deps = {
    store,
    keys: keyStore(
      { HOME: join(root, ".home"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline) => connect(url, "local", fetcher, undefined, deadline),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  return { root, store, deps, lines };
}

async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

async function sync(m: Machine, url: string): Promise<string[]> {
  m.lines.length = 0;
  await syncVerb(m.deps, url, { budget: LONG_BUDGET, publishQuarantine: false, quiet: false });
  return [...m.lines];
}

async function enroll(a: Machine, fixture: HubFixture, label: string, fetcher?: Fetch) {
  const joining = await machine(false, fetcher);
  await invite(a.deps, fixture.url, { label, lasts: DAY, wait: false });
  const line = (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";
  const settleInvites = async () =>
    void (await settle(a.deps, await enrolled(a.deps, fixture.url)));

  await joinVault({ ...joining.deps, sleep: settleInvites }, fixture.url, line);
  return joining;
}

async function pair(fixture: HubFixture, fetcher?: Fetch): Promise<{ a: Machine; b: Machine }> {
  const a = await machine(true);
  await appendLog("Skills", "001", "start", "feat/one", { PLANS_DIR: a.root });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");

  const b = await enroll(a, fixture, "B", fetcher);
  await sync(a, fixture.url);
  await sync(b, fixture.url);
  return { a, b };
}

function put(m: Machine, path: string, bytes: string | Uint8Array): void {
  mkdirSync(join(m.root, path, ".."), { recursive: true });
  writeFileSync(join(m.root, path), bytes);
}

function chunksOf(m: Machine, path: string): { sha256: string; locator: string }[] {
  return m.store.db
    .query(
      `SELECT c.sha256, c.locator FROM file_chunks c JOIN files f ON f.event = c.event
       WHERE f.path = ? AND f.machine = ? ORDER BY f.seq DESC, c.position`,
    )
    .all(path, m.store.machine) as { sha256: string; locator: string }[];
}

async function recorded(m: Machine, fixture: HubFixture, path: string) {
  const offline = { ...m.deps, connect: () => Promise.reject(new Error("offline")) };
  m.lines.length = 0;
  await syncVerb(offline, fixture.url, {
    budget: LONG_BUDGET,
    publishQuarantine: false,
    quiet: false,
  }).catch(() => {});

  return chunksOf(m, path);
}

function hubBlobs(fixture: HubFixture): number {
  const db = new Database(join(fixture.dir, "hub.db"));
  try {
    return (db.query("SELECT count(*) AS n FROM blobs").get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function landingState(m: Machine, path: string): string | null | undefined {
  const row = m.store.db
    .query("SELECT l.state FROM landings l JOIN files f ON f.event = l.event WHERE f.path = ?")
    .get(path) as { state: string | null } | null;

  return row === null ? undefined : row.state;
}

function fileRevision(path: string, size: number) {
  return {
    path,
    sha256: "0".repeat(64),
    captured: new Date().toISOString(),
    size,
    executable: false,
    chunks: [{ sha256: "1".repeat(64), blob: "2".repeat(32) }],
  };
}

test("refuses a path with .. or an absolute path", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);
  const outside = join(scratch("hub-escape-"), "escape.txt");

  write(a.store, () => {
    for (const path of ["Skills/../escape.txt", outside])
      appendEvent(a.store, {
        kind: "stored",
        type: "revision",
        at: Date.now(),
        project: "Skills",
        plan: "-",
        payload: fileRevision(path, 2),
      });
  });

  await sync(a, fixture.url);
  const lines = await sync(b, fixture.url);

  expect(lines).toContain(
    "refused path Skills/../escape.txt: the event names a path outside its project",
  );

  expect(lines).toContain(`refused path ${outside}: the event names a path outside its project`);
  expect(existsSync(join(b.root, "escape.txt"))).toBe(false);
  expect(existsSync(outside)).toBe(false);
});

test("never writes through a symlinked directory", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  const outside = scratch("hub-outside-");
  symlinkSync(outside, join(b.root, "Skills", "assets"));
  put(a, "Skills/assets/a.txt", "a\n");

  await sync(a, fixture.url);
  const lines = await sync(b, fixture.url);

  expect(lines).toContain("skipped symlink Skills/assets");
  expect(lines).toContain("refused path Skills/assets/a.txt: Skills/assets is a symlink here");
  expect(readdirSync(outside)).toEqual([]);
});

test("keeps a conflicting local file and records copy-conflict", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  put(a, "Skills/notes.txt", "base\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);
  expect(readFileSync(join(b.root, "Skills/notes.txt"), "utf8")).toBe("base\n");

  put(a, "Skills/notes.txt", "from A\n");
  put(b, "Skills/notes.txt", "from B, longer\n");
  await sync(a, fixture.url);

  expect(await sync(b, fixture.url)).toContain("conflict Skills/notes.txt, kept the local file");
  expect(readFileSync(join(b.root, "Skills/notes.txt"), "utf8")).toBe("from B, longer\n");

  const recorded = b.store.db
    .query(
      "SELECT json_extract(payload, '$.path') AS path FROM events WHERE type = 'copy-conflict'",
    )
    .all() as { path: string }[];

  expect(recorded).toEqual([{ path: "Skills/notes.txt" }]);
  expect(counts(b.store).conflicts).toBe(1);

  rmSync(join(b.root, "Skills/notes.txt"));
  await sync(b, fixture.url);
  expect(readFileSync(join(b.root, "Skills/notes.txt"), "utf8")).toBe("from A\n");
  expect(counts(b.store).conflicts).toBe(0);
});

test("re uploads only the changed chunk", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  const bytes = randomBytes(3 * MIB);
  put(a, "Skills/evidence/big.bin", bytes);
  expect((await sync(a, fixture.url)).at(-1)).toStartWith("pushed 1 events, 3 blobs");

  bytes[MIB + MIB / 2] = (bytes[MIB + MIB / 2]! + 1) % 256;
  put(a, "Skills/evidence/big.bin", bytes);
  expect((await sync(a, fixture.url)).at(-1)).toStartWith("pushed 1 events, 1 blobs");

  await sync(b, fixture.url);
  expect(readFileSync(join(b.root, "Skills/evidence/big.bin")).equals(bytes)).toBe(true);
});

test("drops a blob as gone only on a verified blob-deleted event", async () => {
  const fixture = await hub();
  let deletion = "";
  let forge = true;
  let locator = "";

  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    if (forge && init.method === "GET" && locator !== "" && path === `/v1/blobs/${locator}`) {
      const event = {
        id: deletion,
        author: "0".repeat(32),
        sequence: 1,
        previous: "0".repeat(64),
        envelope: Buffer.from("forged").toString("base64"),
        signature: Buffer.from("forged").toString("base64"),
      };

      return Response.json(
        { reason: "blob-deleted", message: "the blob was deleted", event },
        { status: 410 },
      );
    }

    const response = await fetch(url, init);
    if (path !== "/v1/events" || init.method !== "GET") return response;

    const body = (await response.json()) as { events: { id: string }[] };
    body.events = body.events.filter((event) => event.id !== deletion);
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: response.status, headers });
  };

  const { a, b } = await pair(fixture, fetcher);
  put(a, "Skills/gone.txt", "secret\n");
  await sync(a, fixture.url);

  const [chunk] = chunksOf(a, "Skills/gone.txt");
  locator = chunk!.locator;
  deletion = write(a.store, () =>
    appendEvent(a.store, {
      kind: "stored",
      type: "blob-deleted",
      at: Date.now(),
      project: "Skills",
      plan: "-",
      payload: { blob: locator },
    }),
  );

  await sync(a, fixture.url);
  const current = await enrolled(a.deps, fixture.url);
  await current.client.call("DELETE", `/v1/blobs/${locator}`, { event: deletion }, current.signer);

  await sync(b, fixture.url);
  expect(counts(b.store).fetching).toBe(1);
  expect(landingState(b, "Skills/gone.txt")).toBeNull();

  forge = false;
  await sync(b, fixture.url);
  expect(counts(b.store).fetching).toBe(0);
  expect(landingState(b, "Skills/gone.txt")).toBe("gone");
  expect(existsSync(join(b.root, "Skills/gone.txt"))).toBe(false);
});

test("refuses a chunk whose sha256 differs from its event", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  put(a, "Skills/c.txt", "genuine\n");
  const [chunk] = await recorded(a, fixture, "Skills/c.txt");
  write(a.store, () =>
    a.store.db.run("UPDATE blobs SET bytes = ? WHERE sha256 = ?", [
      new TextEncoder().encode("forged!\n"),
      chunk!.sha256,
    ]),
  );

  await sync(a, fixture.url);
  await sync(b, fixture.url);

  expect(existsSync(join(b.root, "Skills/c.txt"))).toBe(false);
  expect(b.store.db.query("SELECT 1 FROM blobs WHERE sha256 = ?").get(chunk!.sha256)).toBeNull();
  expect(counts(b.store).fetching).toBe(1);
});

test("retries a 404", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  put(a, "Skills/r.txt", "retry\n");
  await sync(a, fixture.url);

  const [chunk] = chunksOf(a, "Skills/r.txt");
  const db = new Database(join(fixture.dir, "hub.db"));
  const row = db
    .query("SELECT id, epoch, envelope FROM blobs WHERE id = ?")
    .get(chunk!.locator) as {
    id: string;
    epoch: number;
    envelope: Uint8Array;
  };

  db.run("DELETE FROM blobs WHERE id = ?", [row.id]);

  await sync(b, fixture.url);
  expect(existsSync(join(b.root, "Skills/r.txt"))).toBe(false);
  expect(counts(b.store).fetching).toBe(1);

  db.run("INSERT INTO blobs (id, epoch, envelope) VALUES (?, ?, ?)", [
    row.id,
    row.epoch,
    row.envelope,
  ]);

  db.close();

  await sync(b, fixture.url);
  expect(readFileSync(join(b.root, "Skills/r.txt"), "utf8")).toBe("retry\n");
  expect(counts(b.store).fetching).toBe(0);
});

test("uploads one file from two machines under two ids", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);
  const before = hubBlobs(fixture);

  put(a, "Skills/same.txt", "same bytes\n");
  put(b, "Skills/same.txt", "same bytes\n");

  expect((await sync(a, fixture.url)).at(-1)).toStartWith("pushed 1 events, 1 blobs");
  expect((await sync(b, fixture.url)).at(-1)).toBe(
    "pushed 1 events, 1 blobs, pulled 1 events, 0 blobs, conflicts 0",
  );

  expect(await sync(a, fixture.url)).toEqual([
    "pushed 0 events, 0 blobs, pulled 1 events, 0 blobs, conflicts 0",
  ]);

  expect(hubBlobs(fixture)).toBe(before + 2);
  expect(chunksOf(a, "Skills/same.txt")[0]!.locator).not.toBe(
    chunksOf(b, "Skills/same.txt")[0]!.locator,
  );
});

test("keeps a local revert the other side never saw", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);
  for (const text of ["x\n", "y\n"]) {
    put(a, "Skills/r.txt", text);
    await sync(a, fixture.url);
    await sync(b, fixture.url);
  }

  put(a, "Skills/r.txt", "z, from A\n");
  put(b, "Skills/r.txt", "x\n");
  await sync(a, fixture.url);

  expect(await sync(b, fixture.url)).toContain("conflict Skills/r.txt, kept the local file");
  expect(readFileSync(join(b.root, "Skills/r.txt"), "utf8")).toBe("x\n");
});

test("keeps a revert to bytes the other side branched from", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  put(a, "Skills/r.txt", "x\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  for (const text of ["y\n", "x\n"]) {
    put(b, "Skills/r.txt", text);
    await sync(b, fixture.url);
  }

  put(a, "Skills/r.txt", "z, from A\n");
  await sync(a, fixture.url);

  expect(await sync(b, fixture.url)).toContain("conflict Skills/r.txt, kept the local file");
  expect(readFileSync(join(b.root, "Skills/r.txt"), "utf8")).toBe("x\n");
});

test("records a conflict for an independent edit that ends on bytes the other side had", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);

  put(a, "Skills/r.txt", "x\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  put(a, "Skills/r.txt", "y\n");
  await recorded(a, fixture, "Skills/r.txt");

  for (const text of ["w\n", "y\n"]) {
    put(b, "Skills/r.txt", text);
    await recorded(b, fixture, "Skills/r.txt");
  }

  await Bun.sleep(5);
  put(a, "Skills/r.txt", "z, from A\n");
  await recorded(a, fixture, "Skills/r.txt");
  await sync(b, fixture.url);
  await sync(a, fixture.url);

  const [last] = b.store.db
    .query("SELECT event FROM files WHERE machine = ? ORDER BY seq DESC LIMIT 1")
    .all(b.store.machine) as { event: string }[];

  const c = await enroll(a, fixture, "C");
  await sync(a, fixture.url);
  await sync(c, fixture.url);

  const flagged = c.store.db
    .query(
      "SELECT json_extract(payload, '$.event') AS event FROM events WHERE type = 'copy-conflict'",
    )
    .all() as { event: string }[];

  expect(flagged.map((row) => row.event)).toContain(last!.event);
});

test("refuses a pulled file over the size cap", async () => {
  const fixture = await hub();
  const { a, b } = await pair(fixture);
  const chunk = { sha256: "1".repeat(64), blob: "2".repeat(32) };

  write(a.store, () =>
    appendEvent(a.store, {
      kind: "stored",
      type: "revision",
      at: Date.now(),
      project: "Skills",
      plan: "-",
      payload: {
        ...fileRevision("Skills/huge.bin", 129 * MIB),
        chunks: Array.from({ length: 129 }, () => chunk),
      },
    }),
  );

  await sync(a, fixture.url);
  expect(await sync(b, fixture.url)).toContain(
    "refused path Skills/huge.bin: the event does not validate",
  );
});
