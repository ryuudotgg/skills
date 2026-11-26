import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Io } from "../io.ts";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { releaseVerb } from "./release.ts";

const stubBin = resolve(import.meta.dir, "../../../../scripts/stubs");
const usage = "skills plans release <Project> [--dry-run] [--facts]";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
const fields =
  "number,state,baseRefName,mergeCommit,headRefOid,title,isCrossRepository,mergedAt,closedAt,mergeable";

const ignores =
  "node_modules/\n.expo/\nexpo-env.d.ts\n.env.local\nandroid/\n.cache/\n.next/\ndist/\n";

const temporary: string[] = [];

type Tree = {
  directory: string;
  repo: string;
  plans: string;
  holder: string;
  env: NodeJS.ProcessEnv;
};

function row(id: string, status: string, branch: string): string {
  return [id, `p${id}`, status, "P1", "S", "-", "-", branch, "2026-10-01", "-"].join("\t");
}

function event(id: string, name: string, ts: string): string {
  return [ts, "fixture", id, name, "feat/a"].join("\t");
}

function prKey(branch: string): string {
  const args = [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    fields,
    "--limit",
    "200",
  ];

  return args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
}

async function index(tree: Tree, rows: readonly string[]): Promise<void> {
  await writeFixture(
    tree.plans,
    "fixture/index.tsv",
    `${[header, ...rows].join("\n")}\n`,
    "deleted",
  );
}

async function trail(tree: Tree, lines: readonly string[]): Promise<void> {
  await writeFixture(
    tree.plans,
    "log.tsv",
    `${["ts\tproject\tid\tevent\tdetail", ...lines].join("\n")}\n`,
    "deleted",
  );
}

async function pr(tree: Tree, branch: string, head: string, state = "MERGED"): Promise<void> {
  const ended = state === "OPEN" ? null : "2026-10-02T00:00:00Z";
  const body = [
    {
      number: 11,
      state,
      baseRefName: "main",
      mergeCommit: state === "MERGED" ? { oid: "abcdef1234567890" } : null,
      headRefOid: head,
      title: "feat: ship a",
      isCrossRepository: false,
      mergedAt: state === "MERGED" ? ended : null,
      closedAt: ended,
      mergeable: "UNKNOWN",
    },
  ];

  await writeFile(join(tree.directory, "gh", prKey(branch)), JSON.stringify(body));
}

async function track(tree: Tree, path: string): Promise<void> {
  await writeFixture(tree.holder, path, "\n");
  await commitFixture(tree.holder);
  await pr(tree, "feat/a", (await fixtureGit(tree.holder, ["rev-parse", "HEAD"])).trim());
}

async function conf(tree: Tree, content: string): Promise<void> {
  await writeFile(join(tree.directory, "skills.conf"), content);
}

