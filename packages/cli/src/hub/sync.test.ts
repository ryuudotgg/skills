import { Database } from "bun:sqlite";
import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { COLUMNS, HEARTBEAT } from "skills-core";
import { appendLog, recordWorkingCopies, updateIndex } from "../plans/commit.ts";
import { walkFiles } from "../plans/files.ts";
import {
  backlog,
  counts,
  fetchCount,
  retriedUnder,
  savePace,
  savedPace,
  stop,
  storedEnvelopes,
  tombstone,
} from "../plans/outbox.ts";
import { appendEvent, locatorOf, openStore, sha256, write } from "../plans/store.ts";
import { applyRemoteEvents, syncMeta, type AuthoredEvent, type Verifier } from "../plans/sync.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import {
  runCleanup,
  cleanup,
  deletedOn,
  enroll,
  enrolledPair,
  hub,
  machine,
  simulatedWire,
  sync,
  syncedPair,
  type Link,
  type Machine,
  type Wire,
} from "../test/hub-machines.ts";
import { age, sessionsMachine, type SessionsMachine } from "../test/sessions-fixture.ts";
import { connect, HubRefusal, type Fetch } from "./client.ts";
import { enrolled, init, revoke, rotateRecovery, sentence, type Deps } from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { Offline, SYSTEM_CLOCK, type Clock } from "./network.ts";
import { Spent, wide } from "./run.ts";
import {
  LONG_BUDGET,
  reseed,
  shortSync,
  statusVerb,
  stopMessage,
  syncOnce,
  syncVerb,
} from "./sync.ts";

setDefaultTimeout(60_000);

afterEach(runCleanup);

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return sentence(error) ?? (error as Error).message;
  }

  throw new Error("the verb did not refuse");
}

function eventCount(m: Machine): number {
  return (m.store.db.query("SELECT count(*) AS n FROM events").get() as { n: number }).n;
}

async function addRow(m: Machine, id: string, slug: string): Promise<void> {
  await updateIndex(join(m.root, "Skills", "index.tsv"), (rows) => {
    rows.push({
      ...Object.fromEntries(COLUMNS.map((column) => [column, "-"])),
      id,
      slug,
      status: "TODO",
      pri: "P3",
      effort: "XS",
      updated: "2026-11-09",
    } as (typeof rows)[number]);
  });
}

async function edit(m: Machine, path: string, line: string): Promise<void> {
  appendFileSync(join(m.root, path), line);
  await recordWorkingCopies(m.root, [join(m.root, path)]);
}

test("a second machine pulls every event, blob, view and plan file", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);

  const pushed = await sync(a, fixture.url);
  const events = eventCount(a);
  expect(pushed.at(-1)).toBe(
    `pushed ${events} events, 2 blobs, pulled 0 events, 0 blobs, conflicts 0`,
  );

  expect(await sync(b, fixture.url)).toEqual([
    `pushed 0 events, 0 blobs, pulled ${events} events, 2 blobs, conflicts 0`,
  ]);

  for (const path of ["log.tsv", "Skills/index.tsv", "Skills/001-one.md", "Skills/ctx-x.md"])
    expect(readFileSync(join(b.root, path), "utf8")).toBe(readFileSync(join(a.root, path), "utf8"));

  expect(await sync(a, fixture.url)).toEqual([
    "pushed 0 events, 0 blobs, pulled 0 events, 0 blobs, conflicts 0",
  ]);
});

test("an edit on one side lands on the other, a concurrent edit conflicts on both", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  await edit(a, "Skills/001-one.md", "from A\n");
  await sync(a, fixture.url);
  expect(await sync(b, fixture.url)).toEqual([
    "landed Skills/001-one.md from A",
    "pushed 0 events, 0 blobs, pulled 1 events, 1 blobs, conflicts 0",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nfrom A\n");

  await edit(a, "Skills/001-one.md", "again A\n");
  await Bun.sleep(5);
  await edit(b, "Skills/001-one.md", "then B\n");
  await sync(a, fixture.url);

  const onB = await sync(b, fixture.url);
  expect(onB[0]).toBe("conflict Skills/001-one.md, run skills plans show --conflict Skills 001");

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toEndWith("then B\n");

  const onA = await sync(a, fixture.url);
  expect(onA[0]).toStartWith("conflict Skills/001-one.md");
  expect(readFileSync(join(a.root, "Skills/001-one.md"), "utf8")).toEndWith("again A\n");
  expect(counts(a.store).conflicts).toBe(1);
  expect(counts(a.store).queue).toBe(0);
});

test("a pulled close moves the working copy into done", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  renameSync(join(a.root, "Skills/001-one.md"), join(a.root, "Skills/done/001-one.md"));
  await edit(a, "Skills/done/001-one.md", "## Landed\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(readFileSync(join(b.root, "Skills/done/001-one.md"), "utf8")).toBe(
    "# 001 one\n## Landed\n",
  );
});

