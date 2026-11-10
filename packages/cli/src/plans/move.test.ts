import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { envelopeEpoch, leasePlan, movedFrom, open, subkey, type Moved } from "skills-core";
import { enrolled } from "../hub/enroll.ts";
import { leaseSession, pinPlans } from "../hub/plan-leases.ts";
import { hubLeases, keyFor, leaserOf } from "../hub/leases.ts";
import type { Io } from "../io.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import { enrolledPair, hub, runCleanup, sync, type Machine } from "../test/hub-machines.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { updateIndex } from "./commit.ts";
import { leasesIn, readMoveRefusal, recordHeld } from "./leases.ts";
import { moveVerb } from "./move.ts";
import { write } from "./store.ts";

setDefaultTimeout(120_000);

const repo = resolve(import.meta.dir, "../../../..");
const bin = join(repo, "skills/playbook/bin/skills");
const usage = "skills plans move <Project> <id> [--to <label | device id> | --file <path>]";
const temporary: string[] = [];

afterEach(async () => {
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
  expect(await moveVerb(["Skills", "001", "--to", "B"], usage, io)).toBe(0);
  expect(count()).toEqual([{ n: 1 }]);

  const file = join(checkout, "..", "pack.tar");
  expect(await moveVerb(["Skills", "001", "--file", file], usage, io)).toBe(0);
  expect(count()).toEqual([{ n: 2 }]);
  expect(sha256(readFileSync(file))).not.toBe(moved.sha256);
});
