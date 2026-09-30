import { Glob } from "bun";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import type { Suite } from "../registry.ts";
import { gitPaths } from "./git.ts";

function matches(pattern: string, path: string): boolean {
  return new Glob(pattern).match(path);
}

function isTest(path: string): boolean {
  const name = basename(path);

  return (
    path === "scripts/validate.py" ||
    (name.startsWith("test-") && name.endsWith(".sh")) ||
    (name.startsWith("test_") && name.endsWith(".py")) ||
    name.endsWith(".test.ts")
  );
}

export async function checkManifest(repo: string, suites: readonly Suite[]): Promise<string[]> {
  const listed = await gitPaths(repo, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ]);
  const files = [...new Set(listed)].filter(
    (path) => !path.split("/").includes("node_modules") && existsSync(join(repo, path)),
  );
  const problems: string[] = [];

  for (const path of files.filter(isTest)) {
    const owners = suites.filter((suite) => suite.files.some((pattern) => matches(pattern, path)));
    if (owners.length === 0) {
      problems.push(`unlisted test file: ${path}`);
    } else if (owners.length > 1) {
      problems.push(`test file owned twice: ${path}`);
    }
  }

  for (const suite of suites) {
    for (const pattern of suite.files) {
      const present = /[*?[{]/.test(pattern)
        ? files.some((path) => matches(pattern, path))
        : existsSync(join(repo, pattern));
      if (!present) {
        problems.push(`missing test file: ${pattern}`);
      }
    }
  }

  return problems;
}
