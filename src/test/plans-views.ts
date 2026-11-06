import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { importRoot, Refusal } from "../plans/import.ts";
import { indexIn, plansDir } from "../plans/index-tsv.ts";
import { trailIn } from "../plans/trail.ts";

export const viewsDeleted = process.env.SKILLS_TEST_VIEWS === "deleted";

function isDirectory(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

async function takeIn(root: string): Promise<boolean> {
  try {
    await importRoot(root);
    return true;
  } catch (error) {
    if (error instanceof Refusal) return false;
    throw error;
  }
}

export async function settleViews(env: NodeJS.ProcessEnv): Promise<void> {
  const root = plansDir(env);
  if (!viewsDeleted || !isDirectory(root) || !(await takeIn(root))) return;

  rmSync(trailIn(root), { force: true });

  for (const name of readdirSync(root))
    if (isDirectory(join(root, name))) rmSync(indexIn(join(root, name)), { force: true });
}

export async function editView(
  env: NodeJS.ProcessEnv,
  path: string,
  edit: (text: string) => string,
): Promise<void> {
  const root = plansDir(env);
  const stored = existsSync(join(root, "plans.db"));
  if (stored) await importRoot(root);

  const text = existsSync(path) ? await readFile(path, "utf8") : "";
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, edit(text));

  if (stored) await importRoot(root);
}
