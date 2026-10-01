import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Suite } from "../registry.ts";
import { runCommand, suiteEnvironment } from "./process.ts";

export async function writeFixture(repo: string, path: string, content = ""): Promise<void> {
  const target = join(repo, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function fixtureGit(repo: string, args: readonly string[]): Promise<string> {
  const result = await runCommand(["git", ...args], {
    cwd: repo,
    env: {
      ...suiteEnvironment(),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "skills test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "skills test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
    timeout: 30_000,
  });

  if (result.code !== 0 || result.timedOut)
    throw new Error(result.stderr || "fixture git failed");

  return result.stdout;
}

export async function createRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "skills-test-"));
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);

  await writeFixture(repo, ".gitignore", "node_modules/\nignored/\n");
  await commitFixture(repo);

  return repo;
}

export async function commitFixture(repo: string): Promise<void> {
  await fixtureGit(repo, ["add", "-A"]);

  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
}

export function fakeSuite(name: string, fields: Partial<Suite> = {}): Suite {
  return {
    name,
    argv: ["sh", `${name}.sh`],
    files: [`${name}.sh`],
    watch: ["**"],
    seconds: 0,
    ...fields,
  };
}