test("an edit saved while index.tsv is gone still reaches the other machine", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  rmSync(join(a.root, "Skills/index.tsv"));
  appendFileSync(join(a.root, "Skills/001-one.md"), "from A\n");

  expect(await sync(a, fixture.url)).toEqual([
    "pushed 1 events, 1 blobs, pulled 0 events, 0 blobs, conflicts 0",
  ]);

  expect(await sync(b, fixture.url)).toEqual([
    "landed Skills/001-one.md from A",
    "pushed 0 events, 0 blobs, pulled 1 events, 1 blobs, conflicts 0",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nfrom A\n");
});

function landingState(m: Machine, path: string): string | null | undefined {
  const row = m.store.db
    .query(
      `SELECT l.state FROM landings l
       JOIN revisions r ON r.event = l.event
       JOIN events e ON e.id = l.event
       WHERE r.path = ? ORDER BY e.wall DESC, e.counter DESC LIMIT 1`,
    )
    .get(path) as { state: string | null } | null;

  return row?.state;
}

function refusedLines(lines: readonly string[], path: string): string[] {
  return lines.filter((line) => line.startsWith(`refused path ${path}: `));
}

test("an edit saved while a revision lands survives", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  await edit(a, "Skills/001-one.md", "from A\n");
  await sync(a, fixture.url);

  const target = join(b.root, "Skills/001-one.md");
  b.deps = {
    ...b.deps,
    beforeRename: (path) => {
      if (path === target) writeFileSync(target, "saved on B\n");
    },
  };

  const lines = await sync(b, fixture.url);

  expect(readFileSync(target, "utf8")).toBe("saved on B\n");
  expect(refusedLines(lines, "Skills/001-one.md")).toEqual([
    "refused path Skills/001-one.md: it changed on disk while it landed",
  ]);

  expect(readdirSync(join(b.root, "Skills")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(landingState(b, "Skills/001-one.md")).toBeNull();
});

test("a done copy saved while a close lands survives", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  renameSync(join(a.root, "Skills/001-one.md"), join(a.root, "Skills/done/001-one.md"));
  await edit(a, "Skills/done/001-one.md", "## Landed\n");
  await sync(a, fixture.url);

  const target = join(b.root, "Skills/done/001-one.md");
  b.deps = {
    ...b.deps,
    beforeRename: (path) => {
      if (path === target) writeFileSync(target, "saved on B\n");
    },
  };

  const lines = await sync(b, fixture.url);

  expect(readFileSync(target, "utf8")).toBe("saved on B\n");
  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\n");
  expect(refusedLines(lines, "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: a done copy appeared while it landed",
  ]);

  expect(readdirSync(join(b.root, "Skills/done")).filter((name) => name.endsWith(".tmp"))).toEqual(
    [],
  );

  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

async function pulledClose(fixture: HubFixture, a: Machine, b: Machine): Promise<void> {
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  renameSync(join(a.root, "Skills/001-one.md"), join(a.root, "Skills/done/001-one.md"));
  await edit(a, "Skills/done/001-one.md", "## Landed\n");
  await sync(a, fixture.url);
}

test("a close left halfway finishes on the next sync", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  mkdirSync(join(b.root, "Skills/done"), { recursive: true });
  writeFileSync(join(b.root, "Skills/done/001-one.md"), "# 001 one\n## Landed\n");

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([]);
  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(readFileSync(join(b.root, "Skills/done/001-one.md"), "utf8")).toBe(
    "# 001 one\n## Landed\n",
  );

  expect(landingState(b, "Skills/done/001-one.md")).toBe("landed");
});

test("an open copy edited after a close stays and is refused", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  mkdirSync(join(b.root, "Skills/done"), { recursive: true });
  writeFileSync(join(b.root, "Skills/done/001-one.md"), "# 001 one\n## Landed\n");
  writeFileSync(join(b.root, "Skills/001-one.md"), "# 001 one\nsaved on B\n");

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test("an open copy saved while a close creates its done copy is refused", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  const open = join(b.root, "Skills/001-one.md");
  rmSync(open);
  b.deps = {
    ...b.deps,
    beforeRename: (path) => {
      if (path === join(b.root, "Skills/done/001-one.md")) writeFileSync(open, "new on B\n");
    },
  };

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(open, "utf8")).toBe("new on B\n");
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test("an open copy saved while a close clears it survives", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  const open = join(b.root, "Skills/001-one.md");
  mkdirSync(join(b.root, "Skills/done"), { recursive: true });
  writeFileSync(join(b.root, "Skills/done/001-one.md"), "# 001 one\n## Landed\n");
  b.deps = {
    ...b.deps,
    beforeRename: (path) => {
      if (path === open) writeFileSync(open, "new on B\n");
    },
  };

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy was saved again while it landed",
  ]);

  expect(readFileSync(open, "utf8")).toBe("new on B\n");
  expect(readdirSync(join(b.root, "Skills")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

async function killedAfterSetAside(fixture: HubFixture, a: Machine, b: Machine): Promise<string> {
  await pulledClose(fixture, a, b);

  const open = join(b.root, "Skills/001-one.md");
  const { deps } = b;
  let aside: string | undefined;
  b.deps = {
    ...deps,
    beforeRename: (path) => {
      if (path !== open) return;
      aside = readdirSync(join(b.root, "Skills")).find((name) => name.endsWith(".tmp"));
      throw new Error("killed after the set aside");
    },
  };

  await sync(b, fixture.url);
  b.deps = deps;

  if (aside === undefined) throw new Error("the dead sync left no aside");
  return join(b.root, "Skills", aside);
}

function everyRefusal(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith("refused path "));
}

function temporaryNames(m: Machine): string[] {
  return readdirSync(join(m.root, "Skills")).filter((name) => name.endsWith(".tmp"));
}

test("an open copy set aside by a dead sync comes back", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");

  expect(readFileSync(join(b.root, "Skills/done/001-one.md"), "utf8")).toBe(
    "# 001 one\n## Landed\n",
  );

  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(temporaryNames(b)).toEqual([]);
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test("a set aside copy the close holds is cleared", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  expect(readFileSync(aside, "utf8")).toBe("# 001 one\n");

  expect(everyRefusal(await sync(b, fixture.url))).toEqual([]);
  expect(landingState(b, "Skills/done/001-one.md")).toBe("landed");
  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(temporaryNames(b)).toEqual([]);
});

test("an aside beside a fresh open copy keeps both", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");

  const open = join(b.root, "Skills/001-one.md");
  writeFileSync(open, "new on B\n");

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    `refused path Skills/done/001-one.md: the open copy was saved again while it landed, kept ${basename(aside)}`,
  ]);

  expect(readFileSync(open, "utf8")).toBe("new on B\n");
  expect(readFileSync(aside, "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test("two asides for one open copy stay", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");

  const second = join(
    dirname(aside),
    basename(aside).replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/, randomUUID()),
  );

  expect(second).not.toBe(aside);
  writeFileSync(second, "# 001 one\nsaved twice\n");

  const kept = [basename(aside), basename(second)].sort().join(", ");
  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    `refused path Skills/done/001-one.md: the open copy was set aside more than once, kept ${kept}`,
  ]);

  expect(readFileSync(aside, "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(readFileSync(second, "utf8")).toBe("# 001 one\nsaved twice\n");
  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test("an aside linked to the open copy is cleared", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");

  const open = join(b.root, "Skills/001-one.md");
  linkSync(aside, open);

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(open, "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(temporaryNames(b)).toEqual([]);
});

test("a done copy edited after a dead sync still brings the aside back", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");
  appendFileSync(join(b.root, "Skills/done/001-one.md"), "noted on B\n");

  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toEqual([
    "refused path Skills/done/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(temporaryNames(b)).toEqual([]);
});

test("a staged write beside a closing plan is no aside", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  const staged = join(b.root, `Skills/001-one.md.${process.pid}.${randomUUID()}.tmp`);
  const named = join(b.root, "Skills/001-one.md.aside.bak");
  writeFileSync(staged, "staged by a landing that died\n");
  writeFileSync(named, "kept by hand\n");

  expect(everyRefusal(await sync(b, fixture.url))).toEqual([]);
  expect(landingState(b, "Skills/done/001-one.md")).toBe("landed");
  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(readFileSync(staged, "utf8")).toBe("staged by a landing that died\n");
  expect(readFileSync(named, "utf8")).toBe("kept by hand\n");
});

test("an aside comes back when a reopen lands instead of the close", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const aside = await killedAfterSetAside(fixture, a, b);
  writeFileSync(aside, "# 001 one\nsaved on B\n");

  renameSync(join(a.root, "Skills/done/001-one.md"), join(a.root, "Skills/001-one.md"));
  await edit(a, "Skills/001-one.md", "reopened on A\n");
  await sync(a, fixture.url);

  expect(everyRefusal(await sync(b, fixture.url))).toEqual([
    "refused path Skills/001-one.md: the open copy holds an edit the close does not",
  ]);

  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\nsaved on B\n");
  expect(temporaryNames(b)).toEqual([]);
});

test("a pulled close keeps the open copy's mode", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await pulledClose(fixture, a, b);

  chmodSync(join(b.root, "Skills/001-one.md"), 0o664);
  await sync(b, fixture.url);

  expect(existsSync(join(b.root, "Skills/001-one.md"))).toBe(false);
  expect(statSync(join(b.root, "Skills/done/001-one.md")).mode & 0o777).toBe(0o664);
});

test("a landed edit keeps the copy's mode", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  const copy = join(b.root, "Skills/001-one.md");
  chmodSync(copy, 0o664);

  await edit(a, "Skills/001-one.md", "from A\n");
  await sync(a, fixture.url);
  expect(await sync(b, fixture.url)).toContain("landed Skills/001-one.md from A");

  expect(readFileSync(copy, "utf8")).toBe(readFileSync(join(a.root, "Skills/001-one.md"), "utf8"));
  expect(statSync(copy).mode & 0o777).toBe(0o664);
});

