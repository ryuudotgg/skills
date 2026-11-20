import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { envelopeEpoch, leasePlan, movedFrom, open, subkey, type Moved } from "skills-core";
import { enrolled } from "../hub/enroll.ts";
import { leaseSession, pinPlans } from "../hub/plan-leases.ts";
import { LONG_BUDGET } from "../hub/sync.ts";
import type { MoveWire } from "../hub/move.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import {
  bin,
  capture,
  envOf,
  gitEnv,
  halfDone,
  holderOf,
  must,
  repo,
  run,
  scratch,
  storeQuery,
} from "../test/hub-checkout.ts";
import {
  deletedOn,
  enrolledPair,
  hub,
  runCleanup,
  slowFetch,
  sync,
  type Machine,
  type Wire,
} from "../test/hub-machines.ts";
import { adoptVerb } from "./adopt.ts";
import { markStarted } from "./claim.ts";
import { updateIndex } from "./commit.ts";
import { enrolledDevice, leasesIn, readMoveRefusal, recordHeld } from "./leases.ts";
import { moveVerb } from "./move.ts";
import { stop, tombstone as tombstoneHere } from "./outbox.ts";
import { projectRows, sha256, write } from "./store.ts";

setDefaultTimeout(120_000);

const usage = "skills plans move <Project> <id> [--to <label | device id> | --file <path>]";
const realNow = Date.now;

afterEach(async () => {
  Date.now = realNow;
  await runCleanup();
});

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

