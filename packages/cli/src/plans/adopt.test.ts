import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { leasePlan } from "skills-core";
import { enrolled } from "../hub/enroll.ts";
import { hubLeases, keyFor, leaserOf } from "../hub/leases.ts";
import { leaseSession } from "../hub/plan-leases.ts";
import type { Io } from "../io.ts";
import type { HubFixture } from "../test/hub-fixture.ts";
import { enrolledPair, hub, runCleanup, sync, type Machine } from "../test/hub-machines.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { adoptVerb } from "./adopt.ts";
import { updateIndex } from "./commit.ts";
import { leasesIn, recordHeld } from "./leases.ts";
import { moveVerb } from "./move.ts";
import { appendEvent, locatorOf, openStore, projectMoves, write } from "./store.ts";

setDefaultTimeout(180_000);

const repo = resolve(import.meta.dir, "../../../..");
const bin = join(repo, "skills/playbook/bin/skills");
const usage = "skills plans adopt <Project> <id> [--file <path>]";
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

function storeQuery(plans: string, sql: string): unknown[] {
  const { Database } = require("bun:sqlite") as typeof import("bun:sqlite");
  const db = new Database(join(plans, "plans.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

async function repack(
  pack: string,
  out: string,
  env: NodeJS.ProcessEnv,
  edit: (dir: string, manifest: Record<string, unknown>) => void,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "plans-adopt-repack-"));
  temporary.push(dir);
  await must(["tar", "-x", "-f", pack, "-C", dir], dir, env);

  const manifest = JSON.parse(readFileSync(join(dir, "pack.json"), "utf8"));
  edit(dir, manifest);

  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => !entry.isDirectory() && entry.name !== "pack.json")
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

  const line = (path: string) => {
    const full = join(dir, path);
    return lstatSync(full).isSymbolicLink()
      ? `120000 ${sha256(readlinkSync(full))}  ${path}\n`
      : `100644 ${sha256(readFileSync(full))}  ${path}\n`;
  };

  manifest.sha256 = sha256(files.map(line).join(""));

  writeFileSync(join(dir, "pack.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await must(
    ["tar", "-c", "--format", "ustar", "--no-xattrs", "-f", out, "pack.json", ...files],
    dir,
    env,
  );
}

function plantSession(plans: string, digest: string): void {
  const store = openStore(join(plans, "plans.db"));
  const sha = sha256(digest);
  const at = Date.now();
  const where = { kind: "stored", at, project: "Demo", plan: "001" } as const;

  try {
    write(store, () => {
      store.db.run("INSERT INTO blobs (sha256, locator, bytes) VALUES (?, ?, ?)", [
        sha,
        locatorOf(store, sha),
        Buffer.from(digest),
      ]);

      appendEvent(store, {
        ...where,
        type: "session",
        payload: {
          host: "claude",
          session: "moved-session",
          branch: "feat/adopt",
          plans: ["001"],
          source: "startup",
          started: "2026-11-07T10:00:00Z",
        },
      });

      appendEvent(store, {
        ...where,
        type: "transcript",
        payload: {
          host: "claude",
          session: "moved-session",
          series: 0,
          chunk: 0,
          first: 1,
          last: 2,
          sha256: "0".repeat(64),
          blob: "0".repeat(32),
          bytes: 0,
          policy: "redacted",
          rules: "0".repeat(64),
          digest: sha,
          digestBlob: locatorOf(store, sha),
        },
      });
    });
  } finally {
    store.db.close();
  }
}

async function untouched(checkout: string, env: NodeJS.ProcessEnv): Promise<string> {
  return [
    await must(["git", "branch", "--list", "feat/adopt"], checkout, env),
    await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], checkout, env),
    await must(["git", "status", "--porcelain"], checkout, env),
  ].join("|");
}