test("a copy that cannot land is refused", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  renameSync(join(a.root, "Skills/001-one.md"), join(a.root, "Skills/done/001-one.md"));
  await edit(a, "Skills/done/001-one.md", "## Landed\n");
  await edit(a, "Skills/ctx-x.md", "from A\n");
  await sync(a, fixture.url);

  rmSync(join(b.root, "Skills/done"), { recursive: true, force: true });
  writeFileSync(join(b.root, "Skills/done"), "not a folder\n");

  const first = await sync(b, fixture.url);
  expect(refusedLines(first, "Skills/done/001-one.md")).toHaveLength(1);
  expect(first).toContain("landed Skills/ctx-x.md from A");
  expect(refusedLines(await sync(b, fixture.url), "Skills/done/001-one.md")).toHaveLength(1);
  expect(landingState(b, "Skills/done/001-one.md")).toBeNull();
});

test.skipIf(process.getuid?.() === 0)(
  "an unreadable copy is refused, not created over",
  async () => {
    const fixture = await hub();
    const { a, b } = await enrolledPair(fixture);
    await sync(a, fixture.url);
    await sync(b, fixture.url);

    const target = join(b.root, "Skills/001-one.md");
    const before = readFileSync(target);
    chmodSync(target, 0o000);

    await edit(a, "Skills/001-one.md", "from A\n");
    await sync(a, fixture.url);
    const refused = refusedLines(await sync(b, fixture.url), "Skills/001-one.md");

    expect(refused).toHaveLength(1);
    expect(refused[0]).toContain("EACCES");
    expect(statSync(target).mode & 0o777).toBe(0o000);
    chmodSync(target, 0o644);
    expect(readFileSync(target)).toEqual(before);
  },
);

test("a copied store stops at the hub's sequence refusal", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  await sync(a, fixture.url);

  const copy = await machine(undefined, a.root);
  copy.store.db.close();
  copy.store = openStore(join(copy.root, "plans.db"));
  copy.deps = { ...copy.deps, store: copy.store, keys: a.deps.keys };

  await addRow(a, "003", "three");
  await addRow(copy, "003", "other");
  await sync(a, fixture.url);

  expect(await refusal(sync(copy, fixture.url))).toBe(stopMessage("A"));
});

test("a restored hub reconciles, a replaced one reseeds", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  await fixture.restart({ restored: true });
  expect((await sync(a, fixture.url)).at(-1)).toBe("reconciled");
  expect(counts(a.store).queue).toBe(0);

  await fixture.stop();
  const fresh = await startHubFixture();
  cleanup.push(() => fresh.stop());

  a.lines.length = 0;
  await init(a.deps, fresh.url, fresh.initCode ?? "", "A");
  await reseed(a.deps, fresh.url);
  expect(a.lines.at(-1)).toMatch(/^reseeded, \d+ events, 2 blobs$/);

  expect((await sync(b, fresh.url)).at(-1)).toBe("reconciled");
});

test("a restored hub restores tombstones together", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);

  const texts = ["a", "b", "c"].map((name) => `# ctx-${name}\n`);
  const paths = ["a", "b", "c"].map((name) => join(a.root, "Skills", `ctx-${name}.md`));
  paths.forEach((path, index) => writeFileSync(path, texts[index] ?? ""));
  await recordWorkingCopies(a.root, paths);
  await sync(a, fixture.url);

  const saved = mkdtempSync(join(tmpdir(), "hub-saved-"));
  cleanup.push(() => rmSync(saved, { recursive: true, force: true }));
  await fixture.restart({ stopped: (dir) => cpSync(dir, saved, { recursive: true }) });

  const locators = texts.map((text) => locatorOf(a.store, sha256(text)));
  write(a.store, () => tombstone(a.store, "Skills", locators));
  expect(await sync(a, fixture.url)).toContain("deleted 3 blobs");

  await fixture.restart({
    restored: true,
    stopped: (dir) => {
      rmSync(dir, { recursive: true });
      cpSync(saved, dir, { recursive: true });
    },
  });

  expect(await deletedOn(a, fixture.url, locators)).toEqual([]);

  const flight = { now: 0, most: 0 };
  const tracked = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.method !== "DELETE" || !new URL(request.url).pathname.startsWith("/v1/blobs/"))
      return fetch(request);

    flight.now++;
    flight.most = Math.max(flight.most, flight.now);

    try {
      await Bun.sleep(50);
      return await fetch(request);
    } finally {
      flight.now--;
    }
  }) as typeof fetch;

  const restoring = {
    ...a,
    deps: {
      ...a.deps,
      connect: (url: string, deadline?: number) =>
        connect(url, "local", tracked, undefined, deadline),
    },
  };

  expect((await sync(restoring, fixture.url)).at(-1)).toBe("reconciled");
  expect(flight.most).toBeGreaterThanOrEqual(2);
  expect(await deletedOn(a, fixture.url, locators)).toEqual(locators.toSorted());
});

test("a revoked device holds its outbox until it publishes it under a new enrollment", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  const bId = b.store.db.query("SELECT value FROM meta WHERE key = 'device'").get() as {
    value: string;
  };

  await revoke(a.deps, fixture.url, bId.value);
  expect((await sync(a, fixture.url))[0]).toBe("device B revoked by A");
  expect(await sync(a, fixture.url)).toHaveLength(1);

  await addRow(b, "003", "held");
  expect(await refusal(sync(b, fixture.url))).toStartWith("the hub refuses this device as revoked");
  expect(counts(b.store)).toMatchObject({ queue: 0, quarantined: 1 });

  await enroll(a, b, fixture, "B2");
  expect((await sync(b, fixture.url))[0]).toBe(
    "quarantined 1 events wait, run skills hub sync --publish-quarantine to publish them",
  );

  expect((await sync(b, fixture.url, true))[0]).toBe("published 1 quarantined events");
  expect(counts(b.store)).toMatchObject({ queue: 0, quarantined: 0 });

  await sync(a, fixture.url);
  expect(readFileSync(join(a.root, "Skills/index.tsv"), "utf8")).toContain("003\theld");
});

function over(m: Machine, fetcher: Fetch): Machine {
  const connecting: Deps["connect"] = (url, deadline, clock) =>
    connect(url, "local", fetcher, undefined, deadline, clock);

  return { ...m, deps: { ...m.deps, connect: connecting } };
}

type HeldPuts = { machine: Machine; refused: number; later: string[]; revoked?: Promise<unknown> };

function holdPuts(m: Machine, passed: number, revoking: () => Promise<void>): HeldPuts {
  const waiting: (() => void)[] = [];
  let puts = 0;
  let landed = false;

  const fetcher: Fetch = async (url, init) => {
    const path = new URL(url).pathname;
    const put = init.method === "PUT" && path.startsWith("/v1/blobs/");
    if (landed) held.later.push(`${init.method} ${path}`);
    else if (put && ++puts > passed) {
      const gate = Promise.withResolvers<void>();
      waiting.push(gate.resolve);

      if (waiting.length === 2)
        held.revoked = revoking()
          .catch((error: unknown) => error)
          .finally(() => {
            landed = true;
            for (const release of waiting) release();
          });

      await gate.promise;
    }

    const response = await fetch(url, init);
    if (put && response.status === 409) {
      const body = (await response.clone().json()) as { reason?: string };
      if (body.reason === "epoch-below-current") held.refused++;
    }

    return response;
  };

  const held: HeldPuts = { machine: over(m, fetcher), refused: 0, later: [] };
  return held;
}

function refreshesBeforeLastPut(held: HeldPuts): number {
  const last = held.later.findLastIndex((request) => request.startsWith("PUT /v1/blobs/"));
  return held.later.slice(0, last).filter((request) => request === "GET /v1/membership").length;
}

