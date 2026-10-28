import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { reapVerb } from "./reap.ts";

const usage = "skills reap (<Project> | --mine) [--dry-run]";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
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

type Tree = {
  directory: string;
  repo: string;
  checkout: string;
  plans: string;
  scratch: string;
  stub: string;
  avd: string;
  env: NodeJS.ProcessEnv;
};

function row(id: string, status: string, branch: string): string {
  return [id, `p${id}`, status, "P1", "S", "-", "-", branch, "2026-10-01", "-"].join("\t");
}

function event(project: string, id: string, name: string, detail = "feat/a"): string {
  return ["2026-10-01T00:00:00Z", project, id, name, detail].join("\t");
}

async function index(tree: Tree, project: string, rows: readonly string[]): Promise<void> {
  await writeFixture(tree.plans, `${project}/index.tsv`, `${[header, ...rows].join("\n")}\n`);
}

async function trail(tree: Tree, lines: readonly string[]): Promise<void> {
  const body = ["ts\tproject\tid\tevent\tdetail", ...lines].join("\n");
  await writeFixture(tree.plans, "log.tsv", `${body}\n`);
}

async function state(tree: Tree, name: string, content: string): Promise<void> {
  await writeFile(join(tree.stub, name), content);
}

async function simulators(tree: Tree, devices: readonly [string, string, string][]) {
  const list = devices.map(([name, udid, state]) => ({ name, udid, state, isAvailable: true }));
  await state(tree, "simctl.json", JSON.stringify({ devices: { "iOS-26-0": list } }));
}

async function createTree(omit: readonly string[] = []): Promise<Tree> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "skills-reap-")));
  temporary.push(directory);

  const bin = join(directory, "bin");
  const tree: Tree = {
    directory,
    repo: join(directory, "Skills"),
    checkout: join(directory, "wt-007"),
    plans: join(directory, "plans"),
    scratch: join(directory, "scratch"),
    stub: join(directory, "stub"),
    avd: join(directory, "avd"),
    env: {
      ...suiteEnvironment(),
      PATH: bin,
      HOME: directory,
      STUB: join(directory, "stub"),
      PLANS_DIR: join(directory, "plans"),
      SKILLS_CONF: join(directory, "skills.conf"),
      ANDROID_AVD_HOME: join(directory, "avd"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };

  await Promise.all([bin, tree.stub, tree.scratch, tree.avd].map((path) => mkdir(path)));
  for (const tool of ["git", "ps"]) await symlink(Bun.which(tool)!, join(bin, tool));

  for (const [tool, body] of Object.entries(STUBS)) {
    if (omit.includes(tool)) continue;

    const script = `#!/bin/sh\necho "${tool} $*" >> "$STUB/calls"\n${body}\n`;
    await writeFile(join(bin, tool), script);
    await chmod(join(bin, tool), 0o755);
  }

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", tree.repo]);
  await fixtureGit(tree.repo, ["remote", "add", "origin", origin]);

  await writeFixture(tree.repo, "base", "base\n");
  await commitFixture(tree.repo);
  await fixtureGit(tree.repo, ["push", "--quiet", "origin", "main"]);
  await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/a", tree.checkout]);

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

async function reap(tree: Tree, args: readonly string[] = ["Skills"], cwd = tree.repo) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    cwd,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const code = await reapVerb(args, usage, io, { scratch: tree.scratch, grace: 300 });
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function calls(tree: Tree): Promise<string[]> {
  const log = join(tree.stub, "calls");
  return existsSync(log) ? (await readFile(log, "utf8")).split("\n").filter(Boolean) : [];
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

    const before = process.cwd();
    process.chdir(tree.checkout);
    const result = await reap(tree, ["Skills"], tree.checkout).finally(() => process.chdir(before));
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

  test("refuses with exit 1 when another project's index is unreadable", async () => {
    const tree = await createTree();
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await mkdir(join(tree.plans, "Other"));
    await writeFile(join(tree.plans, "Other/index.tsv"), new Uint8Array([0xff, 0xfe, 0x0a]));

    const result = await reap(tree);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe("reap: cannot read Other index.tsv\n");
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

  test("refuses with exit 1 when log.tsv is unreadable", async () => {
    const tree = await createTree();
    await simulators(tree, [["plans Skills 007 iPhone 17", "U-007", "Booted"]]);
    await writeFile(join(tree.plans, "log.tsv"), new Uint8Array([0xff, 0xfe, 0x0a]));

    const result = await reap(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`reap: cannot read ${join(tree.plans, "log.tsv")}\n`);
    expect(destructive(await calls(tree))).toEqual([]);
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

  async function avd(tree: Tree, name: string): Promise<void> {
    await state(tree, "avds", `${name}\n`);
    await writeFixture(tree.avd, `${name}.avd/config.ini`, "hw.device.name=pixel_9\n");
    await writeFixture(tree.avd, `${name}.ini`, `path=${join(tree.avd, `${name}.avd`)}\n`);
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

  test("refuses a project argument beside --mine", async () => {
    const tree = await createTree();
    const result = await reap(tree, ["Skills", "--mine"], tree.checkout);
    expect([result.code, result.stderr]).toEqual([2, `usage: ${usage}\n`]);
  });
});
