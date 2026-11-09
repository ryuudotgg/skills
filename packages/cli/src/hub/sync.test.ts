import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { appendLog, recordWorkingCopies, updateIndex } from "../plans/commit.ts";
import { importStore } from "../plans/import.ts";
import { counts } from "../plans/outbox.ts";
import { openStore, type Store } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import { connect } from "./client.ts";
import {
  enrolled,
  init,
  invite,
  join as joinVault,
  revoke,
  sentence,
  settle,
  type Deps,
} from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { LONG_BUDGET, reseed, stopMessage, syncVerb } from "./sync.ts";

setDefaultTimeout(60_000);

const DAY = 24 * 60 * 60 * 1000;

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Machine = { root: string; store: Store; deps: Deps; lines: string[] };

function plans(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, "Skills", "done"), { recursive: true });

  const rows = ["001\tone", "002\ttwo"].map((head) =>
    [head, "TODO", "P1", "S", "-", "-", "-", "2026-11-07", "-"].join("\t"),
  );

  writeFileSync(join(root, "Skills", "index.tsv"), [COLUMNS.join("\t"), ...rows, ""].join("\n"));
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
}

async function machine(files?: Record<string, string>, from?: string): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), "hub-sync-"));
  if (from !== undefined) cpSync(from, root, { recursive: true });
  else if (files !== undefined) plans(root, files);

  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  const lines: string[] = [];
  const deps: Deps = {
    store,
    keys: keyStore(
      { HOME: join(root, ".home"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline) => connect(url, "local", fetch, undefined, deadline),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, store, deps, lines };
}

async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

async function sync(m: Machine, url: string, publishQuarantine = false): Promise<string[]> {
  m.lines.length = 0;
  await syncVerb(m.deps, url, { budget: LONG_BUDGET, publishQuarantine, quiet: false });
  return [...m.lines];
}

async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return sentence(error) ?? (error as Error).message;
  }

  throw new Error("the verb did not refuse");
}

async function enrolledPair(fixture: HubFixture): Promise<{ a: Machine; b: Machine }> {
  const a = await machine({ "Skills/001-one.md": "# 001 one\n", "Skills/ctx-x.md": "# ctx\n" });
  await appendLog("Skills", "001", "start", "feat/one", { PLANS_DIR: a.root });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");

  const b = await machine();
  await enroll(a, b, fixture, "B");

  return { a, b };
}

async function enroll(a: Machine, b: Machine, fixture: HubFixture, label: string): Promise<void> {
  a.lines.length = 0;
  await invite(a.deps, fixture.url, { label, lasts: DAY, wait: false });
  const line = (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";
  const settleInvites = async () =>
    void (await settle(a.deps, await enrolled(a.deps, fixture.url)));

  await joinVault({ ...b.deps, sleep: settleInvites }, fixture.url, line);
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