function hubBlobs(fixture: HubFixture): Map<string, number> {
  const db = new Database(join(fixture.dir, "hub.db"), { readonly: true });
  try {
    const rows = db.query("SELECT id, epoch FROM blobs").all() as { id: string; epoch: number }[];
    return new Map(rows.map((row) => [row.id, row.epoch]));
  } finally {
    db.close();
  }
}

function noteFiles(m: Machine, count: number): Map<string, string> {
  mkdirSync(join(m.root, "Skills", "notes"));

  const notes = new Map<string, string>();
  for (let index = 0; index < count; index++) {
    const path = join("Skills", "notes", `${index}.md`);
    notes.set(path, `note ${index} of ${m.root}\n`);
    writeFileSync(join(m.root, path), notes.get(path) ?? "");
  }

  return notes;
}

const LONG = { budget: LONG_BUDGET, publishQuarantine: false, quiet: false } as const;

test("a device revoked mid flush leaves every later blob sealed under the new epoch", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const c = await machine();
  await enroll(a, c, fixture, "C");
  await sync(a, fixture.url);

  const notes = noteFiles(a, 10);
  let stored = new Map<string, number>();
  const held = holdPuts(a, 1, async () => {
    await revoke(b.deps, fixture.url, syncMeta(c.store).device ?? "");
    stored = hubBlobs(fixture);
  });

  expect(await syncVerb(held.machine.deps, fixture.url, LONG)).toBe(0);
  expect(await held.revoked).toBeUndefined();
  expect(held.refused).toBeGreaterThanOrEqual(2);
  expect(refreshesBeforeLastPut(held)).toBe(1);

  const later = [...hubBlobs(fixture)].filter(([id]) => !stored.has(id));
  expect(later.map(([, epoch]) => epoch)).toEqual(Array.from({ length: 9 }, () => 2));

  await sync(b, fixture.url);
  for (const [path, text] of notes) expect(readFileSync(join(b.root, path), "utf8")).toBe(text);
});

test("a device revoked mid reupload leaves every blob sealed under the new epoch", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const c = await machine();
  await enroll(a, c, fixture, "C");

  const saved = mkdtempSync(join(tmpdir(), "hub-saved-"));
  cleanup.push(() => rmSync(saved, { recursive: true, force: true }));
  await fixture.restart({ stopped: (dir) => cpSync(dir, saved, { recursive: true }) });

  const notes = noteFiles(a, 4);
  await sync(a, fixture.url);
  const pushed = hubBlobs(fixture).size;

  await fixture.restart({
    restored: true,
    stopped: (dir) => {
      rmSync(dir, { recursive: true });
      cpSync(saved, dir, { recursive: true });
    },
  });

  const held = holdPuts(a, 0, () => revoke(b.deps, fixture.url, syncMeta(c.store).device ?? ""));

  a.lines.length = 0;
  expect(await syncVerb(held.machine.deps, fixture.url, LONG)).toBe(0);
  expect(a.lines.at(-1)).toBe("reconciled");

  expect(await held.revoked).toBeUndefined();
  expect(held.refused).toBeGreaterThanOrEqual(2);
  expect(refreshesBeforeLastPut(held)).toBe(1);
  expect([...hubBlobs(fixture).values()]).toEqual(Array.from({ length: pushed }, () => 2));

  await sync(b, fixture.url);
  for (const [path, text] of notes) expect(readFileSync(join(b.root, path), "utf8")).toBe(text);
  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toBe("# 001 one\n");
});

test("a blob refused for its epoch twice ends the run and stays queued", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const c = await machine();
  await enroll(a, c, fixture, "C");

  await sync(a, fixture.url);
  noteFiles(a, 1);

  const requests: string[] = [];
  const rotations = [
    () => revoke(b.deps, fixture.url, syncMeta(c.store).device ?? ""),
    () => rotateRecovery(b.deps, fixture.url),
  ];

  const rotating: Fetch = async (url, init) => {
    const put = init.method === "PUT";
    if (put) await rotations.shift()?.();

    requests.push(put ? "PUT" : `${init.method} ${new URL(url).pathname}`);
    return fetch(url, init);
  };

  expect(await refusal(syncVerb(over(a, rotating).deps, fixture.url, LONG))).toBe(
    "the hub refused this device's epoch, run skills hub sync again",
  );

  const [first, second] = [requests.indexOf("PUT"), requests.lastIndexOf("PUT")];
  expect(requests.filter((request) => request === "PUT")).toHaveLength(2);
  expect(requests.slice(first, second)).toEqual(["PUT", "GET /v1/membership"]);
  expect(hubBlobs(fixture).size).toBe(2);
  expect(backlog(a.store, syncMeta(a.store).device ?? "", []).blobs).toBe(1);
});

test("an edit on top of an unresolved conflict still conflicts on the other side", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  await edit(b, "Skills/001-one.md", "B one\n");
  await Bun.sleep(5);
  await edit(a, "Skills/001-one.md", "A one\n");

  await sync(b, fixture.url);
  await sync(a, fixture.url);
  expect((await sync(b, fixture.url))[0]).toStartWith("conflict Skills/001-one.md");

  await edit(b, "Skills/001-one.md", "B two\n");
  await sync(b, fixture.url);
  expect((await sync(a, fixture.url))[0]).toStartWith("conflict Skills/001-one.md");
  expect(readFileSync(join(a.root, "Skills/001-one.md"), "utf8")).toEndWith("A one\n");
});

test("a long run of edits lands on a machine that stayed on the first bytes", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  for (let index = 0; index < 300; index++) await edit(a, "Skills/001-one.md", `${index}\n`);
  await sync(a, fixture.url);

  expect((await sync(b, fixture.url))[0]).toBe("landed Skills/001-one.md from A");
  expect(readFileSync(join(b.root, "Skills/001-one.md"), "utf8")).toEndWith("299\n");
});

test("a file created on both machines conflicts on both", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  writeFileSync(join(a.root, "Skills/ctx-y.md"), "# made on A\n");
  await recordWorkingCopies(a.root, [join(a.root, "Skills/ctx-y.md")]);
  await Bun.sleep(5);
  writeFileSync(join(b.root, "Skills/ctx-y.md"), "# made on B\n");
  await recordWorkingCopies(b.root, [join(b.root, "Skills/ctx-y.md")]);

  await sync(a, fixture.url);
  expect((await sync(b, fixture.url))[0]).toStartWith("conflict Skills/ctx-y.md");
  expect((await sync(a, fixture.url))[0]).toStartWith("conflict Skills/ctx-y.md");
  expect(readFileSync(join(a.root, "Skills/ctx-y.md"), "utf8")).toBe("# made on A\n");
});

test("a third machine lands the newest of two concurrent edits and flags the other", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const c = await machine();
  await enroll(a, c, fixture, "C");
  for (const m of [a, b, c]) await sync(m, fixture.url);

  await edit(a, "Skills/001-one.md", "from A\n");
  await Bun.sleep(5);
  await edit(b, "Skills/001-one.md", "from B\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  const onC = await sync(c, fixture.url);
  expect(onC).toContain("landed Skills/001-one.md from B");
  expect(onC).toContain("conflict Skills/001-one.md, run skills plans show --conflict Skills 001");
  expect(readFileSync(join(c.root, "Skills/001-one.md"), "utf8")).toEndWith("from B\n");
});

const BLIND: Verifier = { open: async () => undefined, cutoff: () => undefined };

