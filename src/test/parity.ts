import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { Context, Port } from "../registry.ts";
import { mergeBase } from "./git.ts";
import { shellQuote } from "../shell.ts";
import {
  removeTemporary,
  runCommand,
  startCommand,
  suiteEnvironment,
  withInterrupts,
} from "./process.ts";
import { runSuites, type RunnerOptions } from "./runner.ts";

export type Stub = { legacy: string; command: string };
export type ParityTree = { base: string; tree: string };
export type ParityOptions = RunnerOptions & {
  stubs?: (paths: ParityTree) => readonly Stub[];
};

function registryStubs(bin: string, ports: readonly Port[]): Stub[] {
  return ports.map((port) => ({
    legacy: port.legacy,
    command: `${shellQuote(bin)} '--root' "$root" ${port.verb.map(shellQuote).join(" ")}`,
  }));
}

function treePath(tree: string, path: string): string {
  const target = resolve(tree, path);
  const local = relative(tree, target);
  if (isAbsolute(path) || local === ".." || local.startsWith("../") || local === "")
    throw new Error(`parity: not a repo relative file: ${path}`);

  return target;
}

async function extract(repo: string, sha: string, destination: string, signal: AbortSignal) {
  await mkdir(destination);

  const archive = startCommand(["git", "archive", "--format=tar", sha], {
    cwd: repo,
    captureStdout: false,
    timeout: 30_000,
    signal,
  });

  const tar = startCommand(["tar", "-x", "-f", "-", "-C", destination], {
    cwd: repo,
    input: true,
    timeout: 30_000,
    signal,
  });

  if (!archive.child.stdout || !tar.child.stdin)
    throw new Error("parity: archive pipe unavailable");

  tar.child.stdin.on("error", () => {});
  archive.child.stdout.pipe(tar.child.stdin);

  const results = await Promise.all([archive.result, tar.result]);
  for (const [index, result] of results.entries())
    if (result.code !== 0 || result.timedOut)
      throw new Error(
        `parity: ${index === 0 ? "git archive" : "tar"} failed: ${result.timedOut ? "timed out: " : ""}${result.stderr.trim()}`,
      );
}

async function initializeTree(tree: string, signal: AbortSignal): Promise<void> {
  const env = {
    ...suiteEnvironment(),
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "skills parity",
    GIT_AUTHOR_EMAIL: "parity@example.com",
    GIT_COMMITTER_NAME: "skills parity",
    GIT_COMMITTER_EMAIL: "parity@example.com",
  };

  const commands = [
    ["git", "init", "-q", "-b", "main"],
    ["git", "add", "-A"],
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "parity base"],
  ];

  for (const argv of commands) {
    const result = await runCommand(argv, { cwd: tree, env, signal });
    if (result.code !== 0 || result.timedOut)
      throw new Error(`parity: git setup failed: ${result.stderr.trim()}`);
  }
}

function stubPath(tree: string, legacy: string): string {
  const target = treePath(tree, legacy);

  let current = tree;
  for (const component of ["", ...relative(tree, target).split("/")]) {
    current = join(current, component);
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`parity: symlinked path: ${legacy}`);
  }

  return target;
}

async function writeStub(paths: ParityTree, stub: Stub): Promise<void> {
  const original = stubPath(paths.base, stub.legacy);
  const target = stubPath(paths.tree, stub.legacy);

  if (!existsSync(original))
    throw new Error(`parity: missing legacy file at base: ${stub.legacy}`);

  const source = await readFile(original, "utf8");
  if (!source.startsWith("#!"))
    throw new Error(`parity: legacy file has no shebang: ${stub.legacy}`);

  const command = stub.command.replaceAll("<base>", shellQuote(resolve(paths.base)));
  const directories = stub.legacy.split("/").slice(0, -1);
  const withinSkills = directories[0] === "skills";
  const rootPath = [...Array<string>(directories.length - (withinSkills ? 1 : 0)).fill(".."), ...(withinSkills ? [] : ["skills"])].join("/") || ".";
  const body = `directory=$(CDPATH= cd -P "$(dirname "$0")" && pwd -P)\nroot=$(CDPATH= cd "$directory/${rootPath}" && pwd -P)\nexec ${command} "$@"\n`;
  const sourceStub = stub.legacy.endsWith(".py")
    ? `#!/usr/bin/env python3\nimport os\nimport sys\nos.execvp("sh", ["sh", "-c", ${JSON.stringify(body)}, __file__, *sys.argv[1:]])\n`
    : `#!/bin/sh\n${body}`;

  await writeFile(
    target,
    sourceStub,
  );

  await chmod(target, 0o755);
}

async function suiteArgv(tree: string, suite: string): Promise<string[]> {
  const path = treePath(tree, suite);
  if (!existsSync(path))
    throw new Error(`parity: missing suite at base: ${suite}`);

  const source = await readFile(path, "utf8");
  if (suite.endsWith(".sh"))
    return [source.split("\n", 1)[0]?.trim() === "#!/bin/bash" ? "bash" : "sh", suite];

  if (suite.endsWith(".py"))
    return ["python3", "-B", suite];

  throw new Error(`parity: unsupported suite: ${suite}`);
}

export async function runParity(
  ctx: Context,
  suite: string,
  options: ParityOptions = {},
): Promise<number> {
  return withInterrupts(async (signal) => {
    const sha = await mergeBase(ctx.repo, signal, options.stderr);
    if (sha === null)
      throw new Error("parity: no resolved base or merge base");

    const temporary = await mkdtemp(join(tmpdir(), "skills-parity-"));
    const paths = { base: join(temporary, "base"), tree: join(temporary, "tree") };
    try {
      await extract(ctx.repo, sha, paths.base, signal);
      await extract(ctx.repo, sha, paths.tree, signal);
      await initializeTree(paths.tree, signal);

      const ported = ctx.ports.filter((port) => existsSync(treePath(paths.base, port.legacy)));
      const stubs = [...registryStubs(ctx.bin, ported), ...(options.stubs?.(paths) ?? [])];
      if (stubs.length === 0)
        throw new Error("parity: nothing to stub");

      const argv = await suiteArgv(paths.tree, suite);

      for (const stub of stubs)
        await writeStub(paths, stub);

      return await runSuites(
        paths.tree,
        [
          {
            name: basename(suite).replace(/\.(sh|py)$/, ""),
            argv,
            files: [suite],
            watch: [],
            seconds: 0,
          },
        ],
        { ...options, signal },
      );
    } finally {
      await removeTemporary(temporary);
    }
  });
}
