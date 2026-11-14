import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { envelopeEpoch, leasePlan, movedFrom, open, subkey, type Moved } from "skills-core";
import { enrolled } from "../hub/enroll.ts";
import { leaseSession, pinPlans } from "../hub/plan-leases.ts";
import { LONG_BUDGET } from "../hub/sync.ts";
import { hubLeases, keyFor, leaserOf } from "../hub/leases.ts";
import type { MoveIo, MoveWire } from "../hub/move.ts";
import type { Io } from "../io.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import {
  enrolledPair,
  hub,
  runCleanup,
  slowFetch,
  sync,
  type Machine,
  type Wire,
} from "../test/hub-machines.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { adoptVerb } from "./adopt.ts";
import { markStarted } from "./claim.ts";
import { updateIndex } from "./commit.ts";
import { leasesIn, readMoveRefusal, recordHeld } from "./leases.ts";
import { moveVerb } from "./move.ts";
import { projectRows, write } from "./store.ts";

setDefaultTimeout(120_000);

const repo = resolve(import.meta.dir, "../../../..");
const bin = join(repo, "skills/playbook/bin/skills");
const usage = "skills plans move <Project> <id> [--to <label | device id> | --file <path>]";
const temporary: string[] = [];

const realNow = Date.now;

afterEach(async () => {
  Date.now = realNow;
  await runCleanup();
  for (const directory of temporary.splice(0)) await removeTemporary(directory);
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...suiteEnvironment(),
    HOME: home,
    HUB_URL: "",
    SKILLS_AUTO_UPDATE: "0",
    SKILLS_MACHINE_REFRESH: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
}

async function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
  if (result.timedOut) throw new Error(`${argv.join(" ")} timed out`);
  return result;
}

async function must(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await run(argv, cwd, env);
  if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

async function halfDone(checkout: string, env: NodeJS.ProcessEnv): Promise<void> {
  writeFileSync(join(checkout, "one.txt"), "one\n");
  await must(["git", "add", "one.txt"], checkout, env);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "one"], checkout, env);
  writeFileSync(join(checkout, "one.txt"), "one\nedit\n");
  writeFileSync(join(checkout, "extra.txt"), "extra\n");
}

function members(pack: string, into: string): Record<string, Uint8Array> {
  return Object.fromEntries(
    readdirSync(into, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const path = join(entry.parentPath, entry.name);
        return [path.slice(into.length + 1), readFileSync(path)];
      }),
  );
}

