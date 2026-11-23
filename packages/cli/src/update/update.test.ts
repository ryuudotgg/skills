import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { updateUsage } from "../areas/install.ts";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { dashboardRelease } from "../test/dashboard-release.ts";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { updateLock } from "./release.ts";
import { runUpdate } from "./update.ts";

const repo = resolve(import.meta.dir, "../../../..");
const origin = "https://github.com/ryuudotgg/skills.git";
const url = (tag: string) => `https://github.com/ryuudotgg/skills/releases/tag/${tag}`;
const scratch: string[] = [];

afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Spec = {
  tags?: readonly string[];
  offMain?: string;
  annotated?: boolean;
  labels?: Record<string, string>;
  brokenDependencies?: string;
  unverified?: readonly string[];
  releases?: Record<string, Record<string, unknown> | "missing">;
  workspaceFrom?: string;
  dashboard?: Record<string, "match" | "mismatch">;
};

function installer(version: string, filter: string): string {
  return [
    "#!/bin/sh",
    `printf 'deps %s%s\\n' ${version} '${filter}' >> "$UPDATE_INSTALL_LOG"`,
    `${JSON.stringify(process.execPath)} install --frozen-lockfile --ignore-scripts --production${filter} >&2 || exit 1`,
    `if [ "\${UPDATE_INSTALL_KILL-}" = ${version} ]; then exec perl -e 'setpgrp(0,0); kill "KILL", getppid(); select(undef, undef, undef, 0.1) while -e $ENV{UPDATE_INSTALL_HOLD}'; fi`,
    `if [ -t 0 ]; then terminal=tty; else terminal=notty; fi`,
    `printf '%s %s %s%s\\n' ${version} "$#" "$terminal" "\${SKILLS_INSTALL_SHIPPED_TO:+ shipped $SKILLS_INSTALL_SHIPPED_TO}" >> "$UPDATE_INSTALL_LOG"`,
    `echo "installer ${version} ran"`,
    `if [ "\${UPDATE_INSTALL_DIRTY-}" = ${version} ]; then echo edited >> package.json; exit 1; fi`,
    `if [ "\${UPDATE_INSTALL_UNMERGED-}" = ${version} ]; then echo edited >> package.json; blob=$(git hash-object -w package.json); printf '100644 %s %s\\tunmerged\\n' "$blob" 1 "$blob" 2 "$blob" 3 | git update-index --index-info; exit 1; fi`,
    `if [ "\${UPDATE_INSTALL_FAIL-}" = ${version} ]; then eval "\${UPDATE_INSTALL_FAIL_RUN-}"; exit 1; fi`,
    "",
  ].join("\n");
}

async function commitVersion(
  seed: string,
  version: string,
  broken: boolean,
  workspace: boolean,
): Promise<string> {
  const dependencies = broken ? { dependencies: { "skills-update-missing": "1.0.0" } } : {};
  const cli = { name: "skills-cli", version, ...dependencies };
  const root = workspace
    ? { name: "skills", version, private: true, workspaces: ["packages/*"] }
    : cli;

  await writeFixture(seed, "package.json", `${JSON.stringify(root)}\n`);

  if (workspace) {
    rmSync(join(seed, "src"), { recursive: true, force: true });
    await writeFixture(seed, "packages/cli/package.json", `${JSON.stringify(cli)}\n`);
    await writeFixture(seed, "packages/cli/src/cli.ts", `console.log("${version}");\n`);
  } else await writeFixture(seed, "src/cli.ts", `console.log("${version}");\n`);

  await writeFixture(
    seed,
    "install.sh",
    installer(version, workspace ? " --filter skills-cli" : ""),
  );

  chmodSync(join(seed, "install.sh"), 0o755);
  await fixtureGit(seed, ["add", "-A"]);
  await fixtureGit(seed, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    `release ${version}`,
  ]);

  return (await fixtureGit(seed, ["rev-parse", "HEAD"])).trim();
}

async function releaseAssets(root: string, tag: string, sums?: "match" | "mismatch") {
  if (!sums) return [];

  const release = await dashboardRelease(root, tag.slice(1));
  if (sums === "mismatch") release.breakSums();

  return release.assets;
}

