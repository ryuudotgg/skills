import { Glob } from "bun";
import type { Suite } from "../registry.ts";
import { gitPaths, mergeBase } from "./git.ts";

const allWatch = [
  "package.json",
  "bun.lock",
  "bunfig.toml",
  "tsconfig.json",
  "skills/playbook/bin/skills",
];

function isMarkdown(path: string): boolean {
  return path.endsWith(".md") || path.endsWith(".mdx");
}

export function selectPaths(suites: readonly Suite[], paths: readonly string[]): Suite[] {
  const codePaths = paths.filter((path) => !isMarkdown(path));
  if (codePaths.some((path) => allWatch.some((pattern) => new Glob(pattern).match(path))))
    return [...suites];

  return suites.filter(
    (suite) =>
      (paths.length > 0 && suite.name === "check") ||
      paths.some((path) =>
        [...suite.watch, ...suite.files].some(
          (pattern) => isMarkdown(path) === isMarkdown(pattern) && new Glob(pattern).match(path),
        ),
      ),
  );
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

  const changed = await gitPaths(repo, ["diff", "--no-renames", "--name-only", "-z", base, "--"]);
  const untracked = await gitPaths(repo, ["ls-files", "-z", "--others", "--exclude-standard"]);
  return selectPaths(suites, [...changed, ...untracked]);
}
