import { expect } from "bun:test";
import { chmod, cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../io.ts";
import { indexPath } from "../plans/index-tsv.ts";
import { baseKey } from "../stack/skills-base.ts";
import { writeFixture } from "./fixtures.ts";
import { settleViews, type Views } from "./plans-views.ts";
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

export async function stackCase(
  prefix: string,
  options: { assertNoGhCalls?: boolean; parent?: string; views?: Views } = {},
) {
  const views = options.views ?? "kept";
  const temporary = realpathSync(await mkdtemp(join(options.parent ?? tmpdir(), prefix)));
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
    PATH: `${resolve(import.meta.dir, "../../../../scripts/stubs")}:${process.env.PATH ?? ""}`,
  };

  delete env.SKILLS_OWN_ROWS;
  delete env.XDG_CONFIG_HOME;

  let realGit: string;
  try {
    const found = Bun.which("git", { PATH: env.PATH });
    if (!found) throw new Error("fixture git not found");

    realGit = found;
    for (const path of ["home", "plans", "gh"]) await mkdir(join(temporary, path));
    await writeFile(env.SKILLS_CONF!, "DELIVERY=prs\n");
    await writeFile(join(temporary, "gh.log"), "");
  } catch (error) {
    await removeTemporary(temporary);
    throw error;
  }

  async function command(argv: readonly string[], cwd: string): Promise<CommandResult> {
    if (views === "deleted" && argv[0]?.endsWith("/bin/skills")) await settleViews(env);

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
    if (views === "deleted") await settleViews(env);

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

  return {
    temporary,
    env,
    views,
    realGit,
    git,
    command,
    run,
    executable,
    holderAt,
    clone,
    dispose,
  };
}

export function threeLayerStack(name: string): StackSpec {
  return {
    name,
    directory: "Proj",
    commits: [
      { branch: "main", message: "chore: initial", files: { round: "base\n" } },
      { branch: "feat/a", base: "origin/main", message: "feat: a", files: { a: "a\n" } },
      { branch: "feat/b", base: "feat/a", message: "feat: b", files: { b: "b\n" } },
      { branch: "feat/c", base: "feat/b", message: "feat: c", files: { c: "c\n" } },
    ],
    checkout: "feat/a",
    index: {
      project: "Proj",
      text: "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\t-\t-\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\t-\t-\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\t-\t-\n",
    },
  };
}

export function roundStack(name: string): StackSpec {
  return {
    name,
    directory: join(name, "Proj"),
    commits: [
      { branch: "main", message: "chore: initial", files: { shared: "base\n", round: "a\n" } },
      { branch: "feat/a", base: "origin/main", message: "feat: a", files: { a: "a1\n" } },
      { branch: "feat/b", base: "feat/a", message: "feat: b", files: { b: "b1\n" } },
      { branch: "feat/c", base: "feat/b", message: "feat: c", files: { c: "c1\n" } },
    ],
    checkout: "feat/a",
    index: {
      project: "Proj",
      text: "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n1\t-\t-\t-\t-\t-\t-\tfeat/a\t-\t-\n2\t-\t-\t-\t-\t-\t-\tfeat/b\t-\t-\n3\t-\t-\t-\t-\t-\t-\tfeat/c\t-\t-\n",
    },
  };
}

type StackLayout = {
  repo: string;
  origin: string;
  tips: Record<string, string>;
  branches: Set<string>;
};

function stackSteps(fixture: StackCase, spec: StackSpec, layout: StackLayout) {
  const { repo, tips, branches } = layout;
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
      await fixture.git(["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"], layout.origin);
      await fixture.git(["fetch", "--quiet", "origin"], repo);
    }
  }

  return { commit, branch, extend };
}

const templates = new Map<string, Promise<StackLayout>>();
function stackTemplate(fixture: StackCase, spec: StackSpec): Promise<StackLayout> {
  const gitEnv = Object.entries(fixture.env).filter(([name]) => name.startsWith("GIT_"));
  const key = JSON.stringify([
    gitEnv,
    spec.mode,
    spec.remote,
    spec.publish,
    spec.commits,
    spec.checkout,
  ]);

  const built = templates.get(key) ?? buildTemplate(Object.fromEntries(gitEnv), spec);
  templates.set(key, built);
  return built;
}