async function fixture(spec: Spec = {}) {
  const root = mkdtempSync(join(tmpdir(), "skills-update-"));
  scratch.push(root);

  const seed = join(root, "seed");
  const bare = join(root, "origin.git");
  const clone = join(root, "clone");
  const stubs = join(root, "gh");
  const log = join(root, "install.log");

  writeFileSync(log, "");

  await fixtureGit(root, ["init", "-q", "-b", "main", seed]);
  await writeFixture(seed, ".gitignore", "node_modules/\n");

  const shas: Record<string, string> = {};

  let workspace = false;
  for (const tag of ["v1.0.0", ...(spec.tags ?? ["v1.1.0"])]) {
    workspace ||= tag === spec.workspaceFrom;
    if (tag === spec.offMain) await fixtureGit(seed, ["checkout", "-q", "-b", "side"]);

    shas[tag] = await commitVersion(
      seed,
      spec.labels?.[tag] ?? tag.slice(1),
      spec.brokenDependencies === tag,
      workspace,
    );

    await fixtureGit(seed, spec.annotated ? ["tag", "-a", "-m", tag, tag] : ["tag", tag]);
    if (tag === spec.offMain) await fixtureGit(seed, ["checkout", "-q", "main"]);
  }

  await fixtureGit(root, ["clone", "-q", "--bare", seed, bare]);
  await fixtureGit(bare, ["branch", "-D", "side"]).catch(() => "");

  await fixtureGit(root, ["clone", "-q", bare, clone]);
  await fixtureGit(clone, ["reset", "-q", "--hard", "v1.0.0"]);
  await fixtureGit(clone, ["remote", "set-url", "origin", origin]);
  await fixtureGit(clone, ["config", `url.${bare}.insteadOf`, origin]);

  for (const [tag, sha] of Object.entries(shas)) {
    const release = spec.releases?.[tag];
    if (release !== "missing")
      await writeFixture(
        stubs,
        `api_--hostname_github.com_repos_ryuudotgg_skills_releases_tags_${tag}`,
        JSON.stringify({
          tag_name: tag,
          draft: false,
          prerelease: false,
          published_at: "2026-10-30T00:00:00Z",
          html_url: url(tag),
          assets: await releaseAssets(root, tag, spec.dashboard?.[tag]),
          ...release,
        }),
      );

    await writeFixture(
      stubs,
      `api_--hostname_github.com_repos_ryuudotgg_skills_commits_${sha}`,
      JSON.stringify({
        sha,
        commit: { verification: { verified: !spec.unverified?.includes(tag) } },
      }),
    );
  }

  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
    HOME: root,
    AGENTS_DIR: join(root, "agents/skills"),
    GH_STUB_DIR: stubs,
    GH_STUB_LOG: join(root, "gh.log"),
    UPDATE_INSTALL_LOG: log,
    BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };

  delete env.CI;
  delete env.SKILLS_AUTO_UPDATE;

  const head = async () => (await fixtureGit(clone, ["rev-parse", "HEAD"])).trim();
  const state = async () => ({
    head: await head(),
    status: await fixtureGit(clone, ["status", "--porcelain", "--untracked-files=all"]),
    refs: await fixtureGit(clone, ["for-each-ref"]),
    installs: readFileSync(log, "utf8"),
  });

  const update = async (args: readonly string[] = [], extra: NodeJS.ProcessEnv = {}) => {
    let out = "";
    let err = "";
    const io: Io = {
      cwd: clone,
      env: { ...env, ...extra },
      out: (text) => {
        out += text;
      },
      err: (text) => {
        err += text;
      },
      capture: true,
    };

    const code = await runUpdate(args, updateUsage, clone, io);
    return { code, out, err };
  };

  const cli = (extra: NodeJS.ProcessEnv) =>
    runCommand(
      [
        process.execPath,
        join(repo, "packages/cli/src/cli.ts"),
        "--root",
        join(clone, "skills"),
        "update",
      ],
      { cwd: clone, env: { ...env, ...extra }, timeout: 60_000 },
    );

  const gitDir = (await fixtureGit(clone, ["rev-parse", "--absolute-git-dir"])).trim();
  return {
    root,
    clone,
    env,
    shas,
    head,
    state,
    update,
    cli,
    record: join(gitDir, "skills-update-record.json"),
    installs: () => readFileSync(log, "utf8"),
    dashboard: join(root, "agents/dashboard"),
  };
}

