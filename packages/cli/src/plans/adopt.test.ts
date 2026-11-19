import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { leasePlan } from "skills-core";
import { leaseSession } from "../hub/plan-leases.ts";
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
import { deletedOn, enrolledPair, hub, runCleanup, sync } from "../test/hub-machines.ts";
import { adoptVerb } from "./adopt.ts";
import { updateIndex } from "./commit.ts";
import { leasesIn, recordHeld } from "./leases.ts";
import { moveVerb } from "./move.ts";
import { appendEvent, locatorOf, openStore, projectMoves, sha256, write } from "./store.ts";

setDefaultTimeout(180_000);

const usage = "skills plans adopt <Project> <id> [--file <path>]";

afterEach(runCleanup);

async function repack(
  pack: string,
  out: string,
  env: NodeJS.ProcessEnv,
  edit: (dir: string, manifest: Record<string, unknown>) => void,
): Promise<void> {
  const dir = scratch("plans-adopt-repack-");
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
  const root = realpathSync(scratch("plans-adopt-"));
  const dir = join(root, "fixture");
  const base = gitEnv(join(root, "home"));
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

const LINES = "1\n2\n3\n4\n5\n6\n7\n8\n9\n";
async function movedToB(edit?: (source: string, env: NodeJS.ProcessEnv) => Promise<void>) {
  const fixture = await hub();
  const { a, b } = await enrolledPair(fixture);
  const envA = envOf(a, fixture);
  const envB = envOf(b, fixture);

  const root = realpathSync(scratch("plans-adopt-hub-"));
  const source = join(root, "a", "Skills");
  await must(["git", "init", "-q", "-b", "main", source], repo, envA);
  await must(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    source,
    envA,
  );

  mkdirSync(join(source, "base"));
  writeFileSync(join(source, "base/keep.txt"), "keep\n");
  writeFileSync(join(source, "z.txt"), LINES);
  writeFileSync(join(source, "old.txt"), "old\n");

  mkdirSync(join(source, "dir"));
  writeFileSync(join(source, "dir/child"), "child\n");
  await must(["git", "add", "base/keep.txt", "z.txt", "old.txt", "dir/child"], source, envA);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "dir"], source, envA);

  const target = join(root, "b", "Skills");
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

  await edit?.(source, envA);

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

  const moving = capture(source, envA);
  const moveUsage = "skills plans move <Project> <id> [--to <label | device id> | --file <path>]";
  expect(await moveVerb(["Skills", "001", "--to", "B"], moveUsage, moving.io)).toBe(0);

  await sync(a, fixture.url);
  await sync(b, fixture.url);
  await must([bin, "machine", "refresh"], target, envB);

  return { fixture, b, envB, target, project: join(b.root, "Skills") };
}

function hook(checkout: string, name: string, body: string): void {
  writeFileSync(join(checkout, ".git/hooks", name), `#!/bin/sh\n${body}`, { mode: 0o755 });
}

function onCreate(branch: string, body: string): string {
  return `[ "$1" = committed ] || exit 0
while read -r old new ref; do
  case "$ref:$old" in
    refs/heads/${branch}:*[!0]*) ;;
    refs/heads/${branch}:*) ${body} ;;
  esac
done
exit 0
`;
}

async function failAdopt(project: string, target: string, env: NodeJS.ProcessEnv) {
  const failed = capture(target, env);
  chmodSync(project, 0o555);
  try {
    expect(await adoptVerb(["Skills", "001"], usage, failed.io)).toBe(1);
  } finally {
    chmodSync(project, 0o755);
  }

  return failed.err.join("");
}