test("a file move packs the half done work, repeats byte for byte, and marks the row moving", async () => {
  const root = scratch("plans-move-");
  const dir = join(root, "fixture");

  const base = gitEnv(join(root, "home"));
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

test("a move refuses submodule work and still moves a checkout whose submodule is untouched", async () => {
  const root = scratch("plans-move-");
  const dir = join(root, "fixture");

  const base = gitEnv(join(root, "home"));
  await must(
    ["bun", join(repo, "packages/cli/src/test/machine-fixture.ts"), dir, "--rows", "move"],
    repo,
    base,
  );

  const plans = join(dir, "plans-a");
  const env = { ...base, PLANS_DIR: plans, SKILLS_CONF: join(dir, "conf") };
  const checkout = join(dir, "a/Demo");

  const lib = join(checkout, "lib");
  const commit = ["git", "-c", "commit.gpgsign=false", "commit", "-qm"];
  const fileGit = ["git", "-c", "protocol.file.allow=always"];

  const upstream = join(dir, "lib.git");
  await must(["git", "init", "-q", "-b", "main", upstream], dir, env);

  for (const text of ["first\n", "second\n"]) {
    writeFileSync(join(upstream, "lib.txt"), text);
    await must(["git", "add", "lib.txt"], upstream, env);
    await must([...commit, text.trim()], upstream, env);
  }

  const [second, first] = (await must(["git", "rev-list", "main"], upstream, env)).split("\n");
  if (first === undefined || second === undefined) throw new Error("lib has no two commits");

  await must([...fileGit, "submodule", "add", "-q", upstream, "lib"], checkout, env);
  await must(["git", "checkout", "-q", first], lib, env);
  await must(["git", "add", "lib"], checkout, env);
  await must([...commit, "lib"], checkout, env);
  await must(["git", "push", "-q", "origin", "main"], checkout, env);

  await must([bin, "plans", "start", "Demo", "001"], checkout, env);
  writeFileSync(join(plans, "Demo/.resume-001.md"), "note\n");

  const pack = join(dir, "pack.tar");
  const refused = "move: submodule lib changed, a pack cannot carry submodule work\n";
  const refuses = async () => {
    const before = await must(["git", "status", "--porcelain"], checkout, env);
    const result = await run([bin, "plans", "move", "Demo", "001", "--file", pack], checkout, env);
    expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 1, stderr: refused });
    expect(existsSync(pack)).toBe(false);
    expect(storeQuery(plans, "SELECT count(*) AS n FROM events WHERE type = 'moved'")).toEqual([
      { n: 0 },
    ]);

    expect(await must(["git", "status", "--porcelain"], checkout, env)).toBe(before);
  };

  const restore = async () => {
    await must(["git", "checkout", "-q", "--detach", first], lib, env);
    await must(["git", "reset", "-q", "--hard"], lib, env);
    await must(["git", "clean", "-qfd"], lib, env);
  };

  const cases: (() => Promise<unknown>)[] = [
    async () => writeFileSync(join(lib, "lib.txt"), "edited\n"),
    async () => writeFileSync(join(lib, "new.txt"), "new\n"),
    () => must(["git", "checkout", "-q", second], lib, env),
    async () => {
      await must(["git", "config", "submodule.lib.ignore", "all"], checkout, env);
      writeFileSync(join(lib, "lib.txt"), "edited\n");
    },
  ];

  for (const make of cases) {
    await make();
    await refuses();
    await restore();
  }

  await must(["git", "config", "--unset", "submodule.lib.ignore"], checkout, env);

  await must(["git", "checkout", "-q", second], lib, env);
  await must(["git", "add", "lib"], checkout, env);
  await must([...commit, "move lib"], checkout, env);
  expect(await must(["git", "status", "--porcelain"], checkout, env)).toBe("");
  await refuses();

  await must(["git", "checkout", "-q", first], lib, env);
  await must(["git", "add", "lib"], checkout, env);
  await must([...commit, "restore lib"], checkout, env);
  expect(await must(["git", "status", "--porcelain"], checkout, env)).toBe("");
  await refuses();

  await must(["git", "reset", "-q", "--hard", "HEAD~2"], checkout, env);
  await must([...fileGit, "submodule", "update", "-q"], checkout, env);

  const mark = (await must(["git", "rev-parse", "HEAD"], checkout, env)).trim();
  const empty = ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m"];

  await must(["git", "checkout", "-q", "-b", "side"], checkout, env);
  await must([...empty, "side"], checkout, env);
  await must(["git", "checkout", "-q", "-"], checkout, env);
  await must([...empty, "ahead"], checkout, env);
  await must(["git", "merge", "-q", "--no-ff", "--no-commit", "side"], checkout, env);

  await must(["git", "checkout", "-q", second], lib, env);
  await must(["git", "add", "lib"], checkout, env);
  await must([...commit, "merge side"], checkout, env);
  expect(await must(["git", "status", "--porcelain"], checkout, env)).toBe("");
  await refuses();

  await must(["git", "reset", "-q", "--hard", mark], checkout, env);
  await must(["git", "checkout", "-q", "-b", "old", `${mark}~1`], checkout, env);
  await must([...empty, "old"], checkout, env);
  await must(["git", "checkout", "-q", "-"], checkout, env);
  await must(["git", "merge", "-q", "--no-ff", "--no-commit", "old"], checkout, env);

  await must(["git", "rm", "-q", "--cached", "lib"], checkout, env);
  await must([...commit, "merge old"], checkout, env);
  await refuses();

  await must(["git", "reset", "-q", "--hard", mark], checkout, env);
  await must([...fileGit, "submodule", "update", "-q"], checkout, env);
  await halfDone(checkout, env);

  const moved = await must([bin, "plans", "move", "Demo", "001", "--file", pack], checkout, env);
  expect(moved).toBe(
    `moved Demo 001 to ${pack}, 1 commits, 1 changed files, 1 untracked\n/plans do 001\n`,
  );
});

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

  const checkout = join(scratch("plans-move-hub-"), "Skills");
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

  const { io, out: lines, err: errors } = capture(checkout, env);

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

  expect(await holderOf(a, fixture.url, "001")).toBeUndefined();

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

  const root = realpathSync(scratch("plans-move-budget-"));
  const source = join(root, "a", "Skills");
  await must(["git", "init", "-q", "-b", "main", source], repo, env);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    source,
    env,
  );

  const target = join(root, "b", "Skills");
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

