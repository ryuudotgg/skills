import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { COLUMNS } from "skills-core";
import { appendLog, recordWorkingCopies, updateIndex } from "../plans/commit.ts";
import { walkFiles } from "../plans/files.ts";
import { backlog, counts, stop } from "../plans/outbox.ts";
import { locatorOf, openStore } from "../plans/store.ts";
import { syncMeta } from "../plans/sync.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import {
  runCleanup,
  cleanup,
  enroll,
  enrolledPair,
  hub,
  machine,
  sync,
  type Machine,
} from "../test/hub-machines.ts";
import { age, sessionsMachine, type SessionsMachine } from "../test/sessions-fixture.ts";
import { connect, HubRefusal } from "./client.ts";
import { init, revoke, sentence, type Deps } from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { Offline } from "./network.ts";
import { Budget, Spent, wide } from "./run.ts";
import { LONG_BUDGET, reseed, shortSync, statusVerb, stopMessage, syncVerb } from "./sync.ts";

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

type Wire = { slow: boolean; requests: number; aborted: number; hang?: string };

const LATENCY = 300;

function pause(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

function slowFetch(wire: Wire, bytesPerMs: number): typeof fetch {
  let free = 0;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (!wire.slow) return fetch(input, init);

    wire.requests++;
    const bytes = typeof init?.body === "string" ? Buffer.byteLength(init.body) : 0;
    const start = Math.max(Date.now(), free);
    free = start + bytes / bytesPerMs;

    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const hangs = wire.hang !== undefined && path.startsWith(wire.hang);
    try {
      await pause(hangs ? 600_000 : free - Date.now() + LATENCY, init?.signal);
      return await fetch(input, init);
    } catch (error) {
      if (init?.signal?.aborted === true) wire.aborted++;
      throw error;
    }
  }) as typeof fetch;
}

type Backlog = SessionsMachine & { deps: Deps; lines: string[]; wire: Wire };

const CUT = 2 * 1024 * 1024;

async function backlogMachine(fixture: HubFixture, bytesPerMs: number): Promise<Backlog> {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const wire: Wire = { slow: false, requests: 0, aborted: 0 };
  const slow = slowFetch(wire, bytesPerMs);
  const lines: string[] = [];
  const deps: Deps = {
    store: m.store,
    keys: keyStore(
      { HOME: join(m.root, ".keys"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline) => connect(url, "local", slow, undefined, deadline),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  await init(deps, fixture.url, fixture.initCode ?? "", "A");
  return { ...m, deps, lines, wire };
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
  const began = Date.now();

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

  return { code, ms: Date.now() - began, lines: [...m.lines] };
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
  const m = await backlogMachine(fixture, 4_000);
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
}, 180_000);

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
  const m = await backlogMachine(fixture, 1_000);
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

  expect(m.wire.aborted).toBe(0);
  expect(readFileSync(join(fixture.dir, "hub.log"), "utf8")).not.toContain("AbortError");
}, 180_000);

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
  const m = await backlogMachine(fixture, 4_000);
  await longSync(m, fixture.url, LONG_BUDGET);

  m.wire.slow = true;
  m.wire.hang = "/v1/leases";
  const budget = 4_000;
  const ran = await longSync(m, fixture.url, budget);

  expect(ran.code).toBe(1);
  expect(ran.ms).toBeLessThan(budget + 2_000);
  expect(ran.lines.at(-1)).toBe("error: the hub did not answer in time");
}, 60_000);

test("a backlog of events alone with no saved rate drains inside the budget", async () => {
  const fixture = await hub();
  const m = await backlogMachine(fixture, 64);
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
}, 180_000);

test("a backlog first upload with no known rate learns no slack", async () => {
  const budget = new Budget(10_000);
  await budget.timed({ bytes: 200_000, method: "PUT" }, () => Bun.sleep(200));

  expect(budget.measured).toBeGreaterThan(0);
  expect(budget.overrun).toBe(0);
});
