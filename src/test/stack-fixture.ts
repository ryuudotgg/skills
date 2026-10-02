import { expect } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../io.ts";
import { indexPath } from "../plans/index-tsv.ts";
import { baseKey } from "../stack/skills-base.ts";
import { writeFixture } from "./fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment, type CommandResult } from "./process.ts";

export type StackVerb = (args: readonly string[], io: Io) => Promise<number>;
export type StackCase = Awaited<ReturnType<typeof stackCase>>;
export type StackCommit = {
  branch: string;
  from?: string;
  base?: string;
  message: string;
  files?: Readonly<Record<string, string>>;
};

export type StackSpec = {
  name: string;
  directory?: string;
  mode?: "clone" | "init";
  remote?: boolean;
  publish?: "push" | "fetch" | "none";
  commits: readonly StackCommit[];
  checkout: string;
  index?: { project: string; text: string };
};

export async function stackCase(prefix: string, options: { assertNoGhCalls?: boolean } = {}) {
  const temporary = realpathSync(await mkdtemp(join(tmpdir(), prefix)));
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    HOME: join(temporary, "home"),
    PLANS_DIR: join(temporary, "plans"),
    SKILLS_CONF: join(temporary, "skills.conf"),
    GH_STUB_DIR: join(temporary, "gh"),
    GH_STUB_LOG: join(temporary, "gh.log"),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "maintenance.auto",
    GIT_CONFIG_VALUE_0: "false",
    GIT_CONFIG_KEY_1: "gc.auto",
    GIT_CONFIG_VALUE_1: "0",
    GIT_AUTHOR_NAME: "test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    PATH: `${resolve(import.meta.dir, "../../scripts/stubs")}:${process.env.PATH ?? ""}`,
  };

  delete env.SKILLS_OWN_ROWS;
  delete env.XDG_CONFIG_HOME;

  try {
    for (const path of ["home", "plans", "gh"]) await mkdir(join(temporary, path));
    await writeFile(env.SKILLS_CONF!, "DELIVERY=prs\n");
    await writeFile(join(temporary, "gh.log"), "");
  } catch (error) {
    await removeTemporary(temporary);
    throw error;
  }

  async function command(argv: readonly string[], cwd: string): Promise<CommandResult> {
    const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
    expect(result.timedOut, argv.join(" ")).toBe(false);
    return result;
  }

  async function git(args: readonly string[], cwd: string): Promise<string> {
    const result = await command(["git", ...args], cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trimEnd();
  }

  async function run(
    verb: StackVerb,
    args: readonly string[],
    cwd: string,
  ): Promise<CommandResult> {
    let stdout = "";
    let stderr = "";
    const io: Io = {
      cwd,
      env,
      out: (text) => {
        stdout += text;
      },
      err: (text) => {
        stderr += text;
      },
      capture: true,
    };

    let code: number;
    try {
      code = await verb(args, io);
    } catch (error) {
      io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      code = 1;
    }

    return { code, stdout, stderr, timedOut: false };
  }

  async function executable(path: string, source: string): Promise<void> {
    const target = resolve(temporary, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, source);
    await chmod(target, 0o755);
  }

  async function holderAt(name: string, branch: string, cwd: string): Promise<string> {
    const holder = join(temporary, name);
    await git(["worktree", "add", "--quiet", holder, branch], cwd);
    return realpathSync(holder);
  }

  async function clone(origin: string, directory: string): Promise<string> {
    const repo = resolve(temporary, directory);
    await git(["clone", "--quiet", origin, repo], temporary);
    return repo;
  }

  async function dispose(): Promise<void> {
    try {
      if (options.assertNoGhCalls)
        expect(await readFile(join(temporary, "gh.log"), "utf8")).toBe("");
    } finally {
      await removeTemporary(temporary);
    }
  }

  return { temporary, env, git, command, run, executable, holderAt, clone, dispose };
}

