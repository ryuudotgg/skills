import { realpathSync } from "node:fs";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { commitFixture, fixtureGit, writeFixture } from "./fixtures.ts";
import { suiteEnvironment } from "./process.ts";

export const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";

export type ArtifactTree = {
  directory: string;
  repo: string;
  checkout: string;
  plans: string;
  stub: string;
  avd: string;
  env: NodeJS.ProcessEnv;
};

export type TreeOptions = {
  prefix: string;
  stubs: Readonly<Record<string, string>>;
  temporary: string[];
  omit?: readonly string[];
  env?: (directory: string) => NodeJS.ProcessEnv;
};

export function row(id: string, status: string, branch: string): string {
  return [id, `p${id}`, status, "P1", "S", "-", "-", branch, "2026-10-01", "-"].join("\t");
}

export async function state(tree: { stub: string }, name: string, content: string): Promise<void> {
  await writeFile(join(tree.stub, name), content);
}

export async function stub(tree: { directory: string }, tool: string, body: string): Promise<void> {
  const path = join(tree.directory, "bin", tool);
  await writeFile(path, `#!/bin/sh\necho "${tool} $*" >> "$STUB/calls"\n${body}\n`);
  await chmod(path, 0o755);
}

export async function artifactTree(options: TreeOptions): Promise<ArtifactTree> {
  const directory = realpathSync(await mkdtemp(join(tmpdir(), options.prefix)));
  options.temporary.push(directory);

  const bin = join(directory, "bin");
  const tree: ArtifactTree = {
    directory,
    repo: join(directory, "Skills"),
    checkout: join(directory, "wt-007"),
    plans: join(directory, "plans"),
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
      ...options.env?.(directory),
    },
  };

  await Promise.all([bin, tree.stub, tree.avd].map((path) => mkdir(path)));
  await symlink(Bun.which("git")!, join(bin, "git"));

  for (const [tool, body] of Object.entries(options.stubs))
    if (!options.omit?.includes(tool)) await stub(tree, tool, body);

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", tree.repo]);
  await fixtureGit(tree.repo, ["remote", "add", "origin", origin]);

  await writeFixture(tree.repo, "base", "base\n");
  await commitFixture(tree.repo);
  await fixtureGit(tree.repo, ["push", "--quiet", "origin", "main"]);
  await fixtureGit(tree.repo, ["worktree", "add", "--quiet", "-b", "feat/a", tree.checkout]);

  return tree;
}

export async function capture(
  tree: { env: NodeJS.ProcessEnv },
  cwd: string,
  run: (io: Io) => Promise<number>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: Io = {
    cwd,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const code = await run(io);
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}