function storeQuery(plans: string, sql: string): unknown[] {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(plans, "plans.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

test("a file move packs the half done work, repeats byte for byte, and marks the row moving", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "plans-move-"));
  temporary.push(scratch);

  const dir = join(scratch, "fixture");

  const base = gitEnv(join(scratch, "home"));
  await must(
    ["bun", join(repo, "packages/cli/src/test/machine-fixture.ts"), dir, "--rows", "move"],
    repo,
    base,
  );

  const plans = join(dir, "plans-a");
  const env = { ...base, PLANS_DIR: plans, SKILLS_CONF: join(dir, "conf") };
  const checkout = join(dir, "a/Demo");
  await must([bin, "plans", "start", "Demo", "001"], checkout, env);
  await halfDone(checkout, env);

  const before = await must(["git", "status", "--porcelain"], checkout, env);
  const bare = await run([bin, "plans", "move", "Demo", "001"], checkout, env);
  expect(bare.code).toBe(1);
  expect(bare.stderr).toContain("--file");

  const inner = await run(
    [bin, "plans", "move", "Demo", "001", "--file", join(checkout, "pack.tar")],
    checkout,
    env,
  );

  expect(inner.stderr).toContain("is inside the checkout being moved");

  const dotted = await run(
    [bin, "plans", "move", "Demo", "001", "--file", "..pack.tar"],
    checkout,
    env,
  );

  expect(dotted.stderr).toContain("is inside the checkout being moved");

  symlinkSync(join(dir, "nowhere"), join(dir, "dangling.tar"));
  const dangling = await run(
    [bin, "plans", "move", "Demo", "001", "--file", join(dir, "dangling.tar")],
    checkout,
    env,
  );

  expect(dangling.stderr).toContain("dangling.tar already exists");

  const pack = join(dir, "pack.tar");
  const noNote = await run([bin, "plans", "move", "Demo", "001", "--file", pack], checkout, env);
  expect(noNote.stderr).toContain(".resume-001.md is missing");

  writeFileSync(join(plans, "Demo/.resume-001.md"), "note\n");
  const moved = await must([bin, "plans", "move", "Demo", "001", "--file", pack], checkout, env);
  expect(moved).toBe(
    `moved Demo 001 to ${pack}, 1 commits, 1 changed files, 1 untracked\n/plans do 001\n`,
  );

  expect(await must(["git", "status", "--porcelain"], checkout, env)).toBe(before);

  const again = await run([bin, "plans", "move", "Demo", "001", "--file", pack], checkout, env);
  expect(again.code).toBe(1);
  expect(again.stderr).toContain(`${pack} already exists`);

  const out = join(dir, "unpacked");
  await must(["mkdir", out], dir, env);
  await must(["tar", "xf", pack, "-C", out], dir, env);

  const unpacked = members(pack, out);
  expect(Object.keys(unpacked).sort()).toEqual([
    "commits.bundle",
    "pack.json",
    "resume.md",
    "tracked.patch",
    "untracked/extra.txt",
  ]);

  const manifest = JSON.parse(new TextDecoder().decode(unpacked["pack.json"])) as Record<
    string,
    unknown
  >;

  const listing = Object.keys(unpacked)
    .filter((path) => path !== "pack.json")
    .sort()
    .map((path) => `100644 ${sha256(unpacked[path] as Uint8Array)}  ${path}\n`)
    .join("");

  expect(manifest).toMatchObject({
    format: 1,
    project: "Demo",
    id: "001",
    branch: "feat/move",
    to: null,
  });

  expect(manifest.sha256).toBe(sha256(listing));

  const bytes = readFileSync(pack);
  const recorded = storeQuery(plans, "SELECT payload FROM events WHERE type = 'moved'") as {
    payload: string;
  }[];

  expect(recorded.map((row) => movedFrom(JSON.parse(row.payload))?.sha256)).toEqual([
    sha256(bytes),
  ]);

  const frontier = await must([bin, "plans", "frontier", "Demo"], checkout, env);
  expect(frontier).toContain("DOING 001 move feat/move (moving to any)");

  writeFileSync(join(dir, "conf-resume"), "PLANS_RESUME_EVERY=30m\n");
  const resume = await must([bin, "plans", "resume", "Demo"], checkout, {
    ...env,
    SKILLS_CONF: join(dir, "conf-resume"),
  });

  expect(resume).toContain("skip 001 moving to any");

  const db = new (require("bun:sqlite") as typeof import("bun:sqlite")).Database(
    join(plans, "plans.db"),
  );

  db.run("DELETE FROM events WHERE type = 'moved'");
  db.close();

  const second = join(dir, "pack2.tar");
  await must([bin, "plans", "move", "Demo", "001", "--file", second], checkout, env);
  expect(sha256(readFileSync(second))).toBe(sha256(bytes));
  expect(storeQuery(plans, "SELECT count(*) AS n FROM events WHERE type = 'moved'")).toEqual([
    { n: 1 },
  ]);
});

function envOf(m: Machine, fixture: HubFixture): NodeJS.ProcessEnv {
  return {
    ...gitEnv(join(m.root, ".home")),
    HUB_KEYS: "file",
    HUB_URL: fixture.url,
    HUB_NETWORK: "local",
    PLANS_DIR: m.root,
    SKILLS_CONF: join(m.root, "skills.conf"),
  };
}

async function hubPack(m: Machine, fixture: HubFixture, moved: Moved): Promise<Uint8Array> {
  const current = await enrolled(m.deps, fixture.url, false);
  const parts: Uint8Array[] = [];
  for (const locator of moved.blobs) {
    const body = await current.client.call(
      "GET",
      `/v1/blobs/${locator}`,
      undefined,
      current.signer,
    );

    const envelope = new Uint8Array(Buffer.from(String(body.envelope), "base64"));
    const key = current.epochKeys.get(envelopeEpoch(envelope));
    if (key === undefined) throw new Error("no key for the blob's epoch");

    parts.push(await open(await subkey(key, "blobs"), envelope, locator));
  }

  return new Uint8Array(Buffer.concat(parts));
}