test("a pin refuses a row moved while a pin waited, and gives back the lease it took", async () => {
  const m = await hubMove();
  const real = globalThis.fetch;
  let moving = false;
  let moved = false;

  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
    const listing = (init?.method ?? "GET") === "GET" && path === "/v1/leases";
    if (listing && !moving && !moved) {
      moving = true;
      const { io, err } = capture(m.source, m.env);
      const code = await moveVerb(["Skills", "001", "--to", "B"], usage, io);
      if (code !== 0) throw new Error(`move failed: ${err.join("")}`);

      moved = true;
    }

    return real(input, init);
  }) as typeof fetch);

  let lines: Awaited<ReturnType<typeof pinPlans>>;
  try {
    lines = await pinPlans("Skills", ["001"], "1d", m.env);
  } finally {
    spy.mockRestore();
  }

  expect(moved).toBe(true);
  expect(lines).toEqual([{ id: "001", line: "pin 001 refused: 001 is moving to B", ok: false }]);

  const self = (await enrolled(m.a.deps, m.fixture.url, false)).device;
  const claim = leasesIn(m.a.store, "Skills").get(leasePlan("Skills", "001"))?.claims.get(self);
  expect(claim?.pinned ?? false).toBe(false);
  expect(await holderOf(m.a, m.fixture.url, "001")).not.toBe(self);
});

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

function tombstoned(root: string): string[] {
  const rows = storeQuery(
    root,
    "SELECT payload ->> '$.blob' AS blob FROM events WHERE type = 'blob-deleted' ORDER BY blob",
  ) as { blob: string }[];

  return rows.map((row) => row.blob);
}

function tombstonedAfter(root: string, type: string): boolean {
  const [row] = storeQuery(
    root,
    `SELECT (SELECT min(seq) FROM events WHERE type = 'blob-deleted')
       > (SELECT max(seq) FROM events WHERE type = '${type}') AS later`,
  ) as { later: number }[];

  return row?.later === 1;
}

function savedRecord(root: string): string[] {
  const rows = storeQuery(root, "SELECT value FROM meta WHERE key LIKE 'hub_pack:%'") as {
    value: string;
  }[];

  return (JSON.parse(rows[0]?.value ?? "{}") as { locators?: string[] }).locators ?? [];
}

function changeTracked(m: HubMove, text: string): void {
  writeFileSync(join(m.source, "one.txt"), `one\n${text}\n`);
}

function chunkOf(input: string | URL | Request): string {
  const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
  return path.slice("/v1/blobs/".length);
}

const BUSY = async () => Response.json({ reason: "busy", message: "refused" }, { status: 503 });

test("replaced pack chunks are tombstoned when a changed pack moves again", async () => {
  const m = await hubMove();
  const first = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, first.io)).toBe(0);

  const [replaced] = movedEvents(m.a.root);
  if (replaced === undefined) throw new Error("no moved event");

  changeTracked(m, "changed");
  const held: MoveWire = {
    fetch: routed((method, path) =>
      method === "POST" && path === "/v1/events" ? BUSY : undefined,
    ),
    syncBudget: BUDGET,
  };

  const second = capture(m.source, m.env, held);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, second.io)).toBe(0);
  expect(second.err.join("")).toBe("move: the move waits to reach the hub, run skills hub sync\n");

  const replacing = movedEvents(m.a.root).at(-1);
  if (replacing === undefined) throw new Error("no second moved event");

  expect(replacing.sha256).not.toBe(replaced.sha256);
  expect(tombstoned(m.a.root)).toEqual(replaced.blobs.toSorted());
  expect(tombstonedAfter(m.a.root, "moved")).toBe(true);

  expect(await sync(m.a, m.fixture.url)).toContain(`deleted ${replaced.blobs.length} blobs`);
  expect(await deletedOn(m.a, m.fixture.url, [...replaced.blobs, ...replacing.blobs])).toEqual(
    replaced.blobs.toSorted(),
  );

  expect(sha256(await hubPack(m.b, m.fixture, replacing))).toBe(replacing.sha256);
});

test("replaced pack chunks of a failed attempt are tombstoned before the rerun's first PUT", async () => {
  const m = await hubMove();
  const puts: string[] = [];
  let failing = true;
  let atFirstPut: string[] | undefined;
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!failing) atFirstPut ??= tombstoned(m.a.root);
    puts.push(chunkOf(input));
    if (failing && puts.length > 1) throw new TypeError("fetch failed");
    return fetch(input, init);
  }) as typeof fetch;

  const wire: MoveWire = {
    fetch: routed((method, path) => (method === "PUT" && CHUNK.test(path) ? flaky : undefined)),
    syncBudget: BUDGET,
  };

  const first = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, first.io)).toBe(1);
  expect(movedEvents(m.a.root)).toEqual([]);

  const failed = savedRecord(m.a.root);
  expect(failed.slice(0, 2)).toEqual(puts);
  expect(tombstoned(m.a.root)).toEqual([]);

  changeTracked(m, "changed");
  failing = false;

  const rerun = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, rerun.io)).toBe(0);
  expect(rerun.err.join("")).toBe("");
  expect(atFirstPut).toEqual(failed.toSorted());

  const [moved] = movedEvents(m.a.root);
  if (moved === undefined) throw new Error("no moved event");

  await sync(m.a, m.fixture.url);
  expect(await deletedOn(m.a, m.fixture.url, [...failed, ...moved.blobs])).toEqual(
    failed.toSorted(),
  );
});