export async function stackRepo(fixture: StackCase, spec: StackSpec) {
  const origin = join(fixture.temporary, `${spec.name}.git`);
  const repo = join(fixture.temporary, spec.directory ?? spec.name);
  await mkdir(dirname(repo), { recursive: true });
  if (spec.remote !== false)
    await fixture.git(["init", "--quiet", "--bare", "-b", "main", origin], fixture.temporary);

  if (spec.mode === "init") {
    await fixture.git(["init", "--quiet", "-b", "main", repo], fixture.temporary);
    if (spec.remote !== false) await fixture.git(["remote", "add", "origin", origin], repo);
  } else await fixture.clone(origin, spec.directory ?? spec.name);

  await fixture.git(["config", "commit.gpgsign", "false"], repo);
  await fixture.git(["config", "core.hooksPath", join(repo, ".git/hooks")], repo);

  const tips: Record<string, string> = {};
  const branches = new Set(["main"]);
  async function commit(
    branch: string,
    message: string,
    files: readonly string[],
    cwd = repo,
  ): Promise<string> {
    if (files.length) await fixture.git(["add", "--", ...files], cwd);
    await fixture.git(["commit", "--quiet", "--allow-empty", "-m", message], cwd);
    if ((spec.publish ?? "push") === "push")
      await fixture.git(["push", "--quiet", "origin", branch], cwd);

    return fixture.git(["rev-parse", branch], cwd);
  }

  async function branch(name: string, ref: string, base?: string): Promise<void> {
    await fixture.git(["branch", name, ref], repo);
    if (base) await fixture.git(["config", baseKey(name), base], repo);
    branches.add(name);
    tips[name] = await fixture.git(["rev-parse", name], repo);
  }

  async function extend(commits: readonly StackCommit[], checkout: string): Promise<void> {
    for (const entry of commits) {
      if (branches.has(entry.branch)) {
        if (tips[entry.branch]) await fixture.git(["checkout", "--quiet", entry.branch], repo);
      } else {
        await fixture.git(
          ["checkout", "--quiet", "-b", entry.branch, ...(entry.from ? [entry.from] : [])],
          repo,
        );

        branches.add(entry.branch);
      }

      if (entry.base) await fixture.git(["config", baseKey(entry.branch), entry.base], repo);
      for (const [path, content] of Object.entries(entry.files ?? {}))
        await writeFixture(repo, path, content);

      tips[entry.branch] = await commit(
        entry.branch,
        entry.message,
        Object.keys(entry.files ?? {}),
      );
    }

    await fixture.git(["checkout", "--quiet", checkout], repo);

    if (spec.publish === "fetch") {
      await fixture.git(["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"], origin);
      await fixture.git(["fetch", "--quiet", "origin"], repo);
    }
  }

  await extend(spec.commits, spec.checkout);

  const index = spec.index ? indexPath(spec.index.project, fixture.env) : undefined;
  if (index && spec.index) {
    await mkdir(dirname(index), { recursive: true });
    await writeFile(index, spec.index.text);
  }

  return {
    repo,
    origin,
    index,
    tips,
    commit,
    extend,
    branch,
    git: (args: readonly string[], cwd = repo) => fixture.git(args, cwd),
    command: (argv: readonly string[], cwd = repo) => fixture.command(argv, cwd),
    run: (verb: StackVerb, args: readonly string[], cwd = repo) => fixture.run(verb, args, cwd),
    holderAt: (name: string, branch: string) => fixture.holderAt(name, branch, repo),
  };
}

export async function faultGit(fixture: StackCase): Promise<void> {
  const realGit = Bun.which("git", { PATH: fixture.env.PATH });
  if (!realGit) throw new Error("fixture git not found");

  await fixture.executable(
    "fault-bin/git",
    `#!/bin/sh
command="$*"
if [ -n "$FAULT_TRACE" ]; then printf '%s\\n' "$command" >> "$FAULT_TRACE"; fi
set -f
IFS='
'
for pattern in $FAULT_AFTER; do
  case "$command" in
    $pattern)
      "${realGit}" "$@" || exit
      printf 'fatal: fault shim after the write\\n' >&2
      exit 128
      ;;
  esac
done
for pattern in $FAULT_PATTERN; do
  case "$command" in
    $pattern)
      printf 'fatal: fault shim\\n' >&2
      if [ "$FAULT_SIGNAL" = 1 ]; then kill -TERM "$$"; fi
      exit 128
      ;;
  esac
done
exec "${realGit}" "$@"
`,
  );

  fixture.env.PATH = `${join(fixture.temporary, "fault-bin")}:${fixture.env.PATH}`;
}
