import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tryLock } from "../lock.ts";
import {
  type ArtifactTree,
  artifactTree,
  capture,
  header,
  row,
  state,
  stub,
} from "../test/artifact-tree.ts";
import { breakStore, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary } from "../test/process.ts";
import { appendLog } from "./commit.ts";
import { SCRATCH_WAIT, STEP_BOUND, withScratchLock } from "./index-tsv.ts";
import { reapVerb, type ReapOptions } from "./reap.ts";
import { setRowVerb } from "./verbs.ts";

const usage = "skills reap (<Project> | --mine) [--dry-run]";
const setRowUsage = "skills plans set-row <Project> <id>[,<id>...] <STATUS> [branch|-] [note|-]";
const avdName = "plans_Skills_007_pixel_9";

const STUBS: Record<string, string> = {
  xcrun: `case "$*" in
  "simctl list devices --json") /bin/cat "$STUB/simctl.json" ;;
esac`,
  emulator: `[ "$1" = -list-avds ] && /bin/cat "$STUB/avds"`,
  adb: `case "$1 $3 $4" in
  "devices  ")
    echo "List of devices attached"
    while read -r serial name; do
      [ -e "$STUB/killed-$serial" ] || printf '%s\\tdevice\\n' "$serial"
    done < "$STUB/emulators" ;;
  "-s emu avd")
    while read -r serial name; do
      [ "$serial" = "$2" ] && printf '%s\\r\\nOK\\r\\n' "$name"
    done < "$STUB/emulators" ;;
  "-s emu kill")
    while read -r serial name; do
      [ "$serial" = "$2" ] && [ -d "$ANDROID_AVD_HOME/$name.avd" ] && echo "adb sees $name.avd" >> "$STUB/calls"
    done < "$STUB/emulators"
    : > "$STUB/killed-$2" ;;
esac`,
  docker: `case "$1 $2" in
  "info --format")
    [ -e "$STUB/nodaemon" ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    echo 29.0 ;;
  "ps --all")
    while IFS= read -r line; do
      [ -e "$STUB/down-\${line%%	*}" ] || printf '%s\n' "$line"
    done < "$STUB/compose" ;;
  "compose -p") : > "$STUB/down-$3" ;;
  "volume ls") /bin/cat "$STUB/volumes" ;;
esac`,
  lsof: `case "$*" in
  *-iTCP*) /bin/cat "$STUB/listen" ;;
  *cwd*) /bin/cat "$STUB/cwds" ;;
esac`,
};

const temporary: string[] = [];
const children: Bun.Subprocess[] = [];

type Tree = ArtifactTree & { scratch: string };

function event(project: string, id: string, name: string, detail = "feat/a"): string {
  return ["2026-10-01T00:00:00Z", project, id, name, detail].join("\t");
}

async function index(tree: Tree, project: string, rows: readonly string[]): Promise<void> {
  await writeFixture(
    tree.plans,
    `${project}/index.tsv`,
    `${[header, ...rows].join("\n")}\n`,
    "deleted",
  );
}

async function trail(tree: Tree, lines: readonly string[]): Promise<void> {
  const body = ["ts\tproject\tid\tevent\tdetail", ...lines].join("\n");
  await writeFixture(tree.plans, "log.tsv", `${body}\n`, "deleted");
}

async function simulators(tree: Tree, devices: readonly [string, string, string][]) {
  const list = devices.map(([name, udid, state]) => ({ name, udid, state, isAvailable: true }));
  await state(tree, "simctl.json", JSON.stringify({ devices: { "iOS-26-0": list } }));
}

async function slowXcrun(tree: Tree, verbs: string, seconds: number): Promise<void> {
  const slow = `case "$2" in\n  ${verbs}) exec /bin/sleep ${seconds} ;;\nesac`;
  await stub(tree, "xcrun", `${STUBS.xcrun}\n${slow}`);
}

async function createTree(omit: readonly string[] = []): Promise<Tree> {
  const base = await artifactTree({ prefix: "skills-reap-", stubs: STUBS, temporary, omit });
  const tree: Tree = { ...base, scratch: join(base.directory, "scratch") };

  await mkdir(tree.scratch);

  for (const tool of ["ps", "rm"])
    await symlink(Bun.which(tool)!, join(tree.directory, "bin", tool));

  await index(tree, "Skills", [row("007", "DONE", "feat/a"), row("008", "DOING", "feat/b")]);
  await trail(tree, [
    event("Skills", "007", "start"),
    event("Skills", "007", "handback"),
    event("Skills", "007", "done"),
    event("Skills", "008", "start", "feat/b"),
  ]);

  for (const name of ["simctl.json", "avds", "emulators", "compose", "volumes", "listen", "cwds"])
    await state(tree, name, name === "simctl.json" ? '{"devices": {}}' : "");

  return tree;
}

async function owned(tree: Tree): Promise<Bun.Subprocess> {
  await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
  await state(tree, "avds", `${avdName}\n`);
  await state(tree, "emulators", `emulator-5554 ${avdName}\n`);

  await writeFixture(tree.avd, `${avdName}.avd/config.ini`, "hw.device.name=pixel_9\n");
  await writeFixture(tree.avd, `${avdName}.ini`, `path=${join(tree.avd, `${avdName}.avd`)}\n`);

  await state(tree, "compose", `store-007\t${tree.checkout}\n`);
  await state(tree, "volumes", "plans-007-store\npg-data\n");

  const home = join(tree.scratch, "plans-007");
  await mkdir(home);
  return listen(tree, home);
}