type Unopened = { a: Machine; b: Machine; events: AuthoredEvent[] };

async function unopenedFromThird(
  fixture: HubFixture,
  damage: (events: AuthoredEvent[]) => AuthoredEvent[] = (events) => events,
): Promise<Unopened> {
  const { a, b } = await syncedPair(fixture);
  const c = await machine();
  await enroll(a, c, fixture, "C");
  await sync(c, fixture.url);

  await addRow(c, "003", "from-c");
  await addRow(c, "004", "late-from-c");
  await sync(c, fixture.url);
  await sync(a, fixture.url);

  const events = storedEnvelopes(a.store, syncMeta(c.store).device ?? "", 0, 500);
  const { pulled, pulledId } = syncMeta(a.store);
  await applyRemoteEvents(
    b.root,
    { events: damage(events), blobs: [], meta: { pulled, pulledId } },
    BLIND,
  );

  return { a, b, events };
}

function unopenedIds(m: Machine): string[] {
  const rows = m.store.db
    .query(
      "SELECT id FROM events WHERE quarantined = 'signature' AND id NOT LIKE '%/superseded/%' ORDER BY id",
    )
    .all() as { id: string }[];

  return rows.map((row) => row.id);
}

function indexOf(m: Machine): string {
  return readFileSync(join(m.root, "Skills/index.tsv"), "utf8");
}

test("an event from a device this machine did not know yet folds", async () => {
  const fixture = await hub();
  const { b, events } = await unopenedFromThird(fixture);
  expect(unopenedIds(b)).toEqual(events.map((event) => event.id).toSorted());
  expect(indexOf(b)).not.toContain("003\tfrom-c");
  expect(retriedUnder(b.store)).toBeDefined();

  const { pulled } = syncMeta(b.store);
  await sync(b, fixture.url);

  expect(syncMeta(b.store).pulled).toBe(pulled);
  expect(unopenedIds(b)).toEqual([]);
  expect(indexOf(b)).toContain("003\tfrom-c");
  expect(indexOf(b)).toContain("004\tlate-from-c");
});

type Damaged = { a: Machine; b: Machine; damaged: AuthoredEvent };

async function unopenedWithLastDamaged(fixture: HubFixture): Promise<Damaged> {
  const flipped = (envelope: Uint8Array) =>
    envelope.map((byte, at, all) => (at === all.length - 1 ? byte ^ 1 : byte));

  const { a, b, events } = await unopenedFromThird(fixture, (all) =>
    all.map((event, at) =>
      at === all.length - 1 ? { ...event, envelope: flipped(event.envelope) } : event,
    ),
  );

  return { a, b, damaged: events.at(-1) as AuthoredEvent };
}

function restoreEnvelope(m: Machine, event: AuthoredEvent): void {
  write(m.store, () =>
    m.store.db.run("UPDATE events SET envelope = ? WHERE id = ?", [event.envelope, event.id]),
  );
}

test("an unopened event is retried only when the chain changed", async () => {
  const fixture = await hub();
  const { a, b, damaged } = await unopenedWithLastDamaged(fixture);
  const superseded = () =>
    b.store.db
      .query("SELECT count(*) AS n FROM events WHERE id LIKE ?")
      .get(`${damaged.id}/superseded/%`) as { n: number };

  const afterJoin = await sync(b, fixture.url);

  expect(unopenedIds(b)).toEqual([damaged.id]);
  expect(superseded().n).toBe(0);
  expect(afterJoin.filter((line) => /^refused \d+ events/.test(line))).toEqual([]);
  expect(indexOf(b)).toContain("003\tfrom-c");
  expect(indexOf(b)).not.toContain("004\tlate-from-c");

  restoreEnvelope(b, damaged);
  await sync(b, fixture.url);
  expect(unopenedIds(b)).toEqual([damaged.id]);

  await enroll(a, await machine(), fixture, "D");
  await sync(b, fixture.url);
  expect(unopenedIds(b)).toEqual([]);
  expect(indexOf(b)).toContain("004\tlate-from-c");
});

test("a store with no retry record retries on its first sync", async () => {
  const fixture = await hub();
  const { b, damaged } = await unopenedWithLastDamaged(fixture);
  await sync(b, fixture.url);

  restoreEnvelope(b, damaged);
  write(b.store, () => b.store.db.run("DELETE FROM meta WHERE key = 'hub_retried'"));
  await sync(b, fixture.url);

  expect(unopenedIds(b)).toEqual([]);
  expect(indexOf(b)).toContain("004\tlate-from-c");
});

function hubEnv(m: Machine, url: string | undefined): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: join(m.root, ".home"),
    HUB_KEYS: "file",
    HUB_NETWORK: "local",
    PLANS_DIR: m.root,
    SKILLS_CONF: join(m.root, "skills.conf"),
    ...(url === undefined ? {} : { HUB_URL: url }),
  };
}

async function statusLines(m: Machine, url: string): Promise<string[]> {
  m.lines.length = 0;
  await statusVerb(m.deps, url, "local");
  return [...m.lines];
}

test("shortSync reports the facts skills hub status prints, and its offline reason once the hub stops", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const url = fixture.url;

  expect(await shortSync(hubEnv(a, url))).toEqual({ kind: "synced", tally: undefined });

  const synced = await shortSync(hubEnv(a, url), true);
  if (synced.kind !== "synced" || synced.tally === undefined)
    throw new Error(`no tally: ${JSON.stringify(synced)}`);

  expect(synced.tally).toMatchObject({ queue: 0, conflicts: 0, reconciled: undefined });
  expect(await statusLines(a, url)).toEqual(
    expect.arrayContaining(["queue 0", "conflicts 0", `last sync ${synced.tally.lastSync}`]),
  );

  await fixture.stop();
  const offline = await shortSync(hubEnv(a, url), true);
  if (offline.kind !== "offline") throw new Error(`not offline: ${JSON.stringify(offline)}`);

  expect(await statusLines(a, url)).toContain(`offline: ${offline.reason}`);
});

test("status lists a copy conflict a quiet sync recorded", async () => {
  const fixture = await hub();
  const { a, b } = await syncedPair(fixture);

  writeFileSync(join(a.root, "Skills/notes.txt"), "base\n");
  await sync(a, fixture.url);
  await sync(b, fixture.url);

  await edit(a, "Skills/001-one.md", "from A\n");
  await Bun.sleep(5);
  await edit(b, "Skills/001-one.md", "from B\n");
  await sync(a, fixture.url);
  await quietSync(b, fixture.url);

  const plan = "conflict Skills/001-one.md, run skills plans show --conflict Skills 001";
  const one = await statusLines(b, fixture.url);
  expect(one.slice(one.indexOf("conflicts 1")).slice(0, 3)).toEqual([
    "conflicts 1",
    plan,
    "leases 0",
  ]);

  writeFileSync(join(a.root, "Skills/notes.txt"), "from A\n");
  writeFileSync(join(b.root, "Skills/notes.txt"), "from B, longer\n");
  await sync(a, fixture.url);
  await quietSync(b, fixture.url);

  const listed = ["conflicts 2", plan, "conflict Skills/notes.txt, kept the local file"];
  const two = await statusLines(b, fixture.url);
  expect(two.slice(two.indexOf("conflicts 2")).slice(0, 4)).toEqual([...listed, "leases 0"]);
  expect((await sync(b, fixture.url)).filter((line) => line.startsWith("conflict "))).toEqual([]);

  await fixture.stop();
  const offline = await statusLines(b, fixture.url);
  expect(offline.slice(offline.indexOf("conflicts 2")).slice(0, 3)).toEqual(listed);
  expect(offline.at(-1)).toStartWith("offline: ");
});

