import { Glob } from "bun";
import { join, relative } from "node:path";
import type { Suite } from "../registry.ts";
import { affectedTests, type Change } from "./affected.ts";
import { gitPaths, mergeBase } from "./git.ts";

const allWatch = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "packages/*/package.json",
  "skills/playbook/bin/skills",
];

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

function selectsAll(path: string): boolean {
  return !isMarkdown(path) && allWatch.some((pattern) => new Glob(pattern).match(path));
}

function watches(suite: Suite, path: string): boolean {
  return [...suite.watch, ...suite.files].some(
    (pattern) => isMarkdown(path) === isMarkdown(pattern) && new Glob(pattern).match(path),
  );
}

export function selectPaths(suites: readonly Suite[], paths: readonly string[]): Suite[] {
  if (paths.some(selectsAll)) return [...suites];

  return suites.filter(
    (suite) =>
      (paths.length > 0 && suite.name === "check") || paths.some((path) => watches(suite, path)),
  );
}

async function narrowed(repo: string, suite: Suite, changes: readonly Change[]): Promise<Suite> {
  if (changes.some(({ path }) => selectsAll(path))) return suite;

  const files = await affectedTests(repo, suite, changes);
  if (!files) return suite;

  const cwd = join(repo, suite.cwd ?? "");
  const paths = files.map((file) => `./${relative(cwd, join(repo, file))}`);
  return { ...suite, argv: [...suite.argv, ...paths] };
}

export async function selectSuites(
  repo: string,
  suites: readonly Suite[],
  stderr: (text: string) => void = (text) => process.stderr.write(text),
): Promise<Suite[]> {
  const base = await mergeBase(repo, undefined, stderr);
  if (base === null) {
    stderr("test: no resolved base or merge base; selecting every suite\n");
    return [...suites];
  }

  const diff = await gitPaths(repo, ["diff", "--no-renames", "--name-status", "-z", base, "--"]);
  const untracked = await gitPaths(repo, ["ls-files", "-z", "--others", "--exclude-standard"]);
  const changes = [
    ...diff.flatMap((status, index) =>
      index % 2 === 0 ? [{ path: diff[index + 1]!, deleted: status === "D" }] : [],
    ),
    ...untracked.map((path) => ({ path, deleted: false })),
  ];

  const selected = selectPaths(
    suites,
    changes.map(({ path }) => path),
  );

  return Promise.all(selected.map((suite) => narrowed(repo, suite, changes)));
}