test("replaced pack chunks of a failed hub attempt are tombstoned when changed work moves by file", async () => {
  const m = await hubMove();
  const puts: string[] = [];
  const flaky = (async (input: string | URL | Request, init?: RequestInit) => {
    puts.push(chunkOf(input));
    if (puts.length > 1) throw new TypeError("fetch failed");
    return fetch(input, init);
  }) as typeof fetch;

  const wire: MoveWire = {
    fetch: routed((method, path) => (method === "PUT" && CHUNK.test(path) ? flaky : undefined)),
    syncBudget: BUDGET,
  };

  const first = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, first.io)).toBe(1);

  const failed = savedRecord(m.a.root);
  expect(failed.length).toBeGreaterThan(1);

  changeTracked(m, "changed");
  const file = join(m.source, "..", "pack.tar");
  const moving = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001", "--file", file], usage, moving.io)).toBe(0);
  expect(moving.err.join("")).toBe("");

  expect(savedRecord(m.a.root)).toEqual([]);
  expect(tombstoned(m.a.root)).toEqual(failed.toSorted());

  await sync(m.a, m.fixture.url);
  expect(await deletedOn(m.a, m.fixture.url, failed)).toEqual(failed.toSorted());
});

test("replaced pack chunks of a move refused at record are tombstoned", async () => {
  const m = await hubMove();
  const first = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, first.io)).toBe(0);

  const [live] = movedEvents(m.a.root);
  if (live === undefined) throw new Error("no moved event");

  changeTracked(m, "changed");
  const puts: string[] = [];
  const taking = (async (input: string | URL | Request, init?: RequestInit) => {
    puts.push(chunkOf(input));
    const response = await fetch(input, init);
    if (puts.length > 1) return response;

    const session = await leaseSession(m.envB);
    const taken = await session.start("Skills", "001");
    session.close();
    if (taken.kind !== "taken") throw new Error(`no lease taken: ${taken.kind}`);
    return response;
  }) as typeof fetch;

  const wire: MoveWire = {
    fetch: routed((method, path) => (method === "PUT" && CHUNK.test(path) ? taking : undefined)),
    syncBudget: BUDGET,
  };

  const refused = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, refused.io)).toBe(1);
  expect(refused.err.join("")).toBe("move: 001 is held by B\n");
  expect(movedEvents(m.a.root)).toEqual([live]);

  const uploaded = savedRecord(m.a.root);
  expect(uploaded.length).toBeGreaterThan(1);
  expect(puts).toEqual(uploaded);

  await sync(m.a, m.fixture.url);
  expect(await deletedOn(m.a, m.fixture.url, [...uploaded, ...live.blobs])).toEqual(
    uploaded.toSorted(),
  );
});

test("a move whose chunks are tombstoned during its upload refuses, and the rerun claims fresh ones", async () => {
  const m = await hubMove();
  let dropped: string | undefined;
  const dropping = (async (input: string | URL | Request, init?: RequestInit) => {
    const response = await fetch(input, init);
    if (dropped !== undefined) return response;

    dropped = chunkOf(input);
    write(m.a.store, () => tombstoneHere(m.a.store, "Skills", [dropped ?? ""]));
    return response;
  }) as typeof fetch;

  const wire: MoveWire = {
    fetch: routed((method, path) => (method === "PUT" && CHUNK.test(path) ? dropping : undefined)),
    syncBudget: BUDGET,
  };

  const refused = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, refused.io)).toBe(1);
  expect(refused.err.join("")).toBe(
    "move: the pack's chunks were dropped during the upload, run the move again\n",
  );

  expect(movedEvents(m.a.root)).toEqual([]);

  const claimed = savedRecord(m.a.root);
  expect(tombstoned(m.a.root)).toEqual(claimed.toSorted());

  const rerun = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, rerun.io)).toBe(0);
  expect(rerun.err.join("")).toBe("");

  const [moved] = movedEvents(m.a.root);
  if (moved === undefined) throw new Error("no moved event");

  expect(moved.blobs.filter((locator) => claimed.includes(locator))).toEqual([]);
  expect(sha256(await hubPack(m.b, m.fixture, moved))).toBe(moved.sha256);
});