async function avd(tree: Tree, name: string): Promise<void> {
  await state(tree, "avds", `${name}\n`);
  await writeFixture(tree.avd, `${name}.avd/config.ini`, "hw.device.name=pixel_9\n");
  await writeFixture(tree.avd, `${name}.ini`, `path=${join(tree.avd, `${name}.avd`)}\n`);
}

function avdFiles(tree: Tree): boolean[] {
  return [`${avdName}.avd`, `${avdName}.ini`].map((file) => existsSync(join(tree.avd, file)));
}

async function listen(tree: Tree, cwd: string): Promise<Bun.Subprocess> {
  const marker = join(tree.directory, "term");
  const child = Bun.spawn(
    ["/bin/sh", "-c", `trap 'echo term >> ${marker}' TERM; while :; do sleep 0.05; done`],
    { cwd, stdout: "ignore", stderr: "ignore" },
  );

  children.push(child);
  await Bun.sleep(100);
  await state(tree, "listen", `p${child.pid}\ncsh\nf5\nn*:8081\n`);
  await state(tree, "cwds", `p${child.pid}\nfcwd\nn${cwd}\n`);
  return child;
}

function reap(
  tree: Tree,
  args: readonly string[] = ["Skills"],
  cwd = tree.repo,
  options: ReapOptions = {},
) {
  return capture(tree, cwd, (io) =>
    reapVerb(args, usage, io, { scratch: tree.scratch, grace: 300, ...options }),
  );
}

async function calls(tree: Tree): Promise<string[]> {
  const log = join(tree.stub, "calls");
  return existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : [];
}

async function until(seen: () => boolean | Promise<boolean>): Promise<void> {
  while (!(await seen())) await Bun.sleep(10);
}

function termed(tree: Tree): boolean {
  return existsSync(join(tree.directory, "term"));
}

async function setRow(tree: Tree, status: string, branch = "-"): Promise<void> {
  const args = ["Skills", "007", status, branch];
  const result = await capture(tree, tree.repo, (io) =>
    setRowVerb(args, setRowUsage, tree.directory, io),
  );

  if (result.code !== 0) throw new Error(result.stderr);
}

async function changedBeforeFirstStep(
  tree: Tree,
  start: () => ReturnType<typeof reap>,
  change: () => Promise<void>,
) {
  const [pending] = await withScratchLock(tree.env, async () => {
    const started = start();
    await until(async () => (await calls(tree)).includes("xcrun simctl list devices --json"));
    await change();
    return [started] as const;
  });

  return pending;
}

async function changedAfterStop(
  tree: Tree,
  start: () => ReturnType<typeof reap>,
  change: () => Promise<void>,
) {
  const ps = join(tree.directory, "bin", "ps");
  const held = `while [ -e "$STUB/stopped" ] && [ ! -e "$STUB/settle" ]; do /bin/sleep 0.01; done`;
  await rm(ps);
  await writeFile(
    ps,
    `#!/bin/sh\nif [ "$1" = -p ]; then\n  ${held}\n  : > "$STUB/stopped"\nfi\nexec ${Bun.which("ps")} "$@"\n`,
  );

  await chmod(ps, 0o755);

  const pending = start();
  await until(() => termed(tree));
  await change();
  await state(tree, "settle", "");
  return pending;
}

async function deviceHeld<T>(tree: Tree, lock: string, run: () => Promise<T>): Promise<T> {
  const folder = join(tree.plans, ".devices");
  await mkdir(folder, { recursive: true });

  const locked = await tryLock(join(folder, lock), run);
  if (locked.held) throw new Error(`${lock} is already held`);
  return locked.value;
}

function destructive(lines: readonly string[]): string[] {
  return lines.filter((line) => / (shutdown|delete|kill|down|rm|sees) /.test(`${line} `));
}

afterEach(async () => {
  for (const child of children) child.kill("SIGKILL");
  children.length = 0;

  for (const directory of temporary) await removeTemporary(directory);
  temporary.length = 0;
});