async function buildTemplate(gitEnv: NodeJS.ProcessEnv, spec: StackSpec): Promise<StackLayout> {
  const fixture = await stackCase("skills-stack-template-", {
    parent: process.env.PLANS_SCRATCH,
  });

  Object.assign(fixture.env, gitEnv);

  const root = fixture.temporary;
  const layout: StackLayout = {
    repo: join(root, "repo"),
    origin: join(root, "origin.git"),
    tips: {},
    branches: new Set(["main"]),
  };

  if (spec.remote !== false)
    await fixture.git(["init", "--quiet", "--bare", "-b", "main", layout.origin], root);

  if (spec.mode === "init") {
    await fixture.git(["init", "--quiet", "-b", "main", layout.repo], root);

    if (spec.remote !== false)
      await fixture.git(["remote", "add", "origin", layout.origin], layout.repo);
  } else await fixture.git(["clone", "--quiet", layout.origin, layout.repo], root);

  await fixture.git(["config", "commit.gpgsign", "false"], layout.repo);
  await stackSteps(fixture, spec, layout).extend(spec.commits, spec.checkout);
  return layout;
}

export async function stackRepo(fixture: StackCase, spec: StackSpec) {
  const template = await stackTemplate(fixture, spec);
  const layout: StackLayout = {
    repo: join(fixture.temporary, spec.directory ?? spec.name),
    origin: join(fixture.temporary, `${spec.name}.git`),
    tips: { ...template.tips },
    branches: new Set(template.branches),
  };

  const { repo, origin, tips } = layout;
  await mkdir(dirname(repo), { recursive: true });

  if (spec.remote !== false) {
    await cp(template.origin, origin, { recursive: true });
    await cp(template.repo, repo, { recursive: true });
    await fixture.git(["config", "remote.origin.url", origin], repo);
  } else await cp(template.repo, repo, { recursive: true });

  await fixture.git(["config", "core.hooksPath", join(repo, ".git/hooks")], repo);

  const index = spec.index ? indexPath(spec.index.project, fixture.env) : undefined;
  if (index && spec.index) {
    await mkdir(dirname(index), { recursive: true });
    await writeFile(index, spec.index.text);
  }

  const { commit, branch, extend } = stackSteps(fixture, spec, layout);
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

const headRefs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];

export function snapshots(fixture: StackCase, at: { repo: string; origin: string }) {
  async function branches(): Promise<{
    local: string;
    remote: string;
    tree: string;
    branch: string;
  }> {
    return {
      local: await fixture.git(headRefs, at.repo),
      remote: await fixture.git([`--git-dir=${at.origin}`, ...headRefs], at.repo),
      tree: await fixture.git(["status", "--porcelain"], at.repo),
      branch: await fixture.git(["branch", "--show-current"], at.repo),
    };
  }

  async function tip(branch: string, local: string, remote = local): Promise<void> {
    expect(await fixture.git(["rev-parse", branch], at.repo)).toBe(local);
    expect(await fixture.git([`--git-dir=${at.origin}`, "rev-parse", branch], at.repo)).toBe(
      remote,
    );
  }

  async function holderState(holder: string): Promise<{ head: string; tree: string }> {
    return {
      head: await fixture.git(["rev-parse", "HEAD"], holder),
      tree: await fixture.git(["status", "--porcelain"], holder),
    };
  }

  return { branches, tip, holderState };
}

export async function gitShim(fixture: StackCase, cases: string): Promise<void> {
  await fixture.executable(
    "shim-bin/git",
    `#!/bin/sh\ncase "$*" in\n${cases}\nesac\nexec "${fixture.realGit}" "$@"\n`,
  );

  fixture.env.PATH = `${join(fixture.temporary, "shim-bin")}:${fixture.env.PATH}`;
}

export function oldReplayGit(fixture: StackCase): Promise<void> {
  return gitShim(
    fixture,
    `  "replay -h")
    echo 'usage: git replay --onto <revision> <range>'
    exit 129
    ;;`,
  );
}

export async function faultGit(fixture: StackCase): Promise<void> {
  const { realGit } = fixture;
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
