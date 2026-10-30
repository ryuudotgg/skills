import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { updateLock } from "./release.ts";
import { runUpdate } from "./update.ts";

const repo = resolve(import.meta.dir, "../..");
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
};

function installer(version: string): string {
  return [
    "#!/bin/sh",
    `if [ -t 0 ]; then terminal=tty; else terminal=notty; fi`,
    `printf '%s %s %s\\n' ${version} "$#" "$terminal" >> "$UPDATE_INSTALL_LOG"`,
    `echo "installer ${version} ran"`,
    `if [ "\${UPDATE_INSTALL_FAIL-}" = ${version} ]; then exit 1; fi`,
    "",
  ].join("\n");
}

async function commitVersion(seed: string, version: string, broken = false): Promise<string> {
  const dependencies = broken ? { dependencies: { "skills-update-missing": "1.0.0" } } : {};

  await writeFixture(
    seed,
    "package.json",
    `${JSON.stringify({ name: "skills-cli", version, ...dependencies })}\n`,
  );

  await writeFixture(seed, "install.sh", installer(version));
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
  for (const tag of ["v1.0.0", ...(spec.tags ?? ["v1.1.0"])]) {
    if (tag === spec.offMain) await fixtureGit(seed, ["checkout", "-q", "-b", "side"]);

    shas[tag] = await commitVersion(
      seed,
      spec.labels?.[tag] ?? tag.slice(1),
      spec.brokenDependencies === tag,
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

    const code = await runUpdate(args, clone, io);
    return { code, out, err };
  };

  return { clone, env, shas, head, state, update, installs: () => readFileSync(log, "utf8") };
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
  expect(fx.installs()).toBe("1.1.0 0 notty\n");

  expect(await fx.update()).toMatchObject({ code: 0, out: "current v1.1.0\n" });
  expect(fx.installs()).toBe("1.1.0 0 notty\n");
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

test("refuses while another process holds the update lock", async () => {
  const fx = await fixture();
  const before = await fx.state();
  const lock = updateLock(fx.env);
  await Bun.write(lock, "");

  const holder = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { tryLock } = await import(${JSON.stringify(join(repo, "src/lock.ts"))});
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
});

test("a failed installer restores the old checkout and reruns its installer", async () => {
  const fx = await fixture();

  const result = await fx.update([], { UPDATE_INSTALL_FAIL: "1.1.0" });
  expect(result).toMatchObject({ code: 1, out: "refused install failed\n" });
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe("1.1.0 0 notty\n1.0.0 0 notty\n");
  expect(await fixtureGit(fx.clone, ["status", "--porcelain", "--untracked-files=all"])).toBe("");
});

test("the CLI prints only the update line on stdout", async () => {
  const fx = await fixture();

  const result = await runCommand(
    [
      process.execPath,
      join(repo, "src/cli.ts"),
      "--root",
      join(fx.clone, "skills"),
      "update",
      "--check",
    ],
    { cwd: fx.clone, env: fx.env, timeout: 30_000 },
  );

  expect([result.code, result.stdout]).toEqual([0, `available v1.1.0 ${url("v1.1.0")}\n`]);

  const usage = await runCommand(
    [process.execPath, join(repo, "src/cli.ts"), "update", "--force"],
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

test("a failed dependency install still reruns the old installer", async () => {
  const fx = await fixture({ brokenDependencies: "v1.1.0" });

  expect(await fx.update()).toMatchObject({ code: 1, out: "refused dependencies failed\n" });
  expect(await fx.head()).toBe(fx.shas["v1.0.0"]!);
  expect(fx.installs()).toBe("1.0.0 0 notty\n");
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
    [process.execPath, join(repo, "src/cli.ts"), "--root", join(fx.clone, "skills"), "update"],
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