test("shortSync is local with no hub and reads not enrolled before enrollment, as status does", async () => {
  const fixture = await hub();
  const fresh = await machine({});

  expect(await shortSync(hubEnv(fresh, undefined))).toEqual({ kind: "local" });
  expect(await shortSync(hubEnv(fresh, fixture.url))).toEqual({
    kind: "offline",
    reason: "not enrolled",
  });

  expect((await statusLines(fresh, fixture.url)).at(-1)).toBe("not enrolled");
});

test("status in tailscale mode names the tailnet, and skips the hub while tailscale is down", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const up = {
    kind: "up",
    name: "example.com",
    suffix: "tail0000.ts.net",
    peers: [],
    taken: [],
  } as const;

  a.lines.length = 0;
  await statusVerb(a.deps, fixture.url, "tailscale", up);
  expect(a.lines.slice(0, 2)).toEqual([`hub ${fixture.url} (tailscale)`, "tailnet example.com"]);
  expect(a.lines.some((line) => line.startsWith("offline"))).toBe(false);

  let connected = false;
  const watched: typeof a.deps.connect = (url, deadline) => {
    connected = true;
    return a.deps.connect(url, deadline);
  };

  a.lines.length = 0;
  await statusVerb({ ...a.deps, connect: watched }, fixture.url, "tailscale", {
    kind: "down",
    state: "Stopped",
  });

  expect(connected).toBe(false);
  expect(a.lines[1]).toStartWith("device ");
  expect(a.lines.at(-1)).toBe("offline: tailscale not connected");

  a.lines.length = 0;
  await statusVerb({ ...a.deps, connect: watched }, fixture.url, "tailscale", {
    kind: "unknown",
    reason: "tailscale status exited 2",
  });

  expect(connected).toBe(true);
  expect(a.lines[1]).toBe("tailnet unread: tailscale status exited 2");
  expect(a.lines.some((line) => line.startsWith("offline"))).toBe(false);
});

test("status names a device the hub forgot with the same line sync refuses with", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  const forgot = async () => {
    throw new HubRefusal("device-unknown", 404, "the hub knows no device by that id");
  };

  a.lines.length = 0;
  await statusVerb({ ...a.deps, connect: forgot }, fixture.url, "local");
  const line = a.lines.find((each) => each.startsWith("the hub does not know this device"));
  expect(line).toBeDefined();

  expect(await refusal(sync({ ...a, deps: { ...a.deps, connect: forgot } }, fixture.url))).toBe(
    line ?? "",
  );
});

test("a store halted as a copy reads offline with the stop message, not synced", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  await sync(a, fixture.url);

  const device = syncMeta(a.store).device ?? "";
  stop(a.store, { device, reason: "sequence-taken" });

  expect(await shortSync(hubEnv(a, fixture.url), true)).toEqual({
    kind: "offline",
    reason: stopMessage(device),
  });
});

test("status on a halted copy ends with the stop sentence naming this device's label", async () => {
  const fixture = await hub();
  const { a } = await enrolledPair(fixture);
  await sync(a, fixture.url);

  const device = syncMeta(a.store).device ?? "";
  stop(a.store, { device, reason: "sequence-taken" });

  a.lines.length = 0;
  const code = await statusVerb(a.deps, fixture.url, "local");
  const label = a.lines.find((line) => line.startsWith("device "))?.split(" ")[1] ?? "";

  expect(code).toBe(0);
  expect(label).not.toBe("");
  expect(a.lines.at(-1)).toBe(stopMessage(label));
  expect(a.lines.some((line) => line.startsWith("offline:"))).toBe(false);
});

test("status on a halted copy skips the stop sentence when another device stopped", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  await sync(a, fixture.url);

  stop(a.store, { device: syncMeta(b.store).device ?? "", reason: "sequence-taken" });

  a.lines.length = 0;
  expect(await statusVerb(a.deps, fixture.url, "local")).toBe(0);
  expect(a.lines.some((line) => line.startsWith("the hub holds other events"))).toBe(false);
});

type Backlog = SessionsMachine & { deps: Deps; lines: string[]; clock: Clock };

type Paced = Backlog & { wire: Wire };

const CUT = 2 * 1024 * 1024;

async function backlogMachine(fixture: HubFixture, link: Link): Promise<Backlog> {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const lines: string[] = [];
  const deps: Deps = {
    store: m.store,
    keys: keyStore(
      { HOME: join(m.root, ".keys"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline, clock) =>
      connect(url, "local", link.fetch, undefined, deadline, clock ?? link.clock),
    clock: link.clock,
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  await init(deps, fixture.url, fixture.initCode ?? "", "A");
  return { ...m, deps, lines, clock: link.clock };
}

async function pacedMachine(fixture: HubFixture, bytesPerMs: number): Promise<Paced> {
  const wire: Wire = { slow: false, aborted: 0 };
  const m = await backlogMachine(fixture, simulatedWire(wire, bytesPerMs));
  return { ...m, wire };
}

function writeNotes(m: Backlog, count: number): void {
  const notes = join(m.plans, "Alpha", "notes");
  mkdirSync(notes, { recursive: true });

  for (let index = 0; index < count; index++)
    writeFileSync(
      join(notes, `${String(index).padStart(3, "0")}.bin`),
      crypto.getRandomValues(new Uint8Array(64 * 1024)),
    );

  walkFiles(m.store, m.plans, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });
}

async function seedBacklog(m: Backlog): Promise<void> {
  writeNotes(m, 200);

  for (let index = 0; index < 300; index++)
    await appendLog("Alpha", "001", "nudge", `stall ${index}`, { PLANS_DIR: m.plans });

  const lines = readFileSync(m.claude);
  const copies = Math.ceil((4 * CUT) / lines.length);
  appendFileSync(m.claude, Buffer.concat(Array.from({ length: copies }, () => lines)));
  appendFileSync(m.claude, '{"type":"user","message":{"role":"user","content":"cut off');
  age(m.claude);
}

type Ran = { code: number; ms: number; lines: string[] };

async function longSync(m: Backlog, url: string, budget: number): Promise<Ran> {
  m.lines.length = 0;
  const began = m.clock.now();

  let code: number;
  try {
    code = await syncVerb(m.deps, url, {
      env: m.env,
      budget,
      chunkBytes: CUT,
      publishQuarantine: false,
      quiet: false,
    });
  } catch (error) {
    m.lines.push(`error: ${sentence(error) ?? (error as Error).message}`);
    code = 1;
  }

  return { code, ms: m.clock.now() - began, lines: [...m.lines] };
}

const LEFT = /^left (\d+) events, (\d+) blobs, (\d+) transcript bytes/;

const PUSHED = /^pushed \d+ events, \d+ blobs, pulled \d+ events, \d+ blobs, conflicts \d+$/;

function leftOf(ran: Ran): number[] {
  const line = ran.lines.find((each) => LEFT.test(each));
  if (line === undefined) throw new Error(`no left line: ${ran.lines.join(" | ")}`);
  return (line.match(LEFT) ?? []).slice(1).map(Number);
}

test("a backlog drains over partial runs that each end inside the budget", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 4_000);
  await seedBacklog(m);

  const seeded = backlog(m.store, syncMeta(m.store).device ?? "", []);
  expect(seeded.events).toBeGreaterThanOrEqual(500);
  expect(seeded.blobs).toBeGreaterThanOrEqual(200);
  m.wire.slow = true;

  const budget = 8_000;
  const runs: Ran[] = [];

  let status: string[] | undefined;
  while (runs.length < 12) {
    const ran = await longSync(m, fixture.url, budget);
    runs.push(ran);
    expect(ran.ms).toBeLessThan(budget + 2_000);

    if (status === undefined) {
      m.lines.length = 0;
      await statusVerb(m.deps, fixture.url, "local");
      status = [...m.lines];
    }

    if (ran.code !== 75) break;
  }

  const last = runs.at(-1) as Ran;
  expect(last.code).toBe(0);
  expect(last.lines.at(-1)).toMatch(PUSHED);
  expect(runs.length).toBeGreaterThan(1);

  const partial = runs.slice(0, -1);
  for (const ran of partial) expect(ran.code).toBe(75);

  expect(leftOf(runs[0] as Ran)[2]).toBeGreaterThanOrEqual(4 * CUT);

  const lefts = partial.map(leftOf);
  for (const [index, left] of lefts.entries()) {
    const before = lefts[index - 1];
    if (before === undefined) continue;

    left.forEach((count, at) => expect(count).toBeLessThanOrEqual(before[at] as number));
    expect(left.reduce((a, b) => a + b)).toBeLessThan(before.reduce((a, b) => a + b));
  }

  expect(status?.find((line) => line.startsWith("last sync"))).toMatch(
    /^last sync \d{4}-\d\d-\d\dT[\d:.]+Z$/,
  );

  m.wire.slow = false;
  m.lines.length = 0;
  await statusVerb(m.deps, fixture.url, "local");
  expect(m.lines).toEqual(
    expect.arrayContaining(["queue 0", "fetching 0", "transcripts: 0 chunks pending, 0 withheld"]),
  );

  expect(m.wire.aborted).toBe(0);
  expect(readFileSync(join(fixture.dir, "hub.log"), "utf8")).not.toContain("AbortError");
});