async function adoptOnB(m: HubMove): Promise<void> {
  await sync(m.a, m.fixture.url);
  await sync(m.b, m.fixture.url);
  await must([bin, "machine", "refresh"], m.target, m.envB);

  const adopting = capture(m.target, m.envB);
  const adoptUsage = "skills plans adopt <Project> <id> [--file <path>]";
  expect(await adoptVerb(["Skills", "001"], adoptUsage, adopting.io)).toBe(0);
  expect(adopting.err.join("")).toBe("");
}

test("started move chunks are tombstoned, and the same pack moves again under fresh locators", async () => {
  const m = await hubMove();
  const first = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001"], usage, first.io)).toBe(0);
  expect(first.err.join("")).toBe("");

  const [moved] = movedEvents(m.a.root);
  if (moved === undefined) throw new Error("no moved event");

  const index = join(m.a.root, "Skills", "index.tsv");
  const row = projectRows(m.a.store, "Skills").filter((entry) => entry.id === "001");
  expect(await markStarted(index, "Skills", "feat/one", row, m.env)).toMatchObject([
    { id: "001", status: "DOING" },
  ]);

  expect(tombstonedAfter(m.a.root, "start")).toBe(true);

  await sync(m.a, m.fixture.url);
  expect(await deletedOn(m.a, m.fixture.url, moved.blobs)).toEqual(moved.blobs.toSorted());

  const again = capture(m.source, m.env);
  expect(await moveVerb(["Skills", "001"], usage, again.io)).toBe(0);
  expect(again.err.join("")).toBe("");

  const second = movedEvents(m.a.root).at(-1);
  expect(second?.sha256).toBe(moved.sha256);
  expect(second?.blobs.filter((locator) => moved.blobs.includes(locator))).toEqual([]);
  expect(await deletedOn(m.a, m.fixture.url, second?.blobs ?? [])).toEqual([]);

  await adoptOnB(m);
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

test("a halted store refuses a hub move before its upload, and a halted target refuses adopt before its download", async () => {
  const m = await hubMove();
  const chunks: string[] = [];
  const wire: MoveWire = {
    fetch: routed((method, path) => {
      if (CHUNK.test(path)) chunks.push(method);
      return undefined;
    }),
    syncBudget: BUDGET,
  };

  const source = enrolledDevice(m.a.store) ?? "";
  stop(m.a.store, { device: source, reason: "sequence-taken" });

  const refused = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, refused.io)).toBe(1);
  expect(refused.out.join("")).toBe("");
  expect(refused.err.join("")).toBe("move: sync is stopped on this machine, run skills hub sync\n");

  expect(chunks).toEqual([]);
  expect(storeQuery(m.a.root, "SELECT key FROM meta WHERE key LIKE 'hub_pack:%'")).toEqual([]);
  expect(movedEvents(m.a.root)).toEqual([]);
  expect(leasesIn(m.a.store, "Skills").get(leasePlan("Skills", "001"))?.claims.has(source)).toBe(
    true,
  );

  stop(m.a.store, undefined);
  const moving = capture(m.source, m.env, wire);
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, moving.io)).toBe(0);
  expect(moving.err.join("")).toBe("");

  await sync(m.a, m.fixture.url);
  await sync(m.b, m.fixture.url);
  await must([bin, "machine", "refresh"], m.target, m.envB);
  stop(m.b.store, { device: enrolledDevice(m.b.store) ?? "", reason: "sequence-taken" });
  chunks.length = 0;

  const adopting = capture(m.target, m.envB, wire);
  const adoptUsage = "skills plans adopt <Project> <id> [--file <path>]";
  expect(await adoptVerb(["Skills", "001"], adoptUsage, adopting.io)).toBe(1);
  expect(adopting.err.join("")).toBe(
    "adopt: sync is stopped on this machine, run skills hub sync\n",
  );

  expect(chunks).toEqual([]);
});
