import { join } from "node:path";
import { commitFixture, fixtureGit, fixtureGitEnv, writeFixture } from "./fixtures.ts";
import { copyTemplate, repoTemplate, type RepoLayout } from "./repo-template.ts";

function git(args: readonly string[], cwd: string): Promise<string> {
  return fixtureGit(cwd, args);
}

async function buildPublishRepo(root: string, branch: string): Promise<RepoLayout> {
  const repo = join(root, "repo");
  const origin = join(root, "origin.git");

  await fixtureGit(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(root, ["init", "--quiet", "-b", "main", repo]);
  await fixtureGit(repo, ["config", "commit.gpgsign", "false"]);
  await fixtureGit(repo, ["remote", "add", "origin", origin]);

  await writeFixture(repo, "a", "a\n");
  await writeFixture(repo, "unrelated", "unrelated\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["push", "--quiet", "origin", "main"]);
  await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/parent"]);
  await fixtureGit(repo, ["config", "branch.feat/parent.skills-base", "origin/main"]);

  await writeFixture(repo, "parent", "parent\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "--quiet", "-b", branch]);
  await fixtureGit(repo, ["config", `branch.${branch}.skills-base`, "feat/parent"]);

  return { repo, origin };
}

export async function publishRepo(copy: RepoLayout, branch: string): Promise<void> {
  const template = await repoTemplate(fixtureGitEnv(), ["publish", branch], (root) =>
    buildPublishRepo(root, branch),
  );

  await copyTemplate(template, copy, git, "pinned");
}

async function buildStartCloseRepo(root: string): Promise<RepoLayout> {
  const repo = join(root, "fixture");
  const origin = join(root, "origin.git");

  await fixtureGit(root, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(root, ["init", "--quiet", "-b", "main", repo]);
  await fixtureGit(repo, ["remote", "add", "origin", origin]);

  await writeFixture(repo, "base", "base\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/a"]);
  await fixtureGit(repo, ["config", "branch.feat/a.skills-base", "origin/main"]);
  await writeFixture(repo, "a", "a\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "--quiet", "main"]);
  await fixtureGit(origin, ["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"]);
  await fixtureGit(repo, ["fetch", "--quiet", "origin"]);

  return { repo, origin };
}

export async function startCloseRepo(copy: RepoLayout): Promise<void> {
  const template = await repoTemplate(fixtureGitEnv(), ["start-close"], buildStartCloseRepo);
  await copyTemplate(template, copy, git, "default");
}