test("checks, applies once, then reports current", async () => {
  const fx = await fixture();

  expect(await fx.update(["--check"])).toMatchObject({
    code: 0,
    out: `available v1.1.0 ${url("v1.1.0")}\n`,
  });

  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe("");

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(applied.err).toContain("installer 1.1.0 ran");
  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
  expect(fx.installs()).toBe("deps 1.1.0\n1.1.0 0 notty\n");

  expect(await fx.update()).toMatchObject({ code: 0, out: "current v1.1.0\n" });
  expect(fx.installs()).toBe("deps 1.1.0\n1.1.0 0 notty\n");
});

test("a tracked file rewritten with the same content still fast forwards", async () => {
  const fx = await fixture();
  const manifest = join(fx.clone, "package.json");
  const content = readFileSync(manifest);
  await Bun.sleep(1100);
  writeFileSync(manifest, content);

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
  expect((await fx.state()).status).toBe("");
});

test("crosses the move from a root src to the skills-cli workspace", async () => {
  const fx = await fixture({ workspaceFrom: "v1.1.0" });
  expect(existsSync(join(fx.clone, "src/cli.ts"))).toBe(true);

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(fx.installs()).toBe("deps 1.1.0 --filter skills-cli\n1.1.0 0 notty\n");

  expect(existsSync(join(fx.clone, "src"))).toBe(false);
  expect(readFileSync(join(fx.clone, "packages/cli/src/cli.ts"), "utf8")).toContain("1.1.0");
  expect((await fx.state()).status).toBe("");
});

const refusals: [
  string,
  Spec,
  (fx: Awaited<ReturnType<typeof fixture>>) => Promise<unknown>,
  NodeJS.ProcessEnv,
  string,
][] = [
  [
    "a tracked change",
    {},
    (fx) => writeFixture(fx.clone, "package.json", "{}\n"),
    {},
    "the checkout has tracked changes",
  ],
  [
    "an untracked file",
    {},
    (fx) => writeFixture(fx.clone, "notes.txt", "mine\n"),
    {},
    "the checkout has untracked files",
  ],
  [
    "a feature branch",
    {},
    (fx) => fixtureGit(fx.clone, ["checkout", "-q", "-b", "feat/mine"]),
    {},
    "HEAD is on feat/mine, not main",
  ],
  [
    "a local commit on main",
    {},
    async (fx) => {
      await writeFixture(fx.clone, "mine.txt", "local\n");
      await fixtureGit(fx.clone, ["add", "-A"]);
      await fixtureGit(fx.clone, [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "local",
      ]);
    },
    {},
    "HEAD has commits v1.1.0 does not",
  ],
  [
    "a detached HEAD",
    {},
    (fx) => fixtureGit(fx.clone, ["checkout", "-q", "--detach"]),
    {},
    "HEAD is detached",
  ],
  [
    "a second origin URL",
    {},
    (fx) =>
      fixtureGit(fx.clone, [
        "remote",
        "set-url",
        "--add",
        "origin",
        "https://github.com/someone/skills.git",
      ]),
    {},
    "origin is not ryuudotgg/skills",
  ],
  [
    "another repository",
    {},
    (fx) =>
      fixtureGit(fx.clone, [
        "remote",
        "set-url",
        "origin",
        "https://github.com/someone/skills.git",
      ]),
    {},
    "origin is not ryuudotgg/skills",
  ],
  ["a release off main", { offMain: "v1.1.0" }, async () => {}, {}, "v1.1.0 is not on origin main"],
  [
    "an unverified commit",
    { unverified: ["v1.1.0"] },
    async () => {},
    {},
    "v1.1.0 is not a verified commit",
  ],
  [
    "a draft release",
    { releases: { "v1.1.0": { draft: true } } },
    async () => {},
    {},
    "v1.1.0 is a draft release",
  ],
  [
    "a prerelease",
    { releases: { "v1.1.0": { prerelease: true } } },
    async () => {},
    {},
    "v1.1.0 is a prerelease",
  ],
  [
    "a tag on another version",
    { labels: { "v1.1.0": "1.2.0" } },
    async () => {},
    {},
    "v1.1.0 is not version 1.1.0",
  ],
  [
    "a missing release",
    { releases: { "v1.1.0": "missing" } },
    async () => {},
    {},
    "cannot read the release of v1.1.0",
  ],
  ["CI", {}, async () => {}, { CI: "1" }, "CI is set"],
  ["auto updates off", {}, async () => {}, { SKILLS_AUTO_UPDATE: "0" }, "SKILLS_AUTO_UPDATE=0"],
  [
    "an unverified newest tag",
    { tags: ["v1.1.0", "v1.2.0"], unverified: ["v1.2.0"] },
    async () => {},
    {},
    "v1.2.0 is not a verified commit",
  ],
];