test("a hub move uploads a pack the target can open, and hands the lease back with a moving marker", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const env = envOf(a, fixture);

  const checkout = join(mkdtempSync(join(tmpdir(), "plans-move-hub-")), "Skills");
  temporary.push(join(checkout, ".."));
  await must(["git", "init", "-q", "-b", "main", checkout], repo, env);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    checkout,
    env,
  );

  await must(["git", "checkout", "-q", "-b", "feat/one"], checkout, env);
  await must(["git", "config", "branch.feat/one.skills-base", "main"], checkout, env);
  await halfDone(checkout, env);
  writeFileSync(
    join(checkout, "big.bin"),
    new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251),
  );

  symlinkSync("nowhere", join(checkout, "dangling"));

  await updateIndex(join(a.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows)
      if (row.id === "001") Object.assign(row, { status: "DOING", branch: "feat/one" });
  });

  writeFileSync(join(a.root, "Skills/.resume-001.md"), "note\n");

  const session = await leaseSession(env);
  const taken = await session.start("Skills", "001");
  session.close();
  if (taken.kind !== "taken") throw new Error(`no lease taken: ${taken.kind}`);

  write(a.store, () => recordHeld(a.store, Date.now(), "Skills", "001", taken.held));

  const lines: string[] = [];
  const errors: string[] = [];
  const io: Io = {
    cwd: checkout,
    env,
    out: (text) => lines.push(text),
    err: (text) => errors.push(text),
    capture: true,
  };

  expect(await moveVerb(["Skills", "001", "--to", "Nowhere"], usage, io)).toBe(1);
  expect(errors.join("")).toBe("move: no machine labelled Nowhere\n");

  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, io)).toBe(0);
  expect(lines.join("")).toBe(
    "moved Skills 001 to B, 1 commits, 1 changed files, 3 untracked\n/plans do 001\n",
  );

  const rows = storeQuery(a.root, "SELECT payload FROM events WHERE type = 'moved'") as {
    payload: string;
  }[];

  const moved = movedFrom(JSON.parse(rows[0]?.payload ?? "null"));
  if (moved === undefined) throw new Error("no moved event");

  expect(moved.to).toBe("B");
  expect(moved.blobs.length).toBeGreaterThan(1);
  expect(sha256(await hubPack(b, fixture, moved))).toBe(moved.sha256);

  const leases = leasesIn(a.store, "Skills").get(leasePlan("Skills", "001"));
  expect(leases?.claims.size).toBe(0);
  expect(moved.toDevice).not.toBeNull();

  expect(await readMoveRefusal("Skills", "001", env)).toBe("001 is moving to B");
  expect(await pinPlans("Skills", ["001"], "1d", env)).toEqual([
    { id: "001", line: "pin 001 refused: 001 is moving to B", ok: false },
  ]);

  const current = await enrolled(a.deps, fixture.url, false);
  const leaser = await leaserOf(current, (method, path, body) =>
    current.client.call(method, path, body, current.signer),
  );

  if (leaser === undefined) throw new Error("no leaser");

  expect((await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", "001"))).toBeUndefined();

  const released = storeQuery(
    a.root,
    "SELECT payload ->> '$.moving' AS moving FROM events WHERE type = 'lease-released'",
  );

  expect(released).toEqual([{ moving: moved.toDevice }]);

  await sync(a, fixture.url);
  await sync(b, fixture.url);
  const there = storeQuery(
    b.root,
    "SELECT payload ->> '$.sha256' AS s, payload ->> '$.to' AS t FROM events WHERE type = 'moved'",
  );

  expect(there).toEqual([{ s: moved.sha256, t: "B" }]);

  const count = () => storeQuery(a.root, "SELECT count(*) AS n FROM events WHERE type = 'moved'");
  const forget = new (require("bun:sqlite") as typeof import("bun:sqlite")).Database(
    join(a.root, "plans.db"),
  );

  forget.run("DELETE FROM meta WHERE key LIKE 'hub_pack:%'");
  forget.close();

  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, io)).toBe(0);
  expect(count()).toEqual([{ n: 1 }]);

  const index = join(a.root, "Skills", "index.tsv");
  const row = () => projectRows(a.store, "Skills").filter((entry) => entry.id === "001");
  expect(await markStarted(index, "Skills", "feat/one", row(), env)).toEqual({
    refusal: "001 is moving to B",
  });

  await updateIndex(index, (rows) => {
    for (const entry of rows) if (entry.id === "001") entry.status = "TODO";
  });

  expect(await markStarted(index, "Skills", "feat/one", row(), env)).toMatchObject([
    { id: "001", status: "DOING" },
  ]);

  expect(await readMoveRefusal("Skills", "001", env)).toBeUndefined();

  const file = join(checkout, "..", "pack.tar");
  expect(await moveVerb(["Skills", "001", "--file", file], usage, io)).toBe(0);
  expect(count()).toEqual([{ n: 2 }]);
  expect(sha256(readFileSync(file))).not.toBe(moved.sha256);
});

const BUDGET = 1_000;