describe("skills reap", () => {
  test("reaps every kind a closed row owns, stopping before deleting", async () => {
    const tree = await createTree();
    const child = await owned(tree);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "reaped simulator plans Skills 007 iPhone 17 Skills 007",
        `reaped avd ${avdName} Skills 007`,
        "reaped compose store-007 Skills 007",
        "reaped volume plans-007-store 007",
        `reaped listener sh(${child.pid}):8081 007`,
        "reaped 5 of 5",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([
      "xcrun simctl shutdown U-007",
      "xcrun simctl delete U-007",
      "adb -s emulator-5554 emu kill",
      `adb sees ${avdName}.avd`,
      "docker compose -p store-007 down --volumes --timeout 0",
      "docker volume rm plans-007-store",
    ]);

    expect(existsSync(join(tree.avd, `${avdName}.avd`))).toBe(false);
    expect(existsSync(join(tree.avd, `${avdName}.ini`))).toBe(false);

    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    expect(await readFile(join(tree.directory, "term"), "utf8")).toBe("term\n");
  });

  test("dry run prints would reap and stops or deletes nothing", async () => {
    const tree = await createTree();
    const child = await owned(tree);

    const result = await reap(tree, ["Skills", "--dry-run"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "would reap simulator plans Skills 007 iPhone 17 Skills 007",
        `would reap avd ${avdName} Skills 007`,
        "would reap compose store-007 Skills 007",
        "would reap volume plans-007-store 007",
        `would reap listener sh(${child.pid}):8081 007`,
        "would reap 5 of 5",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([]);
    expect(existsSync(join(tree.avd, `${avdName}.avd`))).toBe(true);
    expect(existsSync(join(tree.plans, ".devices"))).toBe(false);
    expect(child.exitCode).toBe(null);
  });

  test("keeps held closed and legacy artifacts and is silent on everything else", async () => {
    const tree = await createTree();
    await index(tree, "Skills", [
      row("007", "DONE", "feat/a"),
      row("008", "DOING", "feat/b"),
      row("009", "DONE", "feat/c"),
    ]);

    await index(tree, "Other", [row("007", "REVIEW", "feat/o")]);
    await trail(tree, [
      event("Skills", "007", "start"),
      event("Skills", "007", "handback"),
      event("Skills", "007", "done"),
      event("Skills", "008", "start", "feat/b"),
      event("Skills", "009", "start", "feat/c"),
      event("Skills", "-", "start", "feat/x"),
    ]);

    await simulators(tree, [
      ["plans Skills 009 iPhone 17", "U-009", "Booted"],
      ["plans-007 iPhone", "U-L07", "Booted"],
      ["plans Skills 008 iPhone 17", "U-008", "Booted"],
      ["adhoc Skills feat/x iPhone 17", "U-X", "Booted"],
      ["iPhone 18 Pro", "U-OP", "Booted"],
    ]);

    await state(tree, "compose", "elsewhere\t/srv/elsewhere\nunlabelled\t\n");
    const child = await listen(tree, tree.directory);

    const result = await reap(tree, ["Skills"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "kept simulator plans Skills 009 iPhone 17 Skills 009: Skills 009 has not handed back",
        "kept simulator plans-007 iPhone 007: Other 007 is REVIEW",
        "reaped 0 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([]);
    expect(child.exitCode).toBe(null);
  });

  test("keeps a legacy device while a batch sibling of its row still works", async () => {
    const tree = await createTree();
    await index(tree, "Skills", [row("007", "DROPPED", "feat/c"), row("009", "DOING", "feat/c")]);
    await trail(tree, [event("Skills", "009", "start", "feat/c")]);
    await simulators(tree, [["plans-007 iPhone", "U-L07", "Booted"]]);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "kept simulator plans-007 iPhone 007: Skills 009 is DOING\nreaped 0 of 1\n",
    );

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("reaps a handed back ad hoc branch's device", async () => {
    const tree = await createTree();
    await trail(tree, [
      event("Skills", "-", "start", "feat/x"),
      event("Skills", "-", "handback", "feat/x"),
    ]);

    await simulators(tree, [["adhoc Skills feat/x iPhone 17", "U-X", "Shutdown"]]);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "reaped simulator adhoc Skills feat/x iPhone 17 Skills feat/x\nreaped 1 of 1\n",
    );

    expect(destructive(await calls(tree))).toEqual(["xcrun simctl delete U-X"]);
  });

  test("keeps a reused branch name's run until it hands back itself", async () => {
    const tree = await createTree();
    await trail(tree, [
      event("Skills", "-", "start", "feat/x"),
      event("Skills", "-", "handback", "feat/x"),
    ]);

    const run = join(tree.directory, "wt-x");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/x", run]);
    await simulators(tree, [["adhoc Skills feat/x iPhone 17", "U-X", "Booted"]]);
    const child = await listen(tree, run);

    const held = await reap(tree);
    expect([held.code, held.stderr, held.stdout]).toEqual([0, "", "reaped 0 of 0\n"]);
    expect(destructive(await calls(tree))).toEqual([]);
    expect(child.exitCode).toBe(null);

    await appendLog("Skills", "-", "handback", "feat/x", tree.env);

    const handed = await reap(tree);
    expect([handed.code, handed.stderr]).toEqual([0, ""]);
    expect(handed.stdout).toBe(
      [
        "reaped simulator adhoc Skills feat/x iPhone 17 Skills feat/x",
        `reaped listener sh(${child.pid}):8081 Skills feat/x`,
        "reaped 2 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([
      "xcrun simctl shutdown U-X",
      "xcrun simctl delete U-X",
    ]);

    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("keeps a handed back name's device while git cannot read its branch", async () => {
    const tree = await createTree();
    await trail(tree, [
      event("Skills", "-", "handback", "feat/x"),
      event("Skills", "-", "handback", "feat/y"),
      event("Skills", "-", "handback", "fix/z"),
    ]);

    for (const branch of ["feat/x", "feat/y", "fix/z"])
      await fixtureGit(tree.repo, ["branch", branch]);

    await simulators(tree, [
      ["adhoc Skills feat/x iPhone 17", "U-X", "Booted"],
      ["adhoc Skills feat/y iPhone 17", "U-Y", "Booted"],
      ["adhoc Skills fix/z iPhone 17", "U-Z", "Booted"],
    ]);

    const locked = [
      [".git/logs/refs/heads/feat/x", 0o644],
      [".git/refs/heads/feat/y", 0o644],
      [".git/logs/refs/heads/fix", 0o755],
    ] as const;

    for (const [path] of locked) await chmod(join(tree.repo, path), 0o000);
    const result = await reap(tree).finally(async () => {
      for (const [path, mode] of locked) await chmod(join(tree.repo, path), mode);
    });

    expect([result.code, result.stderr, result.stdout]).toEqual([0, "", "reaped 0 of 0\n"]);
    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("reads branches through show-ref --verify on git without --exists", async () => {
    const tree = await createTree();
    const git = join(tree.directory, "bin/git");
    const real = realpathSync(Bun.which("git")!);
    await rm(git);
    await writeFile(
      git,
      `#!/bin/sh\n[ "$1 $2" = "show-ref --exists" ] && exit 129\nexec "${real}" "$@"\n`,
    );

    await chmod(git, 0o755);
    await trail(tree, [
      event("Skills", "-", "handback", "feat/x"),
      event("Skills", "-", "handback", "feat/y"),
      event("Skills", "-", "handback", "fix/z"),
      event("Skills", "-", "handback", "feat/x/topic"),
    ]);

    await fixtureGit(tree.repo, ["branch", "feat/x"]);
    await fixtureGit(tree.repo, ["branch", "fix/z"]);
    await simulators(tree, [
      ["adhoc Skills feat/x iPhone 17", "U-X", "Shutdown"],
      ["adhoc Skills feat/y iPhone 17", "U-Y", "Shutdown"],
      ["adhoc Skills fix/z iPhone 17", "U-Z", "Shutdown"],
      ["adhoc Skills feat/x/topic iPhone 17", "U-T", "Shutdown"],
    ]);

    const ref = join(tree.repo, ".git/refs/heads/fix/z");
    await chmod(ref, 0o000);
    const result = await reap(tree).finally(() => chmod(ref, 0o644));
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "reaped simulator adhoc Skills feat/y iPhone 17 Skills feat/y",
        "reaped simulator adhoc Skills feat/x/topic iPhone 17 Skills feat/x/topic",
        "reaped 2 of 2",
        "",
      ].join("\n"),
    );
  });

  test("reaps a deleted branch whose name now sits under another branch", async () => {
    const tree = await createTree();
    await trail(tree, [event("Skills", "-", "handback", "feat/a/topic")]);
    await simulators(tree, [["adhoc Skills feat/a/topic iPhone 17", "U-T", "Shutdown"]]);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "reaped simulator adhoc Skills feat/a/topic iPhone 17 Skills feat/a/topic\nreaped 1 of 1\n",
    );
  });

  test("reaps a handed back name whose reflog expired", async () => {
    const tree = await createTree();
    await trail(tree, [event("Skills", "-", "handback", "feat/x")]);
    await fixtureGit(tree.repo, ["branch", "feat/x"]);
    await fixtureGit(tree.repo, ["reflog", "expire", "--expire=all", "refs/heads/feat/x"]);
    await simulators(tree, [["adhoc Skills feat/x iPhone 17", "U-X", "Shutdown"]]);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "reaped simulator adhoc Skills feat/x iPhone 17 Skills feat/x\nreaped 1 of 1\n",
    );
  });

  test("keeps a closed row's checkout while an ad hoc run still holds its branch", async () => {
    const tree = await createTree();
    await trail(tree, [
      event("Skills", "007", "start"),
      event("Skills", "007", "handback"),
      event("Skills", "007", "done"),
      event("Skills", "-", "start"),
    ]);

    await state(tree, "compose", `store-007\t${tree.checkout}\n`);
    const child = await listen(tree, tree.checkout);

    const held = await reap(tree);
    expect([held.code, held.stderr]).toEqual([0, ""]);
    expect(held.stdout).toBe(
      [
        "kept compose store-007 Skills 007: Skills feat/a has not handed back",
        `kept listener sh(${child.pid}):8081 Skills 007: Skills feat/a has not handed back`,
        "reaped 0 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([]);
    expect(child.exitCode).toBe(null);
    expect(existsSync(join(tree.directory, "term"))).toBe(false);

    await appendLog("Skills", "-", "handback", "feat/a", tree.env);

    const handed = await reap(tree);
    expect([handed.code, handed.stderr]).toEqual([0, ""]);
    expect(handed.stdout).toBe(
      [
        "reaped compose store-007 Skills 007",
        `reaped listener sh(${child.pid}):8081 Skills 007`,
        "reaped 2 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([
      "docker compose -p store-007 down --volumes --timeout 0",
    ]);

    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("keeps a closed row's checkout an ad hoc run logged in other casing holds", async () => {
    const tree = await createTree();
    await trail(tree, [
      event("Skills", "007", "start"),
      event("Skills", "007", "handback"),
      event("Skills", "007", "done"),
      event("skills", "-", "start"),
    ]);

    const child = await listen(tree, tree.checkout);

    const held = await reap(tree);
    expect([held.code, held.stderr]).toEqual([0, ""]);
    expect(held.stdout).toBe(
      `kept listener sh(${child.pid}):8081 Skills 007: skills feat/a has not handed back\nreaped 0 of 1\n`,
    );

    await appendLog("skills", "-", "handback", "feat/a", tree.env);

    const handed = await reap(tree);
    expect(handed.stdout).toBe(`reaped listener sh(${child.pid}):8081 Skills 007\nreaped 1 of 1\n`);
  });

  test("keeps a compose project an open row shares with an ad hoc branch of the same token", async () => {
    const tree = await createTree();
    const run = join(tree.directory, "wt-run");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "007", run]);
    await index(tree, "Skills", [row("007", "DOING", "feat/a")]);
    await trail(tree, [
      event("Skills", "007", "start"),
      event("Skills", "-", "start", "007"),
      event("Skills", "-", "handback", "007"),
    ]);

    await state(tree, "compose", `store-x\t${tree.checkout}\nstore-x\t${run}\n`);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe("reaped 0 of 0\n");
    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("reaps a closed row's checkout listener with no ad hoc line for its branch", async () => {
    const tree = await createTree();
    const child = await listen(tree, tree.checkout);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(`reaped listener sh(${child.pid}):8081 Skills 007\nreaped 1 of 1\n`);

    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("keeps an AVD whose data lives outside the AVD home", async () => {
    const tree = await createTree();
    const elsewhere = join(tree.directory, "other.avd");
    await state(tree, "avds", `${avdName}\n`);
    await writeFixture(tree.avd, `${avdName}.ini`, `path=${elsewhere}\n`);
    await writeFixture(tree.directory, "other.avd/config.ini", "hw.device.name=pixel_9\n");

    const result = await reap(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      `kept avd ${avdName} Skills 007: its data lives at ${elsewhere}, not ${join(tree.avd, `${avdName}.avd`)}\nreaped 0 of 1\n`,
    );

    expect(existsSync(join(tree.avd, `${avdName}.ini`))).toBe(true);
    expect(existsSync(join(elsewhere, "config.ini"))).toBe(true);
  });

  test("refuses with exit 1 when another project's index will not import", async () => {
    const tree = await createTree();
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);

    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(tree.plans, `plans.db${suffix}`), { force: true });

    await mkdir(join(tree.plans, "Other"));
    await writeFile(join(tree.plans, "Other/index.tsv"), new Uint8Array([0xff, 0xfe, 0x0a]));

    const result = await reap(tree);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe(`reap: ${join(tree.plans, "Other/index.tsv")}: not valid UTF-8\n`);

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("never touches the caller as a listener and skips Docker when its daemon is down", async () => {
    const tree = await createTree();
    const home = join(tree.scratch, "plans-007");
    await mkdir(home);

    await state(tree, "nodaemon", "");
    await state(tree, "listen", `p${process.pid}\ncbun\nf5\nn*:8081\n`);
    await state(tree, "cwds", `p${process.pid}\nfcwd\nn${home}\n`);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "skipped compose: docker info --format exited 1: Cannot connect to the Docker daemon",
        "skipped volume: docker info --format exited 1: Cannot connect to the Docker daemon",
        "reaped 0 of 0",
        "",
      ].join("\n"),
    );
  });

  test("skips simulators when xcrun is absent", async () => {
    const tree = await createTree(["xcrun"]);

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe("skipped simulator: xcrun not found\nreaped 0 of 0\n");
  });

  test("refuses with exit 1 when the store is unreadable", async () => {
    const tree = await createTree();
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await breakStore(tree.plans);

    const result = await reap(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `reap: cannot read ${join(tree.plans, "plans.db")}: file is not a database\n`,
    );

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("step bound cuts off a command that outlasts it and keeps the artifact", async () => {
    const tree = await createTree();
    tree.env.SKILLS_READ_FLOOR_MS = undefined;
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await slowXcrun(tree, "shutdown", 5);

    const result = await reap(tree, ["Skills"], tree.repo, { bound: 300 });
    expect([result.code, result.stderr]).toEqual([1, ""]);
    expect(result.stdout).toBe(
      [
        "kept simulator plans Skills 007 iPhone 17 Skills 007: xcrun simctl shutdown: cut off at the 0.3 s step limit",
        "reaped 0 of 1",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual(["xcrun simctl shutdown U-007"]);
  });

  test("step bound covers the hold read under the lock", async () => {
    const tree = await createTree();
    tree.env.SKILLS_READ_FLOOR_MS = undefined;
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await stub(tree, "xcrun", `${STUBS.xcrun}\n: > "$STUB/listed"`);

    const git = join(tree.directory, "bin", "git");
    const slow = `[ "$1" = worktree ] && [ -e "$STUB/listed" ] && exec /bin/sleep 1`;
    await rm(git);
    await writeFile(git, `#!/bin/sh\n${slow}\nexec ${Bun.which("git")} "$@"\n`);
    await chmod(git, 0o755);

    const result = await reap(tree, ["Skills"], tree.repo, { bound: 300 });
    expect([result.code, result.stderr]).toEqual([1, ""]);
    expect(result.stdout).toBe(
      [
        "kept simulator plans Skills 007 iPhone 17 Skills 007: reading its holds: cut off at the 0.3 s step limit",
        "reaped 0 of 1",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("step bound cuts off an AVD delete that outlasts it", async () => {
    const tree = await createTree();
    tree.env.SKILLS_READ_FLOOR_MS = undefined;
    await state(tree, "avds", `${avdName}\n`);
    await writeFixture(tree.avd, `${avdName}.avd/config.ini`, "hw.device.name=pixel_9\n");
    await writeFixture(tree.avd, `${avdName}.ini`, `path=${join(tree.avd, `${avdName}.avd`)}\n`);

    await rm(join(tree.directory, "bin", "rm"));
    await stub(tree, "rm", "exec /bin/sleep 5");

    const result = await reap(tree, ["Skills"], tree.repo, { bound: 500 });
    expect([result.code, result.stderr]).toEqual([1, ""]);
    expect(result.stdout).toBe(
      `kept avd ${avdName} Skills 007: rm -rf --: cut off at the 0.5 s step limit\nreaped 0 of 1\n`,
    );

    expect(existsSync(join(tree.avd, `${avdName}.avd`))).toBe(true);
  });

  test("a waiter takes the scratch lock between locked steps", async () => {
    const tree = await createTree();
    await index(tree, "Skills", [row("007", "DONE", "feat/a"), row("009", "DONE", "feat/c")]);
    await trail(tree, [
      event("Skills", "007", "start"),
      event("Skills", "007", "handback"),
      event("Skills", "007", "done"),
      event("Skills", "009", "start", "feat/c"),
      event("Skills", "009", "handback", "feat/c"),
      event("Skills", "009", "done", "feat/c"),
    ]);

    await simulators(tree, [
      ["plans Skills 007 iPhone 17", "U-007", "Booted"],
      ["plans Skills 009 iPhone 17", "U-009", "Booted"],
    ]);

    await slowXcrun(tree, "shutdown|delete", 0.3);

    const pending = reap(tree);
    while (!(await calls(tree)).includes("xcrun simctl shutdown U-007")) await Bun.sleep(10);

    const seen = await withScratchLock(tree.env, () => calls(tree));
    expect(seen).toEqual(["xcrun simctl list devices --json", "xcrun simctl shutdown U-007"]);

    const result = await pending;
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "reaped simulator plans Skills 007 iPhone 17 Skills 007",
        "reaped simulator plans Skills 009 iPhone 17 Skills 009",
        "reaped 2 of 2",
        "",
      ].join("\n"),
    );
  });

  test("scratch wait outlasts one locked step by the lock wait", () => {
    expect([STEP_BOUND, SCRATCH_WAIT]).toEqual([60_000, 70_000]);
  });

  test("a hold that changes before the first locked step leaves every artifact alone", async () => {
    const tree = await createTree();
    const child = await owned(tree);

    const result = await changedBeforeFirstStep(
      tree,
      () => reap(tree),
      () => setRow(tree, "DOING"),
    );

    expect([result.code, result.stderr, result.stdout]).toEqual([0, "", "reaped 0 of 0\n"]);
    expect(destructive(await calls(tree))).toEqual([]);
    expect(avdFiles(tree)).toEqual([true, true]);
    expect([child.exitCode, termed(tree)]).toEqual([null, false]);
  });

  test("a hold that changes after the stop keeps the stopped listener", async () => {
    const tree = await createTree();
    const home = join(tree.scratch, "plans-007");
    await mkdir(home);
    const child = await listen(tree, home);

    const result = await changedAfterStop(
      tree,
      () => reap(tree),
      () => setRow(tree, "DOING"),
    );

    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      `kept listener sh(${child.pid}):8081 007: stopped, then its owner held it again\nreaped 0 of 1\n`,
    );

    expect(child.exitCode).toBe(null);
  });

  test("keeps an AVD whose device lock a skills device call holds", async () => {
    const tree = await createTree();
    await avd(tree, avdName);
    await state(tree, "emulators", `emulator-5554 ${avdName}\n`);

    const lock = "android-plans-Skills-007-pixel-9.lock";
    const result = await deviceHeld(tree, lock, () => reap(tree));
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      `kept avd ${avdName} Skills 007: a skills device call is using it\nreaped 0 of 1\n`,
    );

    expect(destructive(await calls(tree))).toEqual([]);
    expect(avdFiles(tree)).toEqual([true, true]);
  });

  test("keeps a simulator whose device lock a skills device call holds", async () => {
    const tree = await createTree();
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);

    const result = await deviceHeld(tree, "ios-plans-Skills-007-iPhone-17.lock", () => reap(tree));
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "kept simulator plans Skills 007 iPhone 17 Skills 007: a skills device call is using it\nreaped 0 of 1\n",
    );

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("with the device lock free keeps an AVD an emulator started on since the first read", async () => {
    const tree = await createTree();
    await avd(tree, avdName);
    await stub(
      tree,
      "adb",
      `case "$1 $3 $4" in
  "devices  ")
    echo "List of devices attached"
    [ -e "$STUB/asked" ] && printf 'emulator-5554\\tdevice\\n'
    : > "$STUB/asked" ;;
  "-s emu avd") printf '%s\\r\\nOK\\r\\n' ${avdName} ;;
esac`,
    );

    const result = await reap(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      `kept avd ${avdName} Skills 007: an emulator started on it since the first read\nreaped 0 of 1\n`,
    );

    expect(destructive(await calls(tree))).toEqual([]);
    expect(avdFiles(tree)).toEqual([true, true]);
  });
});

describe("skills reap --mine", () => {
  async function working(tree: Tree, rows: readonly string[]): Promise<void> {
    await index(tree, "Skills", rows);
    await trail(tree, [event("Skills", "007", "start"), event("Skills", "008", "start", "feat/b")]);
  }

  async function both(tree: Tree, cwd: string): Promise<Bun.Subprocess> {
    const home = join(tree.scratch, "plans-007");
    await mkdir(home);

    const child = await listen(tree, home);
    const parent = `p${process.ppid}\ncnode\nf6\nn*:3000\n`;
    await state(tree, "listen", `p${child.pid}\ncsh\nf5\nn*:8081\n${parent}`);
    await state(tree, "cwds", `p${child.pid}\nfcwd\nn${home}\np${process.ppid}\nfcwd\nn${cwd}\n`);
    return child;
  }

  test("reaps every artifact the checkout's working row owns and nothing else", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a"), row("008", "DOING", "feat/b")]);
    await simulators(tree, [
      ["plans Skills 007 iPhone 17", "U-007", "Booted"],
      ["plans Skills 007 iPad Air 11-inch (M4)", "U-7PAD", "Shutdown"],
      ["plans Skills 008 iPhone 17", "U-008", "Booted"],
      ["iPhone 18 Pro", "U-OP", "Booted"],
    ]);

    await avd(tree, avdName);
    await state(tree, "emulators", `emulator-5554 ${avdName}\n`);
    await state(tree, "compose", `store-007\t${tree.checkout}\n`);
    const child = await both(tree, tree.checkout);

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "reaped simulator plans Skills 007 iPhone 17 Skills 007",
        "reaped simulator plans Skills 007 iPad Air 11-inch (M4) Skills 007",
        `reaped avd ${avdName} Skills 007`,
        "reaped compose store-007 Skills 007",
        `reaped listener sh(${child.pid}):8081 007`,
        "reaped 5 of 5",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([
      "xcrun simctl shutdown U-007",
      "xcrun simctl delete U-007",
      "xcrun simctl delete U-7PAD",
      "adb -s emulator-5554 emu kill",
      `adb sees ${avdName}.avd`,
      "docker compose -p store-007 down --volumes --timeout 0",
    ]);

    await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
  });

  test("dry run on a batch branch names every open member's devices", async () => {
    const tree = await createTree();
    await working(tree, [
      row("005", "DONE", "feat/a"),
      row("007", "DOING", "feat/a"),
      row("008", "DOING", "feat/b"),
      row("009", "DOING", "feat/a"),
    ]);

    await simulators(tree, [
      ["plans Skills 005 iPhone 17", "U-005", "Shutdown"],
      ["plans Skills 007 iPhone 17", "U-007", "Booted"],
      ["plans Skills 008 iPhone 17", "U-008", "Booted"],
      ["plans Skills 009 iPhone 17", "U-009", "Booted"],
    ]);

    const result = await reap(tree, ["--mine", "--dry-run"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "would reap simulator plans Skills 007 iPhone 17 Skills 007",
        "would reap simulator plans Skills 009 iPhone 17 Skills 009",
        "would reap 2 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("keeps a scratch listener another project's row with the same id holds", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a")]);
    await index(tree, "Other", [row("007", "REVIEW", "feat/o")]);
    const child = await both(tree, tree.checkout);

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      `kept listener sh(${child.pid}):8081 007: Other 007 is REVIEW\nreaped 0 of 1\n`,
    );

    expect(child.exitCode).toBe(null);
  });

  test("on a rowless branch reaps only that branch's ad hoc devices", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/z"), row("008", "DONE", "feat/b")]);
    await simulators(tree, [
      ["adhoc Skills feat/a iPhone 17", "U-A", "Booted"],
      ["adhoc Skills feat/x iPhone 17", "U-X", "Booted"],
      ["plans Skills 007 iPhone 17", "U-007", "Booted"],
      ["plans Skills 008 iPhone 17", "U-008", "Shutdown"],
    ]);

    await avd(tree, "adhoc_Skills_feat-a_pixel_9");

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      [
        "reaped simulator adhoc Skills feat/a iPhone 17 Skills feat/a",
        "reaped avd adhoc_Skills_feat-a_pixel_9 Skills feat/a",
        "reaped 2 of 2",
        "",
      ].join("\n"),
    );

    expect(destructive(await calls(tree))).toEqual([
      "xcrun simctl shutdown U-A",
      "xcrun simctl delete U-A",
    ]);

    expect(existsSync(join(tree.avd, "adhoc_Skills_feat-a_pixel_9.avd"))).toBe(false);
  });

  test("keeps an AVD a live checkout of another branch shares the name of", async () => {
    const tree = await createTree();
    await working(tree, [row("008", "DOING", "feat/b")]);
    await fixtureGit(tree.repo, [
      "worktree",
      "add",
      "--quiet",
      "-b",
      "feat-a",
      join(tree.directory, "wt-dash"),
    ]);

    await avd(tree, "adhoc_Skills_feat-a_pixel_9");

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "kept avd adhoc_Skills_feat-a_pixel_9 Skills feat/a: Skills feat-a has not handed back\nreaped 0 of 1\n",
    );

    expect(existsSync(join(tree.avd, "adhoc_Skills_feat-a_pixel_9.avd"))).toBe(true);
  });

  test("refuses a checkout whose folder names another project", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a")]);
    await index(tree, "Other", [row("007", "DOING", "feat/o")]);

    const other = join(tree.directory, "Other");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/o", other]);
    await simulators(tree, [["plans Other 007 iPhone 17", "U-O07", "Booted"]]);

    const result = await reap(tree, ["--mine"], other);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe("reap: the checkout's names match two projects: Other and Skills\n");
    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("refuses on the default branch and touches nothing", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "main")]);
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);

    const result = await reap(tree, ["--mine"], tree.repo);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe("reap: the checkout has no owner: main is the default branch\n");
    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("reads the default branch from origin/HEAD with an unreachable origin", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a")]);
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await fixtureGit(tree.repo, ["remote", "set-url", "origin", join(tree.directory, "gone.git")]);

    for (const [args, cwd] of [
      [["--mine"], tree.checkout],
      [["Skills"], tree.repo],
    ] as const) {
      const unset = await reap(tree, args, cwd);
      expect(unset).toEqual({
        code: 1,
        stdout: "",
        stderr: "reap: cannot read the default branch of origin\n",
      });
    }

    expect(destructive(await calls(tree))).toEqual([]);

    await fixtureGit(tree.repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);

    const primary = await reap(tree, ["--mine"], tree.repo);
    expect([primary.code, primary.stdout]).toEqual([1, ""]);
    expect(primary.stderr).toBe("reap: the checkout has no owner: main is the default branch\n");

    const mine = await reap(tree, ["--mine"], tree.checkout);
    expect([mine.code, mine.stderr]).toEqual([0, ""]);
    expect(mine.stdout).toBe(
      "reaped simulator plans Skills 007 iPhone 17 Skills 007\nreaped 1 of 1\n",
    );

    const named = await reap(tree, ["Skills"], tree.repo);
    expect([named.code, named.stderr]).toEqual([0, ""]);
    expect(named.stdout).toMatch(/^reaped \d+ of \d+\n$/m);
  });

  test("refuses a detached HEAD", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a")]);
    await fixtureGit(tree.checkout, ["checkout", "--quiet", "--detach"]);
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe("reap: the checkout has no owner: HEAD is detached\n");
    expect(destructive(await calls(tree))).toEqual([]);
  });

  test("on a branch only a closed row holds also reaps its ad hoc devices", async () => {
    const tree = await createTree();
    await working(tree, [row("005", "DONE", "feat/a")]);
    await simulators(tree, [["adhoc Skills feat/a iPhone 17", "U-A", "Shutdown"]]);

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "reaped simulator adhoc Skills feat/a iPhone 17 Skills feat/a\nreaped 1 of 1\n",
    );
  });

  test("reaps an ad hoc branch's devices with no plans directory at all", async () => {
    const tree = await createTree();
    await removeTemporary(tree.plans);
    await simulators(tree, [["adhoc Skills feat/a iPhone 17", "U-A", "Shutdown"]]);

    const result = await reap(tree, ["--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "reaped simulator adhoc Skills feat/a iPhone 17 Skills feat/a\nreaped 1 of 1\n",
    );
  });

  test("dry run with no plans directory leaves it uncreated", async () => {
    const tree = await createTree();
    await removeTemporary(tree.plans);
    await simulators(tree, [["adhoc Skills feat/a iPhone 17", "U-A", "Shutdown"]]);

    const result = await reap(tree, ["--mine", "--dry-run"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      "would reap simulator adhoc Skills feat/a iPhone 17 Skills feat/a\nwould reap 1 of 1\n",
    );

    expect(existsSync(tree.plans)).toBe(false);
  });

  test("a row that left the caller's branch before the first locked step keeps its artifacts", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a"), row("008", "DOING", "feat/b")]);
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);

    await avd(tree, avdName);
    await state(tree, "emulators", `emulator-5554 ${avdName}\n`);
    await state(tree, "compose", `store-007\t${tree.checkout}\n`);

    const home = join(tree.scratch, "plans-007");
    await mkdir(home);
    const child = await listen(tree, home);

    const result = await changedBeforeFirstStep(
      tree,
      () => reap(tree, ["--mine"], tree.checkout),
      () => setRow(tree, "DOING", "feat/b"),
    );

    expect([result.code, result.stderr, result.stdout]).toEqual([0, "", "reaped 0 of 0\n"]);
    expect(destructive(await calls(tree))).toEqual([]);
    expect(avdFiles(tree)).toEqual([true, true]);
    expect([child.exitCode, termed(tree)]).toEqual([null, false]);
  });

  test("a row that left the caller's branch during the listener grace keeps the listener", async () => {
    const tree = await createTree();
    await working(tree, [row("007", "DOING", "feat/a"), row("008", "DOING", "feat/b")]);

    const home = join(tree.scratch, "plans-007");
    await mkdir(home);
    const child = await listen(tree, home);

    const result = await changedAfterStop(
      tree,
      () => reap(tree, ["--mine"], tree.checkout),
      () => setRow(tree, "DOING", "feat/b"),
    );

    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(
      `kept listener sh(${child.pid}):8081 007: stopped, then its owner held it again\nreaped 0 of 1\n`,
    );

    expect(child.exitCode).toBe(null);
  });

  test("refuses a project argument beside --mine", async () => {
    const tree = await createTree();
    const result = await reap(tree, ["Skills", "--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([2, `usage: ${usage}\n`]);
  });
});