test.each(refusals)(
  "refuses %s and touches nothing",
  async (_name, spec, arrange, extra, reason) => {
    const fx = await fixture(spec);
    await arrange(fx);
    const before = await fx.state();

    for (const args of [["--check"], []])
      expect(await fx.update(args, extra)).toMatchObject({ code: 1, out: `refused ${reason}\n` });

    expect(await fx.state()).toEqual(before);
  },
);

test.each(["store", "checkout"])(
  "refuses while another process holds the %s lock",
  async (which) => {
    const fx = await fixture();
    const before = await fx.state();
    const gitDir = (await fixtureGit(fx.clone, ["rev-parse", "--absolute-git-dir"])).trim();
    const lock = which === "store" ? updateLock(fx.env) : join(gitDir, "skills-update.lock");
    await Bun.write(lock, "");

    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { tryLock } = await import(${JSON.stringify(join(repo, "packages/cli/src/lock.ts"))});
       await tryLock(${JSON.stringify(lock)}, async () => { console.log("held"); await Bun.sleep(30000); });`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );

    try {
      const reader = holder.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe("held\n");

      for (const args of [["--check"], []])
        expect(await fx.update(args)).toMatchObject({
          code: 1,
          out: "refused update lock is held\n",
        });

      expect(await fx.state()).toEqual(before);
    } finally {
      holder.kill();
      await holder.exited;
    }

    expect(await tryLock(lock, () => "free")).toEqual({ held: false, value: "free" });
  },
);

type Fixture = Awaited<ReturnType<typeof fixture>>;

const identity = "git -c user.name=t -c user.email=t@example.com -c commit.gpgsign=false";
const rev = async (fx: Fixture, ref: string) =>
  (await fixtureGit(fx.clone, ["rev-parse", ref])).trim();

function duringReleaseRead(fx: Fixture, commands: string): NodeJS.ProcessEnv {
  const bin = join(fx.root, "race");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "gh"),
    [
      "#!/bin/sh",
      `case "$*" in *releases/tags/*) (cd ${JSON.stringify(fx.clone)} && ${commands}) >&2 || exit 1 ;; esac`,
      `exec ${JSON.stringify(join(repo, "scripts/stubs/gh"))} "$@"`,
      "",
    ].join("\n"),
  );

  chmodSync(join(bin, "gh"), 0o755);
  return { PATH: `${bin}:${fx.env.PATH}` };
}

const moves: [string, Spec, string, string, (fx: Fixture) => Promise<void>][] = [
  [
    "a branch switch",
    {},
    "git checkout -q -b feat/work",
    "HEAD is on feat/work, not main",
    async (fx) => {
      expect(await rev(fx, "main")).toBe(fx.shas["v1.0.0"]!);
      expect(await rev(fx, "feat/work")).toBe(fx.shas["v1.0.0"]!);
    },
  ],
  [
    "a commit on main",
    {},
    `echo mine > mine.txt && git add mine.txt && ${identity} commit -q -m mine`,
    "HEAD has commits v1.1.0 does not",
    async (fx) => {
      expect(await fixtureGit(fx.clone, ["log", "-1", "--format=%s", "main"])).toBe("mine\n");
      expect(await rev(fx, "main^")).toBe(fx.shas["v1.0.0"]!);
    },
  ],
  [
    "a fast forward to an older release",
    { tags: ["v1.1.0", "v1.2.0"] },
    "git reset -q --hard v1.1.0",
    "HEAD moved while v1.2.0 was verified",
    async (fx) => {
      expect(await rev(fx, "main")).toBe(fx.shas["v1.1.0"]!);
    },
  ],
];

test.each(moves)(
  "refuses %s while the release is verified",
  async (_name, spec, commands, reason, check) => {
    const fx = await fixture(spec);

    const result = await fx.update([], duringReleaseRead(fx, commands));
    expect(result).toMatchObject({ code: 1, out: `refused ${reason}\n` });
    await check(fx);
    expect(fx.installs()).toBe("");
    expect(await fixtureGit(fx.clone, ["for-each-ref", "refs/skills-update"])).toBe("");
  },
);

test("moves no ref or file while another git process holds HEAD", async () => {
  const fx = await fixture();
  const before = await fx.state();

  const result = await fx.update([], duringReleaseRead(fx, "touch .git/HEAD.lock"));
  expect(result).toMatchObject({ code: 1, out: "refused fast forward failed\n" });
  expect(await fx.state()).toEqual(before);
  expect(existsSync(join(fx.clone, ".git/HEAD.lock"))).toBe(true);
});

const branches: [string, (fx: Fixture) => string, (fx: Fixture) => Promise<void>][] = [
  [
    "with a commit",
    () =>
      `git checkout -q -b feat/work && echo work > work.txt && git add work.txt && ${identity} commit -q -m work`,
    async (fx) => {
      expect(await fixtureGit(fx.clone, ["log", "-1", "--format=%s", "HEAD"])).toBe("work\n");
      expect(await rev(fx, "HEAD^")).toBe(fx.shas["v1.1.0"]!);
    },
  ],
  [
    "at the old commit",
    (fx) => `git checkout -q -b feat/work ${fx.shas["v1.0.0"]}`,
    async (fx) => {
      expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
    },
  ],
];

test.each(branches)(
  "a rollback leaves a branch made while the installer runs, %s",
  async (_name, commands, check) => {
    const fx = await fixture();

    const result = await fx.update([], {
      UPDATE_INSTALL_FAIL: "1.1.0",
      UPDATE_INSTALL_FAIL_RUN: commands(fx),
    });

    expect(result).toMatchObject({
      code: 1,
      out: "refused install failed, rollback stopped because the checkout moved\n",
    });

    expect(await fixtureGit(fx.clone, ["symbolic-ref", "--short", "HEAD"])).toBe("feat/work\n");
    await check(fx);
    expect(await rev(fx, "main")).toBe(fx.shas["v1.1.0"]!);
    expect(fx.installs()).toBe("deps 1.1.0\n1.1.0 0 notty\n");
  },
);

test("a rollback stops when the installer moves main back to the old commit", async () => {
  const fx = await fixture();

  const result = await fx.update([], {
    UPDATE_INSTALL_FAIL: "1.1.0",
    UPDATE_INSTALL_FAIL_RUN: `git reset -q --hard ${fx.shas["v1.0.0"]}`,
  });

  expect(result).toMatchObject({
    code: 1,
    out: "refused install failed, rollback stopped because the checkout moved\n",
  });

  expect(await fixtureGit(fx.clone, ["symbolic-ref", "--short", "HEAD"])).toBe("main\n");
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe("deps 1.1.0\n1.1.0 0 notty\n");
  expect(existsSync(fx.record)).toBe(true);
});

test("a failed installer restores the old checkout and reruns its installer", async () => {
  const fx = await fixture();

  const result = await fx.update([], { UPDATE_INSTALL_FAIL: "1.1.0" });
  expect(result).toMatchObject({ code: 1, out: "refused install failed\n" });
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe(
    `deps 1.1.0\n1.1.0 0 notty\ndeps 1.0.0\n1.0.0 0 notty shipped ${fx.shas["v1.1.0"]}\n`,
  );

  expect(await fixtureGit(fx.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  expect(existsSync(fx.record)).toBe(false);
});

test("the CLI prints only the update line on stdout", async () => {
  const fx = await fixture();

  const result = await runCommand(
    [
      process.execPath,
      join(repo, "packages/cli/src/cli.ts"),
      "--root",
      join(fx.clone, "skills"),
      "update",
      "--check",
    ],
    { cwd: fx.clone, env: fx.env, timeout: 30_000 },
  );

  expect([result.code, result.stdout]).toEqual([0, `available v1.1.0 ${url("v1.1.0")}\n`]);

  const usage = await runCommand(
    [process.execPath, join(repo, "packages/cli/src/cli.ts"), "update", "--force"],
    {
      cwd: fx.clone,
      env: fx.env,
      timeout: 30_000,
    },
  );

  expect([usage.code, usage.stdout, usage.stderr]).toEqual([
    2,
    "",
    "usage: skills update [--check]\n",
  ]);
});

test("the updater loads no module after the fast forward", () => {
  const seen = new Set<string>();
  const walk = (path: string) => {
    if (seen.has(path)) return;

    seen.add(path);
    const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(readFileSync(path, "utf8"));
    for (const entry of imports) {
      expect(entry.kind, `${path} imports ${entry.path} lazily`).toBe("import-statement");
      if (entry.path.startsWith(".")) walk(resolve(dirname(path), entry.path));
    }
  };

  walk(join(import.meta.dir, "update.ts"));
  expect(existsSync(join(import.meta.dir, "release.ts"))).toBe(true);
  expect(seen.size).toBeGreaterThan(3);
});

test("a failed dependency install in the new install.sh rolls back to the old one", async () => {
  const fx = await fixture({ brokenDependencies: "v1.1.0" });

  expect(await fx.update()).toMatchObject({ code: 1, out: "refused install failed\n" });
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe(
    `deps 1.1.0\ndeps 1.0.0\n1.0.0 0 notty shipped ${fx.shas["v1.1.0"]}\n`,
  );

  expect(await fixtureGit(fx.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
});

test("refuses while a merge is in progress", async () => {
  const fx = await fixture();
  const git = (await fixtureGit(fx.clone, ["rev-parse", "--absolute-git-dir"])).trim();

  writeFileSync(join(git, "MERGE_HEAD"), `${fx.shas["v1.0.0"]}\n`);
  const before = await fx.state();

  expect(await fx.update()).toMatchObject({ code: 1, out: "refused a merge is in progress\n" });
  expect(await fx.state()).toEqual(before);
});

test("the CLI applies with only the update line on stdout", async () => {
  const fx = await fixture();

  const result = await runCommand(
    [
      process.execPath,
      join(repo, "packages/cli/src/cli.ts"),
      "--root",
      join(fx.clone, "skills"),
      "update",
    ],
    { cwd: fx.clone, env: fx.env, timeout: 60_000 },
  );

  expect([result.code, result.stdout]).toEqual([0, `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n`]);
  expect(result.stderr).toContain("installer 1.1.0 ran");
});

test("follows annotated release tags to their commits", async () => {
  const fx = await fixture({ annotated: true });

  expect(await fx.update()).toMatchObject({
    code: 0,
    out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n`,
  });

  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
});

test("a rollback saves tracked edits before resetting", async () => {
  const fx = await fixture();

  const first = await fx.update([], { UPDATE_INSTALL_DIRTY: "1.1.0" });
  const saved = /edits saved in (refs\/skills-update\/edits\/[0-9a-f]{12})\n$/.exec(first.out)?.[1];
  expect(first.out).toStartWith("refused install failed, edits saved in ");
  expect(saved).toBeDefined();

  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(await fixtureGit(fx.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
  expect(await fixtureGit(fx.clone, ["show", `${saved}:package.json`])).toEndWith("edited\n");

  await fx.update([], { UPDATE_INSTALL_DIRTY: "1.1.0" });
  expect(await fixtureGit(fx.clone, ["show", `${saved}:package.json`])).toEndWith("edited\n");
});

test("rollback stops when edits cannot be saved", async () => {
  const fx = await fixture();

  const result = await fx.update([], { UPDATE_INSTALL_UNMERGED: "1.1.0" });
  expect(result.out).toBe("refused install failed, rollback stopped to keep edits\n");

  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
  expect(readFileSync(join(fx.clone, "package.json"), "utf8")).toEndWith("edited\n");
  expect(await fixtureGit(fx.clone, ["for-each-ref", "refs/skills-update/edits"])).toBe("");
  expect(fx.installs()).toBe("deps 1.1.0\n1.1.0 0 notty\n");
});

const notices = (err: string) => err.split("\n").filter((line) => line.startsWith("update: "));

test("an update installs the release's verified dashboard build", async () => {
  const fx = await fixture({ dashboard: { "v1.1.0": "match" } });

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(notices(applied.err)).toEqual([]);
  expect(readFileSync(join(fx.dashboard, "1.1.0/index.html"), "utf8")).toBe(
    "<p>dashboard 1.1.0</p>",
  );

  expect(readdirSync(fx.dashboard)).toEqual(["1.1.0"]);
});

test("a dashboard whose sha256 does not match leaves nothing and still updates", async () => {
  const fx = await fixture({ dashboard: { "v1.1.0": "mismatch" } });

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(notices(applied.err)).toEqual([
    "update: no dashboard build for 1.1.0: skills-dashboard-1.1.0.tar.gz does not match its sha256 in SHA256SUMS",
  ]);

  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
  expect(existsSync(fx.dashboard)).toBe(false);
});

test("a release with no dashboard asset still updates and says so", async () => {
  const fx = await fixture();

  const applied = await fx.update();
  expect(applied).toMatchObject({ code: 0, out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n` });
  expect(notices(applied.err)).toEqual([
    "update: no dashboard build for 1.1.0: skills-dashboard-1.1.0.tar.gz is missing from the v1.1.0 release",
  ]);

  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
});

test("an update killed during its installer finishes on the next run", async () => {
  const fx = await fixture({ dashboard: { "v1.1.0": "match" } });

  const killed = await fx.cli({ UPDATE_INSTALL_KILL: "1.1.0" });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);
  expect(await fx.head()).toBe(fx.shas["v1.1.0"]!);
  expect(existsSync(fx.record)).toBe(true);

  const files = async () => ({ ...(await fx.state()), record: readFileSync(fx.record, "utf8") });

  const before = await files();
  expect(await fx.update(["--check"])).toMatchObject({
    code: 1,
    out: "refused an update was interrupted, run skills update\n",
  });

  expect(await files()).toEqual(before);

  expect(await fx.update()).toMatchObject({
    code: 0,
    out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n`,
  });

  expect(fx.installs()).toBe(`${before.installs}deps 1.1.0\n1.1.0 0 notty\n`);
  expect(existsSync(fx.record)).toBe(false);
  expect(existsSync(join(fx.dashboard, "1.1.0/index.html"))).toBe(true);

  const settled = fx.installs();
  expect(await fx.update()).toMatchObject({ code: 0, out: "current v1.1.0\n" });
  expect(fx.installs()).toBe(settled);
});

test("an update killed during its rollback finishes the rollback on the next run", async () => {
  const fx = await fixture();

  const killed = await fx.cli({ UPDATE_INSTALL_FAIL: "1.1.0", UPDATE_INSTALL_KILL: "1.0.0" });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(existsSync(fx.record)).toBe(true);

  const before = fx.installs();
  expect(await fx.update()).toMatchObject({
    code: 1,
    out: "refused the interrupted update was rolled back\n",
  });

  expect(fx.installs()).toBe(`${before}deps 1.0.0\n1.0.0 0 notty shipped ${fx.shas["v1.1.0"]}\n`);
  expect(existsSync(fx.record)).toBe(false);
  expect(await fixtureGit(fx.clone, ["for-each-ref", "refs/skills-update/head"])).toBe("");

  expect(await fx.update()).toMatchObject({
    code: 0,
    out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n`,
  });
});

test("a stale update record is dropped once HEAD is back on its branch", async () => {
  const fx = await fixture({ tags: ["v1.1.0", "v1.2.0"] });

  const killed = await fx.cli({ UPDATE_INSTALL_KILL: "1.2.0" });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);
  expect(await fx.head()).toBe(fx.shas["v1.2.0"]!);

  await fixtureGit(fx.clone, ["reset", "-q", "--hard", "v1.1.0"]);
  await fixtureGit(fx.clone, ["checkout", "-q", "-b", "feat/x"]);
  expect(await fx.update()).toMatchObject({
    code: 1,
    out: "refused HEAD is on feat/x, not main\n",
  });

  expect(existsSync(fx.record)).toBe(true);

  await fixtureGit(fx.clone, ["checkout", "-q", "main"]);
  const checked = await fx.update(["--check"]);
  expect(checked).toMatchObject({ code: 0, out: `available v1.2.0 ${url("v1.2.0")}\n` });
  expect(checked.err).not.toContain("stale");
  expect(existsSync(fx.record)).toBe(true);

  const resumed = await fx.update();
  expect(
    resumed.err
      .split("\n")
      .filter((line) => line.startsWith("update: dropped a stale update record")),
  ).toHaveLength(1);

  expect(resumed).toMatchObject({ code: 0, out: `updated v1.1.0 -> v1.2.0 ${url("v1.2.0")}\n` });
  expect(existsSync(fx.record)).toBe(false);
  expect(await fixtureGit(fx.clone, ["for-each-ref", "refs/skills-update/head"])).toBe("");
});

test("an unreadable update record refuses and stays", async () => {
  const fx = await fixture();
  writeFileSync(fx.record, "{");
  const before = await fx.state();

  for (const args of [["--check"], []])
    expect(await fx.update(args)).toMatchObject({
      code: 1,
      out: "refused cannot read the checkout\n",
    });

  expect(await fx.state()).toEqual(before);
  expect(readFileSync(fx.record, "utf8")).toBe("{");
});

test("a settled update whose installer fails again rolls back", async () => {
  const fx = await fixture();

  const killed = await fx.cli({ UPDATE_INSTALL_KILL: "1.1.0" });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);

  expect(await fx.update([], { UPDATE_INSTALL_FAIL: "1.1.0" })).toMatchObject({
    code: 1,
    out: "refused install failed\n",
  });

  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toEndWith(`deps 1.0.0\n1.0.0 0 notty shipped ${fx.shas["v1.1.0"]}\n`);
  expect(existsSync(fx.record)).toBe(false);
});

test("an installer that outlives its killed update holds both update locks", async () => {
  const fx = await fixture();
  const hold = join(fx.root, "hold");
  writeFileSync(hold, "");

  const killed = await fx.cli({ UPDATE_INSTALL_KILL: "1.1.0", UPDATE_INSTALL_HOLD: hold });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);
  const before = fx.installs();

  for (const args of [["--check"], []])
    expect(await fx.update(args)).toMatchObject({ code: 1, out: "refused update lock is held\n" });

  expect(fx.installs()).toBe(before);
  expect(existsSync(fx.record)).toBe(true);

  const locks = [updateLock(fx.env), join(dirname(fx.record), "skills-update.lock")];
  for (const lock of locks) expect(await tryLock(lock, () => "free")).toEqual({ held: true });

  rmSync(hold);
  const deadline = Date.now() + 10_000;
  for (const lock of locks)
    while ((await tryLock(lock, () => "free")).held && Date.now() < deadline) await Bun.sleep(50);

  expect(await fx.update()).toMatchObject({
    code: 0,
    out: `updated v1.0.0 -> v1.1.0 ${url("v1.1.0")}\n`,
  });
});

test("a rollback installer that fails keeps the update record for the next run", async () => {
  const fx = await fixture();

  const killed = await fx.cli({ UPDATE_INSTALL_FAIL: "1.1.0", UPDATE_INSTALL_KILL: "1.0.0" });
  expect([killed.code, killed.stdout]).toEqual([1, ""]);

  const start = fx.shas["v1.0.0"]!.slice(0, 12);
  expect(await fx.update([], { UPDATE_INSTALL_FAIL: "1.0.0" })).toMatchObject({
    code: 1,
    out: `refused the interrupted update was rolled back, rollback failed at ${start}\n`,
  });

  expect(existsSync(fx.record)).toBe(true);
  expect(await fx.update()).toMatchObject({
    code: 1,
    out: "refused the interrupted update was rolled back\n",
  });

  expect(existsSync(fx.record)).toBe(false);
});