function queueBlob(m: Backlog, size: number): void {
  const bytes = new Uint8Array(size);
  for (let at = 0; at < size; at += 65_536) crypto.getRandomValues(bytes.subarray(at, at + 65_536));

  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  m.store.db.run("INSERT INTO blobs (sha256, locator, bytes) VALUES (?, ?, ?)", [
    digest,
    locatorOf(m.store, digest),
    bytes,
  ]);

  m.store.db.run("INSERT INTO blob_uploads (sha256, queued) VALUES (?, ?)", [
    digest,
    Date.now() + 1_000_000_000,
  ]);
}

test("a backlog blob too large for the time left waits for a fresh run, one too large for any run stops", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 1_000);
  writeNotes(m, 60);
  queueBlob(m, 3 * 1024 * 1024);
  m.wire.slow = true;

  const budget = 10_000;
  const runs: Ran[] = [];
  while (runs.length < 6) {
    const ran = await longSync(m, fixture.url, budget);
    runs.push(ran);
    expect(ran.ms).toBeLessThan(budget + 2_000);
    if (ran.code !== 75) break;
  }

  expect(runs[0]?.code).toBe(75);
  expect(runs[0]?.lines.at(-1)).toMatch(
    /^left \d+ events, 1 blobs, \d+ transcript bytes uncut, next blob 3\.0 MiB$/,
  );

  expect(runs.at(-1)?.code).toBe(0);

  queueBlob(m, 12 * 1024 * 1024);

  const named = await longSync(m, fixture.url, budget);
  expect(named.code).toBe(75);
  expect(named.lines.at(-1)).toMatch(/, next blob 12\.0 MiB$/);

  const stuck = await longSync(m, fixture.url, budget);
  expect(stuck.code).toBe(1);
  expect(stuck.ms).toBeLessThan(budget + 2_000);
  expect(stuck.lines.at(-1)).toMatch(
    /^error: a 12\.0 MiB blob takes longer to send at [\d.]+ MiB\/s than one sync allows, run skills hub sync again from a faster network$/,
  );

  expect(stuck.lines.at(-2)).toMatch(PUSHED);
  expect(stuck.lines.some((line) => line.startsWith("left "))).toBe(false);

  expect(m.wire.aborted).toBe(0);
  expect(readFileSync(join(fixture.dir, "hub.log"), "utf8")).not.toContain("AbortError");
});

test("a backlog blob after one jittered small request waits for a rate the link proves", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 1_000);
  writeNotes(m, 60);
  m.wire.slow = true;

  const budget = 10_000;
  const runs: Ran[] = [];
  while (runs.length < 6) {
    const ran = await longSync(m, fixture.url, budget);
    runs.push(ran);
    if (ran.code !== 75) break;
  }

  expect(runs.at(-1)?.code).toBe(0);

  queueBlob(m, 12 * 1024 * 1024);
  m.wire.hold = { path: "/v1/blobs/have", ms: 150 };

  const ran = await longSync(m, fixture.url, budget);
  expect(m.wire.hold).toBeUndefined();
  expect(ran.code).toBe(75);
  expect(ran.lines.at(-1)).toMatch(/, next blob 12\.0 MiB$/);
  expect(m.wire.aborted).toBe(0);
});

test("a backlog blob judged only by a lower bound waits without a too slow stop", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 4_000);
  writeNotes(m, 4);
  await longSync(m, fixture.url, LONG_BUDGET);

  queueBlob(m, 12 * 1024 * 1024);
  m.wire.slow = true;

  for (let run = 0; run < 3; run++) {
    const ran = await longSync(m, fixture.url, LONG_BUDGET);
    expect(ran.code).toBe(75);
    expect(ran.lines.at(-1)).toMatch(/, next blob 12\.0 MiB$/);
  }

  expect(m.wire.aborted).toBe(0);
});

test("a backlog stop in one lane never hides a real timeout in another", async () => {
  const lanes = wide([0, 1], async (lane) => {
    if (lane === 0) throw new Spent();
    await Bun.sleep(20);
    throw new Offline("the hub did not answer in time");
  });

  await expect(lanes).rejects.toThrow("the hub did not answer in time");
});

test("a backlog run whose lease read never answers exits 1 with the timeout sentence", async () => {
  const fixture = await hub();
  let hold = false;
  const m = await backlogMachine(fixture, {
    clock: SYSTEM_CLOCK,
    fetch: (url, init) => {
      if (!hold || !new URL(url).pathname.startsWith("/v1/leases")) return fetch(url, init);

      const { signal } = init;
      return new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    },
  });

  await longSync(m, fixture.url, LONG_BUDGET);

  hold = true;
  const budget = 1_000;
  const ran = await longSync(m, fixture.url, budget);

  expect(ran.code).toBe(1);
  expect(ran.ms).toBeLessThan(budget + 2_000);
  expect(ran.lines.at(-1)).toBe("error: the hub did not answer in time");
}, 60_000);

test("a backlog of events alone with no saved rate drains inside the budget", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 64);
  for (let index = 0; index < 600; index++)
    await appendLog("Alpha", "001", "nudge", `${"stall ".repeat(60)}${index}`, {
      PLANS_DIR: m.plans,
    });

  m.wire.slow = true;
  const budget = 6_000;
  const runs: Ran[] = [];
  while (runs.length < 12) {
    const ran = await longSync(m, fixture.url, budget);
    runs.push(ran);
    expect(ran.ms).toBeLessThan(budget + 2_000);
    if (ran.code !== 75) break;
  }

  expect(runs.at(-1)?.code).toBe(0);
  expect(m.wire.aborted).toBe(0);
});

