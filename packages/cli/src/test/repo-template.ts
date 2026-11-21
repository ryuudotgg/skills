import { existsSync, realpathSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export type RepoLayout = { repo: string; origin: string };
export type TemplateShape = readonly [name: string, ...rest: unknown[]];
export type TemplateGit = (args: readonly string[], cwd: string) => Promise<unknown>;

export function gitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("GIT_")));
}

const templates = new Map<string, Promise<RepoLayout>>();
export function repoTemplate<Layout extends RepoLayout>(
  env: NodeJS.ProcessEnv,
  shape: TemplateShape,
  build: (root: string) => Promise<Layout>,
): Promise<Layout> {
  const key = JSON.stringify([Object.entries(gitVariables(env)), shape]);
  const known = templates.get(key);
  if (known) return known as Promise<Layout>;

  const built = templateRoot().then(build);
  templates.set(key, built);
  built.catch(() => {
    if (templates.get(key) === built) templates.delete(key);
  });

  return built;
}

async function templateRoot(): Promise<string> {
  const parent = process.env.PLANS_SCRATCH ?? tmpdir();
  return realpathSync(await mkdtemp(join(parent, "skills-repo-template-")));
}

export async function copyTemplate(
  template: RepoLayout,
  copy: RepoLayout,
  git: TemplateGit,
  hooks: "pinned" | "default",
): Promise<void> {
  await mkdir(dirname(copy.repo), { recursive: true });
  await cp(template.repo, copy.repo, { recursive: true });

  if (existsSync(template.origin)) {
    await cp(template.origin, copy.origin, { recursive: true });
    await git(["config", "remote.origin.url", copy.origin], copy.repo);
  }

  if (hooks === "pinned")
    await git(["config", "core.hooksPath", join(copy.repo, ".git/hooks")], copy.repo);

  const config = await readFile(join(copy.repo, ".git/config"), "utf8");
  if (config.includes(dirname(template.repo)))
    throw new Error(`${copy.repo} still points at its template: ${config}`);
}