test("a file pack lands on its branch in the recorded checkout, and every refusal changes nothing", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "plans-adopt-")));
  temporary.push(scratch);

  const dir = join(scratch, "fixture");
  const base = gitEnv(join(scratch, "home"));
  await must(
    ["bun", join(repo, "packages/cli/src/test/machine-fixture.ts"), dir, "--rows", "adopt"],
    repo,
    base,
  );

  const common = { ...base, SKILLS_CONF: join(dir, "conf") };
  const envA = { ...common, PLANS_DIR: join(dir, "plans-a") };
  const envB = { ...common, PLANS_DIR: join(dir, "plans-b") };
  const a = join(dir, "a/Demo");
  const b = join(dir, "b/Demo");

  await must([bin, "plans", "start", "Demo", "001"], a, envA);
  await halfDone(a, envA);
  writeFileSync(join(envA.PLANS_DIR, "Demo/.resume-001.md"), "note\n");

  const pack = join(dir, "pack.tar");
  await must([bin, "plans", "move", "Demo", "001", "--file", pack], a, envA);

  const adopt = (file: string) =>
    run([bin, "plans", "adopt", "Demo", "001", "--file", file], b, envB);

  const clean = await untouched(b, envB);

  const unrecorded = await adopt(pack);
  expect(unrecorded.stderr).toBe(
    "adopt: no checkout of Demo recorded on this machine, run skills machine refresh from it\n",
  );

  await must([bin, "machine", "refresh"], b, envB);

  const flipped = readFileSync(pack);
  const at = flipped.indexOf(Buffer.from("note\n"));
  flipped[at] = (flipped[at] ?? 0) ^ 1;
  writeFileSync(join(dir, "flipped.tar"), flipped);

  await repack(pack, join(dir, "zero-base.tar"), envB, (_dir, manifest) => {
    (manifest.base as { sha: string }).sha = "0".repeat(40);
  });

  await repack(pack, join(dir, "garbage.tar"), envB, (unpacked) =>
    writeFileSync(join(unpacked, "tracked.patch"), "garbage"),
  );

  await repack(pack, join(dir, "hook.tar"), envB, (unpacked) => {
    mkdirSync(join(unpacked, "untracked/.Git/hooks"), { recursive: true });
    writeFileSync(join(unpacked, "untracked/.Git/hooks/post-checkout"), "exit 0\n");
  });

  const tail = readFileSync(pack);
  tail[tail.length - 1] = 1;
  writeFileSync(join(dir, "tail.tar"), tail);

  await repack(pack, join(dir, "parent.tar"), envB, (_dir, manifest) => {
    (manifest.base as { ref: string }).ref = "feat/parent";
  });

  await repack(pack, join(dir, "refspec.tar"), envB, (_dir, manifest) => {
    manifest.base = { ref: "main:refs/heads/injected", sha: "0".repeat(40) };
  });

  const refusals = [
    ["flipped.tar", "adopt: pack sha256 does not match its moved record\n"],
    ["zero-base.tar", `adopt: base ${"0".repeat(40)} is not in origin\n`],
    ["garbage.tar", "adopt: tracked.patch is not a patch"],
    ["refspec.tar", "adopt: the pack names an invalid branch main:refs/heads/injected\n"],
    [
      "parent.tar",
      `adopt: base feat/parent is not a branch in ${b}, run git fetch origin feat/parent and adopt again\n`,
    ],
    ["tail.tar", "adopt: pack sha256 does not match its moved record\n"],
    ["hook.tar", "adopt: untracked .Git/hooks/post-checkout would land inside .git\n"],
  ] as const;

  for (const [file, refusal] of refusals) {
    const refused = await adopt(join(dir, file));
    expect(refused.code).toBe(1);
    expect(refused.stderr).toStartWith(refusal);
    expect(await untouched(b, envB)).toBe(clean);
  }

  const exclude = join(b, ".git/info/exclude");
  const excluded = readFileSync(exclude);
  expect(await must(["git", "branch", "--list", "injected"], b, envB)).toBe("");
  appendFileSync(exclude, "extra.txt\n");
  writeFileSync(join(b, "extra.txt"), "mine\n");

  writeFileSync(join(b, "dirty.txt"), "dirty\n");
  expect((await adopt(pack)).stderr).toBe(
    `adopt: ${b} has uncommitted changes, commit or clear them first\n`,
  );

  rmSync(join(b, "dirty.txt"));
  writeFileSync(join(b, ".git/MERGE_HEAD"), "0".repeat(40));
  expect((await adopt(pack)).stderr).toBe(
    `adopt: ${b} has MERGE_HEAD in progress, finish it first\n`,
  );

  rmSync(join(b, ".git/MERGE_HEAD"));

  const collided = await adopt(pack);
  expect(collided.stderr).toBe(`adopt: extra.txt already exists in ${b}, move it aside first\n`);
  expect(await untouched(b, envB)).toBe(clean);
  expect(existsSync(join(b, "one.txt"))).toBe(false);

  expect(readFileSync(join(b, "extra.txt"), "utf8")).toBe("mine\n");
  expect(existsSync(join(envB.PLANS_DIR, "Demo/.resume-001.md"))).toBe(false);
  rmSync(join(b, "extra.txt"));
  writeFileSync(exclude, excluded);

  const digest = "Prompt: finish it\nReply: half done\nTools:\nTokens:\n";
  plantSession(envB.PLANS_DIR, digest);

  expect(await must([bin, "plans", "adopt", "Demo", "001", "--file", pack], b, envB)).toBe(
    `adopted Demo 001 into ${b} on feat/adopt\n/plans do 001\nSession claude moved-session\n${digest}`,
  );

  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], b, envB)).toBe("feat/adopt\n");
  expect(await must(["git", "rev-list", "--count", "main..HEAD"], b, envB)).toBe("1\n");
  expect(await must(["git", "status", "--porcelain"], b, envB)).toBe(
    await must(["git", "status", "--porcelain"], a, envA),
  );

  const recorded = ["config", "branch.feat/adopt.skills-base"];
  expect(await must(["git", ...recorded], b, envB)).toBe(await must(["git", ...recorded], a, envA));
  expect(readFileSync(join(envB.PLANS_DIR, "Demo/.resume-001.md"), "utf8")).toBe("note\n");

  const rerun = await adopt(pack);
  expect(rerun.code).toBe(1);
  expect(rerun.stderr).toBe(`adopt: feat/adopt already exists in ${b}\n`);

  expect(
    storeQuery(
      envB.PLANS_DIR,
      "SELECT payload ->> '$.checkout' AS c, payload ->> '$.branch' AS b, payload ->> '$.sha256' AS s FROM events WHERE type = 'adopted'",
    ),
  ).toEqual([{ c: b, b: "feat/adopt", s: sha256(readFileSync(pack)) }]);

  const frontier = await must([bin, "plans", "frontier", "Demo"], b, envB);
  expect(frontier).toContain("DOING 001 adopt feat/adopt\n");
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

