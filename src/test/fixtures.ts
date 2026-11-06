import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { importRoot, Refusal } from "../plans/import.ts";
import type { IndexRow } from "../plans/index-tsv.ts";
import { readProject } from "../plans/projection.ts";
import type { Suite } from "../registry.ts";
import { viewsDeleted } from "./plans-views.ts";
import { runCommand, suiteEnvironment } from "./process.ts";

function plansRoot(target: string): string | undefined {
  if (basename(target) === "log.tsv") return dirname(target);
  if (basename(target) === "index.tsv") return dirname(dirname(target));
  return undefined;
}

async function importOrRefuse(root: string): Promise<boolean> {
  try {
    await importRoot(root);
    return true;
  } catch (error) {
    if (error instanceof Refusal) return false;
    throw error;
  }
}

async function editPlans(root: string, edit: () => Promise<void>, rebuild: boolean): Promise<void> {
  if (existsSync(join(root, "plans.db"))) await importOrRefuse(root);

  await edit();

  if (rebuild)
    for (const suffix of ["", "-wal", "-shm"])
      await rm(join(root, `plans.db${suffix}`), { force: true });

  if (!(await importOrRefuse(root))) return;
  if (!viewsDeleted) return;

  await rm(join(root, "log.tsv"), { force: true });

  for (const entry of await readdir(root, { withFileTypes: true }))
    if (entry.isDirectory()) await rm(join(root, entry.name, "index.tsv"), { force: true });
}

async function write(target: string, content: string | Uint8Array): Promise<void> {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

export async function writeFixture(
  repo: string,
  path: string,
  content: string | Uint8Array = "",
): Promise<void> {
  const target = join(repo, path);
  const root = plansRoot(target);
  if (root) await editPlans(root, () => write(target, content), true);
  else await write(target, content);
}

export async function storedRows(index: string): Promise<IndexRow[]> {
  const read = await readProject(basename(dirname(index)), { PLANS_DIR: dirname(dirname(index)) });
  if (read.kind === "failed") throw new Error(read.reason);
  return read.kind === "rows" ? read.rows : [];
}

export async function viewText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function breakStore(root: string): Promise<void> {
  for (const suffix of ["-wal", "-shm"]) await rm(join(root, `plans.db${suffix}`), { force: true });
  await writeFile(join(root, "plans.db"), "not a database\n".repeat(512));
}

export async function appendFixture(repo: string, path: string, content: string): Promise<void> {
  const target = join(repo, path);
  const root = plansRoot(target);
  if (!root) throw new Error(`${path} is not a plans view`);

  await editPlans(root, () => appendFile(target, content), false);
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

  if (result.code !== 0 || result.timedOut) throw new Error(result.stderr || "fixture git failed");

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