const CHUNK = /^\/v1\/blobs\/[0-9a-f]{32}$/;

type Handler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

type Pick = (method: string, path: string) => Handler | undefined;

function routed(pick: Pick): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    return (pick(init?.method ?? "GET", path) ?? fetch)(input, init);
  }) as typeof fetch;
}

function capture(cwd: string, env: NodeJS.ProcessEnv, wire?: MoveWire) {
  const out: string[] = [];
  const err: string[] = [];
  const io: MoveIo = {
    cwd,
    env,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    capture: true,
    ...(wire && { wire }),
  };

  return { io, out, err };
}

type HubMove = {
  fixture: HubFixture;
  a: Machine;
  b: Machine;
  env: NodeJS.ProcessEnv;
  envB: NodeJS.ProcessEnv;
  source: string;
  target: string;
  big: Uint8Array;
};

async function hubMove(): Promise<HubMove> {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const env = envOf(a, fixture);
  const envB = envOf(b, fixture);

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "plans-move-budget-")));
  temporary.push(scratch);

  const source = join(scratch, "a", "Skills");
  await must(["git", "init", "-q", "-b", "main", source], repo, env);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    source,
    env,
  );

  const target = join(scratch, "b", "Skills");
  await must(["git", "clone", "-q", source, target], repo, envB);

  await must(["git", "checkout", "-q", "-b", "feat/one"], source, env);
  await must(["git", "config", "branch.feat/one.skills-base", "main"], source, env);
  await halfDone(source, env);

  const big = new Uint8Array(4 * 1024 * 1024).map((_, index) => index % 251);
  writeFileSync(join(source, "big.bin"), big);

  await updateIndex(join(a.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows)
      if (row.id === "001") Object.assign(row, { status: "DOING", branch: "feat/one" });
  });

  writeFileSync(join(a.root, "Skills/.resume-001.md"), "note\n");

  const session = await leaseSession(env);
  const taken = await session.start("Skills", "001");
  session.close();
  if (taken.kind !== "taken") throw new Error(`no lease taken: ${taken.kind}`);

  write(a.store, () => recordHeld(a.store, Date.now(), "Skills", "001", taken.held));
  await sync(a, fixture.url);

  return { fixture, a, b, env, envB, source, target, big };
}

function movedEvents(root: string): Moved[] {
  const rows = storeQuery(root, "SELECT payload FROM events WHERE type = 'moved' ORDER BY seq") as {
    payload: string;
  }[];

  return rows.flatMap((row) => movedFrom(JSON.parse(row.payload)) ?? []);
}

const MOVED_LINE =
  "moved Skills 001 to B, 1 commits, 1 changed files, 2 untracked\n/plans do 001\n";

test("a hub move outlives the budget, and the target adopts it under the same budget", async () => {
  const m = await hubMove();
  const wire: Wire = { slow: true, requests: 0, aborted: 0 };
  const slow = slowFetch(wire, 1_500);
  const puts: { began: number; ended: number }[] = [];
  const timed = (async (input: string | URL | Request, init?: RequestInit) => {
    const began = performance.now();
    try {
      return await slow(input, init);
    } finally {
      puts.push({ began, ended: performance.now() });
      if (puts.length === 1) Date.now = () => realNow() + 2 * LONG_BUDGET;
    }
  }) as typeof fetch;

  const moveWire: MoveWire = {
    fetch: routed((method, path) => {
      if (!CHUNK.test(path)) return undefined;
      return method === "PUT" ? timed : slow;
    }),
    syncBudget: BUDGET,
  };

  const moving = capture(m.source, m.env, moveWire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, moving.io)).toBe(0);
  expect(moving.err.join("")).toBe("");
  expect(moving.out.join("")).toBe(MOVED_LINE);

  const [moved] = movedEvents(m.a.root);
  if (moved === undefined) throw new Error("no moved event");

  expect(moved.blobs.length).toBeGreaterThanOrEqual(4);
  expect(puts.length).toBe(moved.blobs.length);

  const span =
    Math.max(...puts.map((put) => put.ended)) - Math.min(...puts.map((put) => put.began));

  expect(span).toBeGreaterThan(3 * BUDGET);

  await sync(m.a, m.fixture.url);
  await sync(m.b, m.fixture.url);
  await must([bin, "machine", "refresh"], m.target, m.envB);

  const adopting = capture(m.target, m.envB, moveWire);
  const adoptUsage = "skills plans adopt <Project> <id> [--file <path>]";
  expect(await adoptVerb(["Skills", "001"], adoptUsage, adopting.io)).toBe(0);
  expect(adopting.err.join("")).toBe("");
  expect(adopting.out.join("")).toBe(
    `adopted Skills 001 into ${m.target} on feat/one\n/plans do 001\n`,
  );

  expect(sha256(readFileSync(join(m.target, "big.bin")))).toBe(sha256(m.big));
  expect(readFileSync(join(m.target, "extra.txt"), "utf8")).toBe("extra\n");
  expect(readFileSync(join(m.target, "one.txt"), "utf8")).toBe("one\nedit\n");
});