test("a hub pack is fetched from the newest moved event, and a failed adopt hands the lease back", async () => {
  const { fixture, b, envB, target } = await movedToB();

  const project = join(b.root, "Skills");
  chmodSync(project, 0o555);

  const failed = capture(target, envB);
  try {
    expect(await adoptVerb(["Skills", "001"], usage, failed.io)).toBe(1);
  } finally {
    chmodSync(project, 0o755);
  }

  expect(failed.err.join("")).toContain(".resume-001.md");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "branch", "--list", "feat/one"], target, envB)).toBe("");
  expect(await must(["git", "status", "--porcelain", "--ignored"], target, envB)).toBe("");
  expect(await must(["git", "ls-files", "added.txt"], target, envB)).toBe("");

  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();
  expect(readFileSync(join(target, "dir/child"), "utf8")).toBe("child\n");

  const adopted = capture(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, adopted.io)).toBe(0);
  expect(adopted.out.join("")).toBe(
    `adopted Skills 001 into ${target} on feat/one\n/plans do 001\n`,
  );

  expect(await must(["git", "status", "--porcelain"], target, envB)).toBe(
    ' M "\\ttab.txt"\n A added.txt\n M one.txt\n?? extra.txt\n',
  );

  expect(readFileSync(join(target, "dir"), "utf8")).toBe("file\n");

  const self = leasesIn(b.store, "Skills").get(leasePlan("Skills", "001"));
  const holder = await holderOf(b, fixture.url, "001");
  expect(holder).toBeDefined();
  expect([...(self?.claims.keys() ?? [])]).toEqual([holder ?? ""]);
  expect(projectMoves(b.store, "Skills").has("001")).toBe(false);

  const again = capture(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, again.io)).toBe(1);
  expect(again.err.join("")).toBe("adopt: 001 is already adopted here on feat/one\n");

  await must(["git", "-c", "commit.gpgsign=false", "commit", "-aqm", "adopted"], target, envB);
  expect(await must(["git", "ls-tree", "--name-only", "HEAD", "added.txt"], target, envB)).toBe(
    "added.txt\n",
  );
});

test("a patch that swaps a file and a directory adopts, and a failed adopt restores the index", async () => {
  const { envB, target, project } = await movedToB(async (source, env) => {
    await must(["git", "rm", "-rq", "base", "old.txt"], source, env);
    writeFileSync(join(source, "base"), "flat\n");
    mkdirSync(join(source, "old.txt"));
    writeFileSync(join(source, "old.txt/inner"), "inner\n");
    await must(["git", "add", "base", "old.txt/inner"], source, env);
  });

  await must(["git", "update-index", "--assume-unchanged", "base/keep.txt"], target, envB);
  expect(await failAdopt(project, target, envB)).toContain(".resume-001.md");
  expect(await must(["git", "status", "--porcelain", "--ignored"], target, envB)).toBe("");
  expect(await must(["git", "ls-files", "-v", "base", "old.txt"], target, envB)).toBe(
    "h base/keep.txt\nH old.txt\n",
  );

  const adopted = capture(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, adopted.io)).toBe(0);
  expect(await must(["git", "status", "--porcelain"], target, envB)).toBe(
    ' M "\\ttab.txt"\n A added.txt\n A base\nD  base/keep.txt\nD  old.txt\n A old.txt/inner\n M one.txt\n?? extra.txt\n',
  );
});

test("adopted pack chunks are tombstoned by the machine that adopts them", async () => {
  const { fixture, b, envB, target } = await movedToB();
  const moved = projectMoves(b.store, "Skills").get("001");
  if (moved === undefined) throw new Error("no moved event on B");

  expect(await deletedOn(b, fixture.url, moved.blobs)).toEqual([]);

  const adopted = capture(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, adopted.io)).toBe(0);
  expect(adopted.err.join("")).toBe("");
  expect(adopted.out.join("")).toBe(
    `adopted Skills 001 into ${target} on feat/one\n/plans do 001\n`,
  );

  await sync(b, fixture.url);
  expect(await deletedOn(b, fixture.url, moved.blobs)).toEqual(moved.blobs.toSorted());
});

test("an edit made after the checks survives a refused switch", async () => {
  const { fixture, b, envB, target, project } = await movedToB();
  appendFileSync(join(target, ".git/info/exclude"), "one.txt\n");
  hook(
    target,
    "reference-transaction",
    onCreate(
      "feat/one",
      `printf 'hook child\\n' > '${target}/dir/child'; printf 'hook one\\n' > '${target}/one.txt'`,
    ),
  );

  const failed = capture(target, envB);
  expect(await adoptVerb(["Skills", "001"], usage, failed.io)).toBe(1);
  expect(failed.err.join("")).toStartWith("adopt: git switch failed: ");
  expect(failed.err.join("")).toContain("would be overwritten");

  expect(readFileSync(join(target, "dir/child"), "utf8")).toBe("hook child\n");
  expect(readFileSync(join(target, "one.txt"), "utf8")).toBe("hook one\n");

  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "branch", "--list", "feat/one"], target, envB)).toBe("");
  expect(existsSync(join(project, ".resume-001.md"))).toBe(false);
  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();
});