async function createTree(): Promise<Tree> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), "skills-release-")));
  temporary.push(directory);

  const tree: Tree = {
    directory,
    repo: join(directory, "fixture"),
    plans: join(directory, "plans"),
    holder: join(directory, "wt-a"),
    env: {
      ...suiteEnvironment(),
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      PLANS_DIR: join(directory, "plans"),
      SKILLS_CONF: join(directory, "skills.conf"),
      GH_STUB_DIR: join(directory, "gh"),
      GH_STUB_LOG: join(directory, "gh.log"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };

  await mkdir(join(directory, "gh"));

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", tree.repo]);
  await fixtureGit(tree.repo, ["remote", "add", "origin", origin]);

  await writeFixture(tree.repo, ".gitignore", ignores);
  await writeFixture(tree.repo, "base", "base\n");
  await commitFixture(tree.repo);

  await fixtureGit(tree.repo, ["checkout", "--quiet", "-b", "feat/a", "main"]);
  await writeFixture(tree.repo, "a", "a\n");
  await commitFixture(tree.repo);
  const head = (await fixtureGit(tree.repo, ["rev-parse", "feat/a"])).trim();

  await fixtureGit(tree.repo, ["checkout", "--quiet", "main"]);
  await writeFixture(tree.repo, "a", "a\n");
  await commitFixture(tree.repo);
  await fixtureGit(origin, ["fetch", "--quiet", tree.repo, "+refs/heads/*:refs/heads/*"]);

  await index(tree, [row("1", "DONE", "feat/a")]);
  await trail(tree, [
    event("1", "start", "2026-10-01T00:00:00Z"),
    event("1", "handback", "2026-10-01T01:00:00Z"),
    event("1", "done", "2026-10-02T01:00:00Z"),
  ]);

  await pr(tree, "feat/a", head);
  await fixtureGit(tree.repo, ["worktree", "add", "--quiet", tree.holder, "feat/a"]);

  await writeFixture(tree.holder, "node_modules/pkg/index.js", "module.exports = 1;\n");
  await writeFixture(tree.holder, ".expo/settings.json", "{}\n");
  await writeFixture(tree.holder, "expo-env.d.ts", "export {};\n");
  return tree;
}

async function release(
  tree: Tree,
  args: readonly string[] = ["fixture"],
  cwd = tree.repo,
  stdin = "",
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    cwd,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const code = await releaseVerb(args, usage, io, async () => stdin);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

function worktreeList(tree: Tree): Promise<string> {
  return fixtureGit(tree.repo, ["worktree", "list", "--porcelain"]);
}

async function expectKept(tree: Tree, reason: string, code = 0): Promise<void> {
  const before = await worktreeList(tree);
  const result = await release(tree);

  expect([result.code, result.stderr]).toEqual([code, ""]);
  expect(result.stdout).toBe(`kept 1 ${tree.holder}: ${reason}\nreleased 0 of 1\n`);
  expect(await worktreeList(tree)).toBe(before);
  expect(existsSync(tree.holder)).toBe(true);
}

function recordOf(tree: Tree): string {
  return join(tree.plans, ".release-trash.json");
}

async function strandTrash(tree: Tree, sealed = "/0") {
  const parent = join(tree.directory, "lone");
  const holder = join(parent, "wt-a");
  await mkdir(parent);
  await fixtureGit(tree.repo, ["worktree", "move", tree.holder, holder]);

  const bin = join(tree.directory, "bin");
  const git = Bun.which("git") ?? "git";
  await writeFixture(
    bin,
    "git",
    `#!/bin/sh\ncase "$*" in *"worktree remove ${holder}") ${git} "$@" || exit $?; chmod 500 ${parent}/.wt-a.release-*${sealed}; exit 0;; esac\nexec ${git} "$@"\n`,
  );

  await chmod(join(bin, "git"), 0o755);
  tree.env.PATH = `${bin}:${tree.env.PATH}`;

  const first = await release(tree);
  const left = (await readdir(parent)).filter((name) => name.includes(".release-"));
  expect(left).toHaveLength(1);

  const trash = join(parent, left[0] ?? "");
  await chmod(`${trash}${sealed}`, 0o755);
  return { parent, holder, trash, first };
}

afterEach(async () => {
  for (const directory of temporary) await removeTemporary(directory);
  temporary.length = 0;
});

describe("plans release", () => {
  test("releases a squash merged checkout holding only disposable ignored paths", async () => {
    const tree = await createTree();

    const result = await release(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(`released 1 ${tree.holder}\nreleased 1 of 1\n`);

    expect(await worktreeList(tree)).not.toContain(tree.holder);
    expect(existsSync(tree.holder)).toBe(false);
    expect((await readdir(tree.directory)).filter((name) => name.includes(".release-"))).toEqual(
      [],
    );

    await fixtureGit(tree.repo, ["rev-parse", "--verify", "refs/heads/feat/a"]);

    const again = await release(tree);
    expect([again.code, again.stdout]).toEqual([0, "released 0 of 0\n"]);
  });

  test("a dry run names the release and leaves the checkout list byte identical", async () => {
    const tree = await createTree();
    const before = await worktreeList(tree);

    const result = await release(tree, ["fixture", "--dry-run"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(`would release 1 ${tree.holder}\nwould release 1 of 1\n`);
    expect(await worktreeList(tree)).toBe(before);
  });

  test.each([
    [
      "a tracked change",
      "tracked change base",
      (tree: Tree) => writeFixture(tree.holder, "base", "edit\n"),
    ],
    [
      "an untracked file",
      "untracked notes.txt",
      (tree: Tree) => writeFixture(tree.holder, "notes.txt", "work\n"),
    ],
    [
      "a commit outside the PR's head",
      "a commit outside the PR's head",
      async (tree: Tree) => {
        await writeFixture(tree.holder, "later", "later\n");
        await commitFixture(tree.holder);
      },
    ],
    [
      "a skip-worktree edit",
      "base is marked skip-worktree or assume-unchanged",
      async (tree: Tree) => {
        await fixtureGit(tree.holder, ["update-index", "--skip-worktree", "base"]);
        await writeFixture(tree.holder, "base", "hidden\n");
      },
    ],
    [
      "an ignored .env.local, even when listed as disposable",
      "ignored .env.local is not disposable",
      async (tree: Tree) => {
        await writeFixture(tree.holder, ".env.local", "SECRET=1\n");
        await conf(tree, "PLANS_DISPOSABLE=.env.local\n");
      },
    ],
    [
      "an ignored android directory",
      "ignored android/ is not disposable",
      (tree: Tree) => writeFixture(tree.holder, "android/build.gradle", "\n"),
    ],
    [
      "a git worktree lock",
      "locked by git worktree lock",
      async (tree: Tree) => {
        await fixtureGit(tree.repo, ["worktree", "lock", tree.holder]);
      },
    ],
    [
      "a row live in the trail",
      "fixture 1 has not handed back",
      (tree: Tree) => trail(tree, [event("1", "start", "2026-10-01T00:00:00Z")]),
    ],
    [
      "a live sibling row on a batch branch",
      "fixture 2 has not handed back",
      async (tree: Tree) => {
        await index(tree, [row("2", "DONE", "feat/a"), row("1", "DONE", "feat/a")]);
        await trail(tree, [
          event("1", "start", "2026-10-01T00:00:00Z"),
          event("2", "start", "2026-10-01T00:00:00Z"),
          event("1", "handback", "2026-10-01T01:00:00Z"),
        ]);
      },
    ],
  ])("holds %s", async (_name, reason, setup) => {
    const tree = await createTree();
    await setup(tree);
    await expectKept(tree, reason);
  });

  test("releases a checkout holding only build caches", async () => {
    const tree = await createTree();
    await writeFixture(tree.holder, ".cache/tsbuildinfo.json", "{}\n");
    await writeFixture(tree.holder, ".next/trace", "\n");
    await writeFixture(tree.holder, "dist/index.js", "\n");

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `released 1 ${tree.holder}\nreleased 1 of 1\n`,
    ]);
  });

  test("releases a checkout holding husky's generated hooks", async () => {
    const tree = await createTree();
    await track(tree, ".husky/pre-commit");
    await writeFixture(tree.holder, ".husky/_/.gitignore", "*");
    await writeFixture(tree.holder, ".husky/_/h", "\n");
    await writeFixture(tree.holder, ".husky/_/pre-commit", "\n");

    const result = await release(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(`released 1 ${tree.holder}\nreleased 1 of 1\n`);
    expect(existsSync(tree.holder)).toBe(false);
  });

  test("holds a directory ignored by its own .gitignore that no name covers", async () => {
    const tree = await createTree();
    await writeFixture(tree.holder, ".venv/.gitignore", "*");
    await writeFixture(tree.holder, ".venv/pyvenv.cfg", "\n");
    await expectKept(tree, "ignored .venv/ is not disposable");
  });

  async function listedIgnored(tree: Tree): Promise<string[]> {
    const args = ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"];
    return (await fixtureGit(tree.holder, args)).split("\n").filter(Boolean);
  }

  async function removedWorkspace(tree: Tree): Promise<void> {
    await track(tree, "apps/web/package.json");
    await writeFixture(tree.holder, "apps/gone/node_modules/pkg/index.js", "\n");
  }

  async function wrangler(tree: Tree): Promise<void> {
    await writeFixture(tree.repo, ".git/info/exclude", ".wrangler/\n*.log\n");
    await mkdir(join(tree.holder, ".wrangler/tmp"), { recursive: true });
  }

  test.each([
    ["a removed workspace keeping only its node_modules", "apps/gone/", removedWorkspace],
    ["a .wrangler holding only an empty tmp", ".wrangler/", wrangler],
    [
      "a .wrangler whose tmp holds a node_modules with an env example",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await writeFixture(tree.holder, ".wrangler/tmp/node_modules/pkg/.env.example", "A=1\n");
      },
    ],
    [
      "a .wrangler whose tmp holds a file",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await writeFixture(tree.holder, ".wrangler/tmp/bundle/index.js", "\n");
      },
    ],
  ])("releases %s", async (_name, folder, setup) => {
    const tree = await createTree();
    await setup(tree);
    expect(await listedIgnored(tree)).toContain(folder);

    const result = await release(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(`released 1 ${tree.holder}\nreleased 1 of 1\n`);
    expect(await worktreeList(tree)).not.toContain(tree.holder);
    expect(existsSync(tree.holder)).toBe(false);
  });

  test.each([
    [
      "a file beside a removed workspace's node_modules",
      "apps/gone/",
      async (tree: Tree) => {
        await removedWorkspace(tree);
        await writeFixture(tree.repo, ".git/info/exclude", "*.log\n");
        await writeFixture(tree.holder, "apps/gone/debug.log", "\n");
      },
    ],
    [
      "a symlink with a disposable name",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await rename(join(tree.holder, ".wrangler/tmp"), join(tree.directory, "elsewhere"));
        await symlink(join(tree.directory, "elsewhere"), join(tree.holder, ".wrangler/tmp"));
      },
    ],
    [
      "an env file in a nested dist",
      "apps/gone/",
      async (tree: Tree) => {
        await track(tree, "apps/web/package.json");
        await writeFixture(tree.holder, "apps/gone/dist/.env.local", "SECRET=1\n");
      },
    ],
    [
      "local data under .wrangler/state",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await writeFixture(tree.holder, ".wrangler/state/v3/d1/db.sqlite", "\n");
      },
    ],
    [
      "a symlink under its disposable tmp",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await symlink(tree.directory, join(tree.holder, ".wrangler/tmp/link"));
      },
    ],
    [
      "an empty folder named like an env file",
      ".wrangler/",
      async (tree: Tree) => {
        await wrangler(tree);
        await mkdir(join(tree.holder, ".wrangler/.env.local"));
      },
    ],
  ])("holds a walked folder with %s", async (_name, entry, setup) => {
    const tree = await createTree();
    await setup(tree);
    await expectKept(tree, `ignored ${entry} is not disposable`);
  });

  test.each([
    ["an ignored file", "debug.log", "debug.log"],
    ["an env file in dist", "dist/.env.local", "dist/.env.local"],
  ])("names %s, not a disposable walked folder listed first", async (_name, file, entry) => {
    const tree = await createTree();
    await wrangler(tree);
    await writeFixture(tree.holder, file, "\n");
    await expectKept(tree, `ignored ${entry} is not disposable`);
  });

  test.each([
    ["turns from a folder into a file", "rmdir .wrangler/tmp && touch .wrangler/tmp"],
    ["renames an entry under a disposable folder", "mv .wrangler/tmp/a .wrangler/tmp/b"],
  ])("holds a walked folder that %s between reads", async (_name, change) => {
    const tree = await createTree();
    await wrangler(tree);
    if (change.startsWith("mv")) await writeFixture(tree.holder, ".wrangler/tmp/a", "\n");

    const bin = join(tree.directory, "bin");
    const count = join(tree.directory, "lsof-calls");
    await writeFixture(
      bin,
      "lsof",
      `#!/bin/sh\necho x >> '${count}'\nif [ "$(wc -l < '${count}')" -gt 1 ]; then cd '${tree.holder}' && ${change} || exit 1; fi\nprintf 'p1\\nn/\\n'\n`,
    );

    await chmod(join(bin, "lsof"), 0o755);
    tree.env.PATH = `${bin}:${tree.env.PATH}`;
    await expectKept(tree, "changed since the first read");
  });

  test.skipIf(process.getuid?.() === 0)(
    "holds a walked folder it cannot read as a failed read",
    async () => {
      const tree = await createTree();
      await wrangler(tree);
      await writeFixture(tree.holder, ".wrangler/state/v3/db.sqlite", "\n");

      const locked = join(tree.holder, ".wrangler/state");
      await chmod(locked, 0o000);

      try {
        const before = await worktreeList(tree);
        const result = await release(tree);

        expect(result.code).toBe(1);
        expect(result.stdout).toStartWith(`kept 1 ${tree.holder}: EACCES`);
        expect(await worktreeList(tree)).toBe(before);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  test("holds an env file inside husky's generated hooks", async () => {
    const tree = await createTree();
    await track(tree, ".husky/pre-commit");
    await writeFixture(tree.holder, ".husky/_/.gitignore", "*");
    await writeFixture(tree.holder, ".husky/_/.env.local", "SECRET=1\n");
    await expectKept(tree, "ignored .husky/_/.env.local is not disposable");
  });

  test.each([
    ["web/test-results", "released 1"],
    ["feed/test-results", "kept 1"],
  ])("a PLANS_DISPOSABLE name of %s matches the last segments", async (name, outcome) => {
    const tree = await createTree();
    await track(tree, "apps/web/package.json");
    await writeFixture(tree.repo, ".git/info/exclude", "test-results/\n");
    await writeFixture(tree.holder, "apps/web/test-results/trace.zip", "\n");
    await conf(tree, `PLANS_DISPOSABLE=${name}\n`);

    const result = await release(tree);
    expect(result.stdout).toStartWith(`${outcome} ${tree.holder}`);
  });

  test.each(["CLOSED", "OPEN"])(
    "releases a dropped row's checkout inside its %s PR's head",
    async (state) => {
      const tree = await createTree();
      await index(tree, [row("1", "DROPPED", "feat/a")]);
      await pr(
        tree,
        "feat/a",
        (await fixtureGit(tree.repo, ["rev-parse", "feat/a"])).trim(),
        state,
      );

      const result = await release(tree);
      expect([result.code, result.stdout]).toEqual([
        0,
        `released 1 ${tree.holder}\nreleased 1 of 1\n`,
      ]);
    },
  );

  test("holds a dropped row's checkout with its own commits that never had a PR", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "DROPPED", "feat/a")]);
    await writeFile(join(tree.directory, "gh", prKey("feat/a")), "[]");
    await expectKept(tree, "no PR head to check its commits against");
  });

  test("releases a dropped row's checkout already on the trunk that never had a PR", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "DROPPED", "feat/a")]);
    await writeFile(join(tree.directory, "gh", prKey("feat/a")), "[]");
    await fixtureGit(tree.repo, ["fetch", "--quiet", "origin"]);
    await fixtureGit(tree.holder, ["reset", "--quiet", "--hard", "origin/main"]);

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `released 1 ${tree.holder}\nreleased 1 of 1\n`,
    ]);
  });

  test("releases an env file whose lines all come from the primary or .env.example", async () => {
    const tree = await createTree();
    await writeFixture(tree.repo, ".env.local", "TOKEN=1\n");
    await writeFixture(tree.holder, ".env.example", "# sample\nURL=https://x\n");
    await commitFixture(tree.holder);
    await pr(tree, "feat/a", (await fixtureGit(tree.holder, ["rev-parse", "HEAD"])).trim());

    await writeFixture(tree.holder, ".env.local", "TOKEN=1\nURL=https://x\n");

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `released 1 ${tree.holder}\nreleased 1 of 1\n`,
    ]);
  });

  test("holds an env file with a line found nowhere else", async () => {
    const tree = await createTree();
    await writeFixture(tree.repo, ".env.local", "TOKEN=1\n");
    await writeFixture(tree.holder, ".env.local", "TOKEN=1\nURL=https://y\n");
    await expectKept(tree, "ignored .env.local is not disposable");
  });

  test("releases an ignored android directory once PLANS_DISPOSABLE names it", async () => {
    const tree = await createTree();
    await writeFixture(tree.holder, "android/build.gradle", "\n");
    await conf(tree, "PLANS_DISPOSABLE=ios android\n");

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `released 1 ${tree.holder}\nreleased 1 of 1\n`,
    ]);

    expect(existsSync(tree.holder)).toBe(false);
  });

  test("holds a checkout a process works in", async () => {
    const tree = await createTree();
    await mkdir(join(tree.holder, "node_modules/deep"), { recursive: true });
    const child = Bun.spawn(["sleep", "30"], { cwd: join(tree.holder, "node_modules/deep") });
    try {
      await expectKept(tree, `process ${child.pid} works in it`);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("holds every checkout and exits 1 with no readable process list", async () => {
    const tree = await createTree();
    const bin = join(tree.directory, "bin");
    await writeFixture(bin, "lsof", "#!/bin/sh\nexit 1\n");
    await chmod(join(bin, "lsof"), 0o755);
    tree.env.PATH = `${bin}:${tree.env.PATH}`;

    await expectKept(tree, "lsof exited 1, cannot list process working directories", 1);
  });

  test("holds every checkout and exits 1 when PLANS_DISPOSABLE is set twice", async () => {
    const tree = await createTree();
    await conf(tree, "PLANS_DISPOSABLE=android\nPLANS_DISPOSABLE=ios\n");
    await expectKept(tree, `${tree.env.SKILLS_CONF}: PLANS_DISPOSABLE is set more than once`, 1);
  });

  test("holds every checkout and exits 1 with no lsof on PATH", async () => {
    const tree = await createTree();
    const bin = join(tree.directory, "bin");
    await mkdir(bin);

    for (const tool of ["git", "bun", "readlink"])
      await symlink(Bun.which(tool) ?? tool, join(bin, tool));

    tree.env.PATH = `${stubBin}:${bin}`;
    await expectKept(tree, "lsof not found, cannot list process working directories", 1);
  });

  test("a removal git refuses is kept with its first error line and the next one goes on", async () => {
    const tree = await createTree();
    await fixtureGit(tree.repo, ["checkout", "--quiet", "-b", "feat/b", "feat/a"]);
    await fixtureGit(tree.repo, ["checkout", "--quiet", "main"]);
    await index(tree, [row("1", "DONE", "feat/a"), row("2", "DONE", "feat/b")]);
    await pr(tree, "feat/b", (await fixtureGit(tree.repo, ["rev-parse", "feat/b"])).trim());

    const second = join(tree.directory, "wt-b");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", second, "feat/b"]);

    const bin = join(tree.directory, "bin");
    const git = Bun.which("git") ?? "git";
    await writeFixture(
      bin,
      "git",
      `#!/bin/sh\ncase "$*" in *"worktree remove ${tree.holder}") echo "fatal: refused by the fixture" >&2; echo "second line" >&2; exit 128;; esac\nexec ${git} "$@"\n`,
    );

    await chmod(join(bin, "git"), 0o755);
    tree.env.PATH = `${bin}:${tree.env.PATH}`;

    const result = await release(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      [
        `kept 1 ${tree.holder}: fatal: refused by the fixture`,
        `released 2 ${second}`,
        "released 1 of 2",
        "",
      ].join("\n"),
    );

    expect(existsSync(join(tree.holder, "node_modules/pkg/index.js"))).toBe(true);
    expect(existsSync(join(tree.holder, ".expo/settings.json"))).toBe(true);
    expect((await readdir(tree.directory)).filter((name) => name.includes(".release-"))).toEqual(
      [],
    );
  });

  test("holds a checkout that changed between the first read and the locked one", async () => {
    const tree = await createTree();
    const bin = join(tree.directory, "bin");
    const count = join(tree.directory, "lsof-calls");
    await writeFixture(
      bin,
      "lsof",
      `#!/bin/sh\necho x >> ${count}\nif [ "$(wc -l < ${count})" -gt 1 ]; then rm -rf ${tree.holder}/.expo; fi\nprintf 'p1\\nn/\\n'\n`,
    );

    await chmod(join(bin, "lsof"), 0o755);
    tree.env.PATH = `${bin}:${tree.env.PATH}`;
    await expectKept(tree, "changed since the first read");
  });

  test("holds the checkout it runs in", async () => {
    const tree = await createTree();
    const before = await worktreeList(tree);

    const result = await release(tree, ["fixture"], tree.holder);
    expect([result.code, result.stdout]).toEqual([
      0,
      `kept 1 ${tree.holder}: the checkout this runs in\nreleased 0 of 1\n`,
    ]);

    expect(await worktreeList(tree)).toBe(before);
  });

  test("exits 1 on a read failure even with no candidate", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "REVIEW", "feat/a")]);
    await conf(tree, "PLANS_DISPOSABLE=android\nPLANS_DISPOSABLE=ios\n");

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([1, "released 0 of 0\n"]);
    expect(result.stderr).toBe(
      `release: ${tree.env.SKILLS_CONF}: PLANS_DISPOSABLE is set more than once\n`,
    );
  });

  test("holds an env file nested in a directory PLANS_DISPOSABLE names", async () => {
    const tree = await createTree();
    await writeFixture(tree.holder, "android/app/.env.local", "SECRET=1\n");
    await conf(tree, "PLANS_DISPOSABLE=android\n");

    await expectKept(tree, "ignored android/app/.env.local is not disposable");
  });

  test("holds an env file nested in a built in cache directory", async () => {
    const tree = await createTree();
    await writeFixture(tree.holder, "dist/.env.local", "SECRET=1\n");
    await expectKept(tree, "ignored dist/.env.local is not disposable");
  });

  test("puts back the paths an interrupted run parked beside a checkout that survived", async () => {
    const tree = await createTree();
    const trash = join(tree.directory, ".wt-a.release-00000000-0000-0000-0000-000000000000");

    await mkdir(trash);
    await writeFile(join(trash, "entries.json"), JSON.stringify(["node_modules/", ".expo/"]));
    await rename(join(tree.holder, "node_modules"), join(trash, "0"));
    await writeFixture(tree.holder, "notes.txt", "work\n");

    await expectKept(tree, "untracked notes.txt");
    expect(existsSync(join(tree.holder, "node_modules/pkg/index.js"))).toBe(true);
    expect(existsSync(join(tree.holder, ".expo/settings.json"))).toBe(true);
    expect(existsSync(trash)).toBe(false);
  });

  test("leaves parked paths in place when the checkout already has newer ones", async () => {
    const tree = await createTree();
    const trash = join(tree.directory, ".wt-a.release-00000000-0000-0000-0000-000000000000");

    await mkdir(join(trash, "0"), { recursive: true });
    await writeFile(join(trash, "entries.json"), JSON.stringify(["node_modules/"]));
    await writeFile(join(trash, "0", "old.js"), "old\n");

    const result = await release(tree, ["fixture"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      `release: cannot settle ${trash}: ${join(tree.holder, "node_modules")} exists, ${join(trash, "0")} is left in place\n`,
    );

    expect(result.stdout).toBe(
      `kept 1 ${tree.holder}: an interrupted release left ${trash}\nreleased 0 of 1\n`,
    );

    expect(existsSync(join(trash, "0", "old.js"))).toBe(true);
    expect(existsSync(join(tree.holder, "node_modules/pkg/index.js"))).toBe(true);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a scan that throws holds that checkout, exits 1 and still counts",
    async () => {
      const tree = await createTree();
      const locked = join(tree.holder, "android/secret");

      await writeFixture(locked, "file", "\n");
      await conf(tree, "PLANS_DISPOSABLE=android\n");
      await chmod(locked, 0o000);

      try {
        const result = await release(tree);

        expect(result.code).toBe(1);
        expect(result.stdout).toStartWith(`kept 1 ${tree.holder}: `);
        expect(result.stdout).toContain("EACCES");
        expect(result.stdout).toEndWith("released 0 of 1\n");
        expect(existsSync(tree.holder)).toBe(true);
      } finally {
        await chmod(locked, 0o755);
      }
    },
  );

  test("holds a checkout missing on disk without failing the run", async () => {
    const tree = await createTree();
    await removeTemporary(tree.holder);

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `kept 1 ${tree.holder}: missing on disk\nreleased 0 of 1\n`,
    ]);
  });

  test("never offers the primary checkout or a row still open", async () => {
    const tree = await createTree();
    await index(tree, [row("1", "REVIEW", "feat/a"), row("3", "DONE", "main")]);

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([0, "released 0 of 0\n"]);
    expect(existsSync(tree.holder)).toBe(true);
  });

  test("refuses outside a checkout of the project", async () => {
    const tree = await createTree();
    const result = await release(tree, ["other"]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  test.each([
    ["live false", (path: string) => [{ path, live: false }], undefined],
    ["live true", (path: string) => [{ path, live: true }], "harness reports a live turn"],
    ["no entry", () => [], "no harness facts"],
  ])("with facts, %s", async (_, facts, reason) => {
    const tree = await createTree();
    const before = await worktreeList(tree);
    const stdin = JSON.stringify(facts(tree.holder));

    const result = await release(tree, ["fixture", "--facts"], tree.repo, stdin);
    expect([result.code, result.stderr]).toEqual([0, ""]);

    if (reason === undefined) {
      expect(result.stdout).toBe(`released 1 ${tree.holder}\nreleased 1 of 1\n`);
      expect(await worktreeList(tree)).not.toContain(tree.holder);
      return;
    }

    expect(result.stdout).toBe(`kept 1 ${tree.holder}: ${reason}\nreleased 0 of 1\n`);
    expect(await worktreeList(tree)).toBe(before);
  });

  test.each([
    ["{}", "release: facts are not a JSON array\n"],
    ["not json", "release: facts are not JSON: "],
  ])("refuses facts %p with exit 2 and removes nothing", async (stdin, err) => {
    const tree = await createTree();
    const before = await worktreeList(tree);

    const result = await release(tree, ["fixture", "--facts"], tree.repo, stdin);
    expect([result.code, result.stdout]).toEqual([2, ""]);
    expect(result.stderr.startsWith(err)).toBe(true);
    expect(await worktreeList(tree)).toBe(before);
  });

  test("holds a path listed twice or malformed and releases one with a valid entry", async () => {
    const tree = await createTree();
    await fixtureGit(tree.repo, ["checkout", "--quiet", "-b", "feat/b", "feat/a"]);
    await fixtureGit(tree.repo, ["checkout", "--quiet", "main"]);
    await index(tree, [row("1", "DONE", "feat/a"), row("2", "DONE", "feat/b")]);
    await pr(tree, "feat/b", (await fixtureGit(tree.repo, ["rev-parse", "feat/b"])).trim());

    const second = join(tree.directory, "wt-b");
    await fixtureGit(tree.repo, ["worktree", "add", "--quiet", second, "feat/b"]);

    const stdin = JSON.stringify([
      { path: tree.holder, live: false },
      { path: second, live: false },
      { path: tree.holder, live: false },
      { path: tree.holder, live: "no" },
      { live: false },
    ]);

    const result = await release(tree, ["fixture", "--facts"], tree.repo, stdin);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        `kept 1 ${tree.holder}: no harness facts`,
        `released 2 ${second}`,
        "released 1 of 2",
        "",
      ].join("\n"),
    );

    expect(result.stderr).toBe(
      [
        `release: facts for ${tree.holder}: listed more than once`,
        `release: facts for ${tree.holder}: listed more than once`,
        "release: facts for entry 5: path is not a path",
        "",
      ].join("\n"),
    );

    expect(await worktreeList(tree)).toContain(tree.holder);
  });

  test("holds a malformed entry for its path", async () => {
    const tree = await createTree();
    const stdin = JSON.stringify([{ path: tree.holder, live: "no" }]);

    const result = await release(tree, ["fixture", "--facts"], tree.repo, stdin);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      0,
      `kept 1 ${tree.holder}: no harness facts\nreleased 0 of 1\n`,
      `release: facts for ${tree.holder}: live is not a boolean\n`,
    ]);
  });

  test("with facts, a global failure names its reason ahead of the facts hold", async () => {
    const tree = await createTree();
    await conf(tree, "PLANS_DISPOSABLE=android\nPLANS_DISPOSABLE=ios\n");

    const result = await release(tree, ["fixture", "--facts"], tree.repo, "[]");
    expect([result.code, result.stdout]).toEqual([
      1,
      `kept 1 ${tree.holder}: ${tree.env.SKILLS_CONF}: PLANS_DISPOSABLE is set more than once\nreleased 0 of 1\n`,
    ]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a later run removes the trash a failed delete left where the parent holds no checkout",
    async () => {
      const tree = await createTree();
      const { holder, trash, first } = await strandTrash(tree);

      expect(first.code).toBe(1);
      expect(first.stdout).toBe(`released 1 ${holder}\nreleased 1 of 1\n`);
      expect(first.stderr).toStartWith(`release: cannot remove ${trash}: `);
      expect(first.stderr.trimEnd().split("\n")).toHaveLength(1);

      expect(existsSync(holder)).toBe(false);
      expect(existsSync(trash)).toBe(true);
      expect(await Bun.file(recordOf(tree)).json()).toEqual([trash]);

      const second = await release(tree);
      expect([second.code, second.stdout, second.stderr]).toEqual([0, "released 0 of 0\n", ""]);
      expect(existsSync(trash)).toBe(false);
      expect(existsSync(recordOf(tree))).toBe(false);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "a recorded path that is not trash is cleared from the record and left on disk",
    async () => {
      const tree = await createTree();
      const { parent, trash } = await strandTrash(tree);
      const sibling = join(parent, "notes");
      const gone = join(parent, ".wt-a.release-00000000-0000-0000-0000-000000000000");

      const recorded: unknown = await Bun.file(recordOf(tree)).json();
      expect(recorded).toEqual([trash]);

      await writeFixture(sibling, "kept.txt", "work\n");
      await writeFile(recordOf(tree), JSON.stringify([trash, sibling, gone]));

      const result = await release(tree);
      expect([result.code, result.stdout, result.stderr]).toEqual([0, "released 0 of 0\n", ""]);
      expect(existsSync(join(sibling, "kept.txt"))).toBe(true);
      expect(existsSync(trash)).toBe(false);
      expect(existsSync(recordOf(tree))).toBe(false);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "a trash whose manifest cannot be removed is left whole until a later run can claim it",
    async () => {
      const tree = await createTree();
      const { trash, first } = await strandTrash(tree, "");

      expect(first.code).toBe(1);
      expect(first.stderr).toStartWith(`release: cannot remove ${trash}: `);
      expect(existsSync(join(trash, "entries.json"))).toBe(true);
      expect(existsSync(join(trash, "0/settings.json"))).toBe(true);
      expect(existsSync(join(trash, "2/pkg/index.js"))).toBe(true);

      const second = await release(tree);
      expect([second.code, second.stdout, second.stderr]).toEqual([0, "released 0 of 0\n", ""]);
      expect(existsSync(trash)).toBe(false);
      expect(existsSync(recordOf(tree))).toBe(false);
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "a recorded path that cannot be read is reported and kept while the others settle",
    async () => {
      const tree = await createTree();
      const { trash } = await strandTrash(tree);
      const sealed = join(tree.directory, "sealed");
      const hidden = join(sealed, ".wt-z.release-00000000-0000-0000-0000-000000000000");

      await mkdir(hidden, { recursive: true });
      await writeFile(recordOf(tree), JSON.stringify([hidden, trash]));
      await chmod(sealed, 0o000);

      try {
        const result = await release(tree);

        expect([result.code, result.stdout]).toEqual([1, "released 0 of 0\n"]);
        expect(result.stderr).toStartWith(`release: cannot settle ${hidden}: `);
        expect(result.stderr.trimEnd().split("\n")).toHaveLength(1);
        expect(existsSync(trash)).toBe(false);
        expect(await Bun.file(recordOf(tree)).json()).toEqual([hidden]);
      } finally {
        await chmod(sealed, 0o755);
      }
    },
  );

  test.skipIf(process.getuid?.() === 0)(
    "a dry run leaves recorded trash and its record as found",
    async () => {
      const tree = await createTree();
      const { trash } = await strandTrash(tree);

      const result = await release(tree, ["fixture", "--dry-run"]);
      expect([result.code, result.stdout, result.stderr]).toEqual([
        0,
        "would release 0 of 0\n",
        "",
      ]);

      expect(existsSync(trash)).toBe(true);
      expect(await Bun.file(recordOf(tree)).json()).toEqual([trash]);
    },
  );

  test("puts back the paths recorded trash parked beside a directory no scan covers", async () => {
    const tree = await createTree();
    const checkout = join(tree.directory, "elsewhere", "wt-x");
    const trash = join(
      tree.directory,
      "elsewhere",
      ".wt-x.release-00000000-0000-0000-0000-000000000000",
    );

    await mkdir(checkout, { recursive: true });
    await writeFixture(trash, "0/index.js", "module.exports = 1;\n");
    await writeFile(join(trash, "entries.json"), JSON.stringify(["node_modules/"]));
    await writeFile(recordOf(tree), JSON.stringify([trash]));

    const result = await release(tree);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(existsSync(join(checkout, "node_modules/index.js"))).toBe(true);
    expect(existsSync(trash)).toBe(false);
    expect(existsSync(recordOf(tree))).toBe(false);
  });

  test("a release that deletes its own trash leaves no record", async () => {
    const tree = await createTree();

    const result = await release(tree);
    expect([result.code, result.stdout]).toEqual([
      0,
      `released 1 ${tree.holder}\nreleased 1 of 1\n`,
    ]);

    expect(existsSync(recordOf(tree))).toBe(false);
  });

  test("a record that is not a JSON array keeps every checkout and exits 1", async () => {
    const tree = await createTree();
    await writeFile(recordOf(tree), "{");

    const result = await release(tree);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe(
      `kept 1 ${tree.holder}: ${recordOf(tree)} is not a JSON array\nreleased 0 of 1\n`,
    );

    expect(result.stderr).toBe(`release: ${recordOf(tree)} is not a JSON array\n`);
    expect(existsSync(join(tree.holder, "node_modules/pkg/index.js"))).toBe(true);
    expect(await Bun.file(recordOf(tree)).text()).toBe("{");
  });
});
