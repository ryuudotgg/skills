import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAME = "eval";

const EMAIL = "eval@example.com";

// A case can ship a plan pack built against its baseline, so the commit's sha must not depend on when or where it ran.
const STAMP = "2026-01-01T00:00:00Z";

async function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const child = Bun.spawn([...argv], { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (code !== 0) throw new Error(`${argv.join(" ")}: ${stderr.trim() || `exit status ${code}`}`);
  return stdout;
}

export async function commitBaseline(
  fixture: string,
  repo: string,
  hooks: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  mkdirSync(repo, { recursive: true });

  if (existsSync(fixture)) await run(["cp", "-R", `${fixture}/.`, `${repo}/`], repo, env);

  const pinned = {
    ...env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: NAME,
    GIT_AUTHOR_EMAIL: EMAIL,
    GIT_AUTHOR_DATE: STAMP,
    GIT_COMMITTER_NAME: NAME,
    GIT_COMMITTER_EMAIL: EMAIL,
    GIT_COMMITTER_DATE: STAMP,
  };

  await run(["git", "-C", repo, "init", "-q", "-b", "main"], repo, pinned);

  for (const [key, value] of [
    ["user.name", NAME],
    ["user.email", EMAIL],
    ["commit.gpgsign", "false"],
    ["tag.gpgsign", "false"],
    ["core.hooksPath", hooks],
  ] as const)
    await run(["git", "-C", repo, "config", key, value], repo, pinned);

  writeFileSync(join(repo, ".git/info/exclude"), ".claude/\n");
  await run(["git", "-C", repo, "add", "-A"], repo, pinned);
  await run(
    ["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "chore: eval baseline"],
    repo,
    pinned,
  );

  return (await run(["git", "-C", repo, "rev-parse", "HEAD"], repo, pinned)).trim();
}