test("a carried edit survives a failed adopt", async () => {
  const { envB, target, project } = await movedToB();
  hook(
    target,
    "reference-transaction",
    onCreate("feat/one", `printf 'hook keep\\n' > '${target}/base/keep.txt'`),
  );

  expect(await failAdopt(project, target, envB)).toContain(".resume-001.md");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "branch", "--list", "feat/one"], target, envB)).toBe("");
  expect(await must(["git", "status", "--porcelain"], target, envB)).toBe(" M base/keep.txt\n");
  expect(readFileSync(join(target, "base/keep.txt"), "utf8")).toBe("hook keep\n");
});

test("a failed adopt leaves the index entries it did not write", async () => {
  const { envB, target, project } = await movedToB(async (source) => {
    writeFileSync(join(source, "z.txt"), LINES.replace("9\n", "nine\n"));
    writeFileSync(join(source, "base/keep.txt"), "keep\nedit\n");
  });

  await must(["git", "update-index", "--assume-unchanged", "base/keep.txt"], target, envB);
  const z = join(target, "z.txt");
  hook(
    target,
    "reference-transaction",
    onCreate(
      "feat/one",
      `printf 'staged\\n${LINES}' > '${z}'; git -C '${target}' add z.txt; printf 'worktree\\n${LINES}' > '${z}'`,
    ),
  );

  expect(await failAdopt(project, target, envB)).toContain(".resume-001.md");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "status", "--porcelain"], target, envB)).toBe("MM z.txt\n");
  expect(await must(["git", "show", ":z.txt"], target, envB)).toBe(`staged\n${LINES}`);
  expect(readFileSync(z, "utf8")).toBe(`worktree\n${LINES}`);
  expect(await must(["git", "ls-files", "-v", "base/keep.txt"], target, envB)).toBe(
    "h base/keep.txt\n",
  );
});

test("a failed adopt keeps a new file someone staged after the patch", async () => {
  const { envB, target, project } = await movedToB();
  hook(
    target,
    "post-index-change",
    `cd '${target}' && git ls-files -s added.txt | grep -q e69de29 && git add added.txt\nexit 0\n`,
  );

  expect(await failAdopt(project, target, envB)).toContain(".resume-001.md");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "show", ":added.txt"], target, envB)).toBe("added\n");
});

test("when the checkout cannot be restored, its branch stays and the lease goes back", async () => {
  const { fixture, b, envB, target, project } = await movedToB();
  const lock = join(target, ".git/index.lock");
  hook(target, "post-checkout", `: > '${lock}'\n`);

  const errors = await failAdopt(project, target, envB);
  rmSync(lock, { force: true });

  expect(errors).toContain("adopt: could not undo the checkout:");
  expect(errors).toContain(
    "adopt: could not undo branch feat/one: the checkout is still on feat/one",
  );

  expect(
    (await run(["git", "rev-parse", "--verify", "refs/heads/feat/one"], target, envB)).code,
  ).toBe(0);

  expect(await must(["git", "symbolic-ref", "HEAD"], target, envB)).toBe("refs/heads/feat/one\n");
  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();
});

test("a patch that fails partway is put back around a carried edit", async () => {
  const { fixture, b, envB, target } = await movedToB(async (source, env) => {
    writeFileSync(join(source, "base/keep.txt"), "keep\nedit\n");
    writeFileSync(join(source, "z.txt"), `top\n${LINES}`);
    await must(["git", "mv", "old.txt", "young.txt"], source, env);
  });

  const carried = `${LINES}carried\n`;
  const base = join(target, "base");
  hook(
    target,
    "reference-transaction",
    onCreate("feat/one", `printf '${carried.replaceAll("\n", "\\n")}' > '${target}/z.txt'`),
  );

  hook(target, "post-checkout", `chmod 555 '${base}'\n`);

  const failed = capture(target, envB);
  try {
    expect(await adoptVerb(["Skills", "001"], usage, failed.io)).toBe(1);
  } finally {
    chmodSync(base, 0o755);
  }

  expect(failed.err.join("")).toStartWith("adopt: tracked.patch does not apply: ");
  expect(await must(["git", "rev-parse", "--abbrev-ref", "HEAD"], target, envB)).toBe("main\n");
  expect(await must(["git", "branch", "--list", "feat/one"], target, envB)).toBe("");
  expect(await must(["git", "status", "--porcelain", "--ignored"], target, envB)).toBe(
    " M z.txt\n",
  );

  expect(readFileSync(join(target, "z.txt"), "utf8")).toBe(carried);
  expect(await holderOf(b, fixture.url, "001")).toBeUndefined();
});