async function holderOf(m: Machine, fixture: HubFixture): Promise<string | undefined> {
  const current = await enrolled(m.deps, fixture.url, false);
  const leaser = await leaserOf(current, (method, path, body) =>
    current.client.call(method, path, body, current.signer),
  );

  if (leaser === undefined) throw new Error("no leaser");
  return (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", "001"))?.holder;
}

test("a hub pack is fetched from the newest moved event, and a failed adopt hands the lease back", async () => {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const envA = envOf(a, fixture);
  const envB = envOf(b, fixture);

  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "plans-adopt-hub-")));
  temporary.push(scratch);

  const source = join(scratch, "a", "Skills");
  await must(["git", "init", "-q", "-b", "main", source], repo, envA);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    source,
    envA,
  );

  mkdirSync(join(source, "dir"));
  writeFileSync(join(source, "dir/child"), "child\n");
  await must(["git", "add", "dir/child"], source, envA);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "dir"], source, envA);

  const target = join(scratch, "b", "Skills");
  await must(["git", "clone", "-q", source, target], repo, envB);

  await must(["git", "checkout", "-q", "-b", "feat/one"], source, envA);
  await must(["git", "config", "branch.feat/one.skills-base", "main"], source, envA);
  await halfDone(source, envA);

  await must(["git", "rm", "-rq", "dir"], source, envA);
  writeFileSync(join(source, "dir"), "file\n");
  await must(["git", "add", "dir"], source, envA);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "flat"], source, envA);

  writeFileSync(join(source, "\ttab.txt"), "tab\n");
  await must(["git", "add", "\ttab.txt"], source, envA);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "tab"], source, envA);

  writeFileSync(join(source, "\ttab.txt"), "tab\nedit\n");
  writeFileSync(join(source, "added.txt"), "added\n");
  await must(["git", "add", "added.txt"], source, envA);

  await updateIndex(join(a.root, "Skills", "index.tsv"), (rows) => {
    for (const row of rows)
      if (row.id === "001") Object.assign(row, { status: "DOING", branch: "feat/one" });
  });

  writeFileSync(join(a.root, "Skills/.resume-001.md"), "note\n");

  const session = await leaseSession(envA);
  const taken = await session.start("Skills", "001");
  session.close();
  if (taken.kind !== "taken") throw new Error(`no lease taken: ${taken.kind}`);

  write(a.store, () => recordHeld(a.store, Date.now(), "Skills", "001", taken.held));

  const ioOf = (cwd: string, env: NodeJS.ProcessEnv) => {
    const lines: string[] = [];
    const errors: string[] = [];
    const io: Io = {
      cwd,
      env,
      out: (text) => lines.push(text),
      err: (text) => errors.push(text),
      capture: true,
    };

    return { io, lines, errors };
  };

  const moving = ioOf(source, envA);
  const moveUsage = "skills plans move <Project> <id> [--to <label | device id> | --file <path>]";
  expect(await moveVerb(["Skills", "001", "--to", "B"], moveUsage, moving.io)).toBe(0);

  await sync(a, fixture.url);
  await sync(b, fixture.url);
  await must([bin, "machine", "refresh"], target, envB);

  const project = join(b.root, "Skills");
  chmodSync(project, 0o555);

  const failed = ioOf(target, envB);
  try {
    expect(await adoptVerb(["Skills", "001"], usage, failed.io)).toBe(1);
  } finally {
    chmodSync(project, 0o755);
  }

  expect(failed.errors.join("")).toContain(".resume-001.md");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "branch", "--list", "feat/one"], target, envB)).toBe("");
  expect(await must(["git", "status", "--porcelain", "--ignored"], target, envB)).toBe("");

  expect(await holderOf(b, fixture)).toBeUndefined();
  expect(readFileSync(join(target, "dir/child"), "utf8")).toBe("child\n");

  const adopted = ioOf(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, adopted.io)).toBe(0);
  expect(adopted.lines.join("")).toBe(
    `adopted Skills 001 into ${target} on feat/one\n/plans do 001\n`,
  );

  expect(await must(["git", "status", "--porcelain"], target, envB)).toBe(
    ' M "\\ttab.txt"\n M one.txt\n?? added.txt\n?? extra.txt\n',
  );

  expect(readFileSync(join(target, "dir"), "utf8")).toBe("file\n");

  const self = leasesIn(b.store, "Skills").get(leasePlan("Skills", "001"));
  const holder = await holderOf(b, fixture);
  expect(holder).toBeDefined();
  expect([...(self?.claims.keys() ?? [])]).toEqual([holder ?? ""]);
  expect(projectMoves(b.store, "Skills").has("001")).toBe(false);

  const again = ioOf(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, again.io)).toBe(1);
  expect(again.errors.join("")).toBe("adopt: 001 is already adopted here on feat/one\n");
});