function tombstone(fixture: HubFixture, locator: string): void {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(fixture.dir, "hub.db"));
  try {
    const { id } = db.query("SELECT id FROM events LIMIT 1").get() as { id: string };
    db.run("INSERT INTO tombstones (blob, event) VALUES (?, ?)", [locator, id]);
  } finally {
    db.close();
  }
}

test("a resumed move sends only the chunks the hub lacks, under locators saved before the first PUT", async () => {
  const m = await hubMove();
  const puts: string[] = [];
  let failing = true;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    puts.push(path.slice("/v1/blobs/".length));
    if (failing && puts.length > 2) throw new TypeError("fetch failed");
    return fetch(input, init);
  }) as typeof fetch;

  const wire: MoveWire = {
    fetch: routed((method, path) => (method === "PUT" && CHUNK.test(path) ? flaky : undefined)),
    syncBudget: BUDGET,
  };

  const first = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, first.io)).toBe(1);
  expect(movedEvents(m.a.root)).toEqual([]);

  const saved = storeQuery(m.a.root, "SELECT value FROM meta WHERE key LIKE 'hub_pack:%'") as {
    value: string;
  }[];

  const record = JSON.parse(saved[0]?.value ?? "{}") as { locators?: string[] };
  expect(record.locators?.slice(0, 3)).toEqual(puts);

  const held = puts.slice(0, 2);
  const deleted = puts[2] ?? "";
  tombstone(m.fixture, deleted);

  failing = false;
  puts.length = 0;

  const rerun = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, rerun.io)).toBe(0);
  expect(rerun.err.join("")).toBe("");
  expect(rerun.out.join("")).toBe(MOVED_LINE);

  const [moved] = movedEvents(m.a.root);
  if (moved === undefined) throw new Error("no moved event");

  expect(moved.blobs.slice(0, 2)).toEqual(held);
  expect(moved.blobs).not.toContain(deleted);
  expect(puts.toSorted()).toEqual(moved.blobs.slice(2).toSorted());
  expect(puts.filter((locator) => held.includes(locator) || locator === deleted)).toEqual([]);
  expect(
    moved.blobs.filter(
      (locator) => locator.includes(moved.sha256) || moved.sha256.includes(locator),
    ),
  ).toEqual([]);

  expect(sha256(await hubPack(m.b, m.fixture, moved))).toBe(moved.sha256);
});

test("unrelated pending uploads leave a move unblocked, and only its own unsent event makes it wait", async () => {
  const m = await hubMove();
  const locator = "ab".repeat(16);
  const digest = "e".repeat(64);
  write(m.a.store, () => {
    m.a.store.db.run("INSERT INTO blobs (sha256, locator, bytes) VALUES (?, ?, ?)", [
      digest,
      locator,
      Buffer.from("unrelated"),
    ]);

    m.a.store.db.run("INSERT INTO blob_uploads (sha256, queued) VALUES (?, ?)", [digest, 1]);
  });

  let refusing = true;
  const wire: MoveWire = {
    fetch: routed((method, path) => {
      if (method === "PUT" && path === `/v1/blobs/${locator}`)
        return async () =>
          Response.json({ reason: "too-large", message: "too large" }, { status: 413 });

      if (refusing && method === "POST" && path === "/v1/events")
        return async () => Response.json({ reason: "busy", message: "refused" }, { status: 503 });

      return undefined;
    }),
    syncBudget: BUDGET,
  };

  const refused = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, refused.io)).toBe(0);
  expect(refused.err.join("")).toBe("move: the move waits to reach the hub, run skills hub sync\n");

  refusing = false;
  const moving = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, moving.io)).toBe(0);
  expect(moving.err.join("")).toBe("");
  expect(moving.out.join("")).toBe(MOVED_LINE);

  expect(storeQuery(m.a.root, "SELECT sha256 FROM blob_uploads")).toEqual([{ sha256: digest }]);
  expect(movedEvents(m.a.root)).toHaveLength(1);
});