test("a backlog blob refused by a stale slow saved rate goes once the largest pushed blob proves the link faster", async () => {
  const fixture = await hub();
  const wire: Wire = { slow: false, aborted: 0 };
  const link = simulatedWire(wire, 4_000);
  const puts: string[] = [];
  const m = await backlogMachine(fixture, {
    clock: link.clock,
    fetch: (url, init) => {
      if (wire.slow && init.method === "PUT") puts.push(new URL(url).pathname);
      return link.fetch(url, init);
    },
  });

  const large = crypto.getRandomValues(new Uint8Array(512 * 1024));
  mkdirSync(join(m.plans, "Alpha"), { recursive: true });
  writeFileSync(join(m.plans, "Alpha", "large.bin"), large);
  writeNotes(m, 4);
  await longSync(m, fixture.url, LONG_BUDGET);

  savePace(m.store, { rate: 1, slack: 0 });
  queueBlob(m, 2 * 1024 * 1024);
  wire.slow = true;

  const ran = await longSync(m, fixture.url, 8_000);
  const digest = new Bun.CryptoHasher("sha256").update(large).digest("hex");

  expect(puts[0]).toBe(`/v1/blobs/${locatorOf(m.store, digest)}`);
  expect(ran.code).toBe(0);

  expect(ran.lines.at(-1)).toMatch(/^pushed \d+ events, 1 blobs,/);
  expect(wire.aborted).toBe(0);
});

test("a backlog probe on a slow link is cut at the deadline, ending the run partial with no pace saved", async () => {
  const fixture = await hub();
  const m = await pacedMachine(fixture, 32);

  mkdirSync(join(m.plans, "Alpha"), { recursive: true });
  writeFileSync(
    join(m.plans, "Alpha", "large.bin"),
    crypto.getRandomValues(new Uint8Array(1024 * 1024)),
  );

  writeNotes(m, 4);
  await longSync(m, fixture.url, LONG_BUDGET);

  savePace(m.store, { rate: 1, slack: 0 });
  queueBlob(m, 2 * 1024 * 1024);
  m.wire.slow = true;

  const ran = await longSync(m, fixture.url, LONG_BUDGET);

  expect(ran.code).toBe(75);
  expect(ran.ms).toBeLessThanOrEqual(LONG_BUDGET);
  expect(ran.lines.at(-1)).toMatch(/^left \d+ events, 1 blobs, \d+ transcript bytes uncut$/);
  expect(m.wire.aborted).toBe(1);
  expect(savedPace(m.store)?.rate).toBe(1);
});

const TO_PULL =
  /^left \d+ events, \d+ blobs, 0 transcript bytes uncut, to pull (\d+) events, (\d+) blobs$/;

test("a machine behind on every event counts what is left to pull until it catches up", async () => {
  const fixture = await hub();
  const wire: Wire = { slow: false, aborted: 0 };
  const link = simulatedWire(wire, 4_000);
  const { a, b } = await enrolledPair(fixture, link.fetch);

  const notes = join(a.root, "Skills", "notes");
  mkdirSync(notes, { recursive: true });

  for (let index = 0; index < 40; index++)
    writeFileSync(join(notes, `${index}.bin`), crypto.getRandomValues(new Uint8Array(16 * 1024)));

  write(a.store, () => {
    for (let index = 0; index < 3_000; index++)
      appendEvent(a.store, {
        kind: "stored",
        type: HEARTBEAT,
        at: Date.now(),
        project: "Skills",
        plan: "001",
        payload: { branch: "feat/one", environment: null, session: `beat-${index}` },
      });
  });

  await sync(a, fixture.url);

  const deps = { ...b.deps, clock: link.clock };
  const current = await enrolled(b.deps, fixture.url, false);
  wire.slow = true;

  const head = async () => {
    wire.slow = false;
    const body = await current.client.call(
      "GET",
      "/v1/events?after=0&limit=1",
      undefined,
      current.signer,
    );

    wire.slow = true;
    return body.head as number;
  };

  const runs: { code: number; lines: string[]; truth: number[] }[] = [];
  while (runs.length < 12) {
    b.lines.length = 0;
    const code = await syncVerb(deps, fixture.url, {
      budget: 2_500,
      publishQuarantine: false,
      quiet: false,
    });

    const truth = [(await head()) - syncMeta(b.store).pulled, fetchCount(b.store)];
    runs.push({ code, lines: [...b.lines], truth });
    if (code !== 75) break;
  }

  const last = runs.at(-1);
  expect(last?.code).toBe(0);
  expect(last?.lines.some((line) => line.startsWith("left "))).toBe(false);

  const counted = runs.flatMap(({ code, lines, truth }) => {
    const match = code === 75 ? lines.at(-1)?.match(TO_PULL) : undefined;
    return match ? [{ printed: [Number(match[1]), Number(match[2])], truth }] : [];
  });

  expect(counted.length).toBeGreaterThanOrEqual(2);
  for (const { printed, truth } of counted) expect(printed).toEqual(truth);

  const events = counted.map(({ printed }) => printed[0] as number);
  expect(events[0]).toBeGreaterThan(0);
  events.forEach((count, index) => expect(count).toBeLessThanOrEqual(events[index - 1] ?? count));
  expect(counted.some(({ printed }) => (printed[1] as number) > 0)).toBe(true);

  b.lines.length = 0;
  wire.slow = false;
  await statusVerb(b.deps, fixture.url, "local");
  expect(b.lines).toContain("fetching 0");
});

const QUIET_BUDGET = 2_000;

type Posted = { readonly bytes: number; readonly events: number };

async function recordingMachine(fixture: HubFixture): Promise<{ m: Machine; posted: Posted[] }> {
  const posted: Posted[] = [];
  const m = await machine({ "Skills/001-one.md": "# 001 one\n" }, undefined, (url, init) => {
    const body = typeof init.body === "string" ? init.body : "";
    if (init.method === "POST" && new URL(url).pathname === "/v1/events") {
      const { events } = JSON.parse(body) as { events: unknown[] };
      if (events.length > 0) posted.push({ bytes: body.length, events: events.length });
    }

    return fetch(url, init);
  });

  await init(m.deps, fixture.url, fixture.initCode ?? "", "A");
  await sync(m, fixture.url);
  posted.length = 0;
  return { m, posted };
}

async function quietSync(m: Machine, url: string): Promise<void> {
  await syncOnce(m.deps, url, { budget: QUIET_BUDGET, publishQuarantine: false, quiet: true });
}

test("a quiet sync sends small queued events in one request", async () => {
  const fixture = await hub();
  const { m, posted } = await recordingMachine(fixture);
  for (let index = 0; index < 20; index++)
    await appendLog("Skills", "001", "nudge", `quiet ${index}`, { PLANS_DIR: m.root });

  await quietSync(m, fixture.url);

  expect(posted.map((each) => each.events)).toEqual([20]);
  expect(backlog(m.store, syncMeta(m.store).device ?? "", []).events).toBe(0);
});

test("a quiet sync sizes event batches to the blind allowance", async () => {
  const fixture = await hub();
  const { m, posted } = await recordingMachine(fixture);
  for (let index = 0; index < 40; index++)
    await appendLog(
      "Skills",
      "001",
      "nudge",
      `${"blind ".repeat(500)}${index}`,
      { PLANS_DIR: m.root },
      (detail) => detail,
    );

  await quietSync(m, fixture.url);

  const [blind] = posted;
  expect(blind?.events).toBeGreaterThan(1);
  expect(blind?.bytes).toBeLessThanOrEqual(131_072);
});
