import type { Fixes, ReadRunner } from "./types.ts";

async function required(git: ReadRunner, args: readonly string[], reason: string): Promise<string> {
  const result = await git(args, 10_000);
  if (result.code !== 0) throw new Error(`fix-facts: ${reason}`);
  return result.stdout.trimEnd();
}

export async function branchTip(branch: string, git: ReadRunner): Promise<string> {
  return required(
    git,
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    "branch is not a local branch",
  );
}

export async function readFixes(reviewed: string, branch: string, git: ReadRunner): Promise<Fixes> {
  await required(
    git,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    "branch is not a local branch",
  );

  const tip = await required(
    git,
    ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
    "cannot resolve branch tip",
  );

  await required(git, ["cat-file", "-e", `${reviewed}^{commit}`], "reviewed is not a commit");

  const origin = await git(["rev-parse", "--verify", "origin/HEAD^{commit}"], 10_000);
  const originHead = origin.code === 0 ? origin.stdout.trim() : "";
  const configured = await git(["config", `branch.${branch}.skills-base`], 10_000);
  const resolved =
    configured.code === 0
      ? await git(["rev-parse", "--verify", `${configured.stdout.trimEnd()}^{commit}`], 10_000)
      : null;

  let base: string;
  if (resolved?.code === 0) base = resolved.stdout.trim();
  else {
    if (!originHead) throw new Error("fix-facts: cannot resolve origin/HEAD");
    base = await required(git, ["merge-base", tip, originHead], "cannot resolve base");
  }

  const range = [`${reviewed}...${tip}`, `^${base}`, ...(originHead ? [`^${originHead}`] : [])];
  const options = ["--cherry-pick", "--right-only", "--no-merges", ...range];
  const commits = await required(git, ["rev-list", ...options], "cannot read commits");
  const reviewedSha = await required(
    git,
    ["rev-parse", `${reviewed}^{commit}`],
    "reviewed is not a commit",
  );

  const stats = await required(
    git,
    ["log", "--numstat", "-z", "--format=", ...options],
    "cannot read commit changes",
  );

  const paths = await required(
    git,
    ["log", "--diff-filter=A", "--name-only", "-z", "--format=", ...options],
    "cannot read commit changes",
  );

  let lines = 0;
  const rows = stats.split("\0");
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]!.replace(/^\n+/, "");
    if (!row) continue;

    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(row);
    if (!match) throw new Error("fix-facts: cannot read commit changes");

    lines += match[1] === "-" || match[2] === "-" ? 30 : Number(match[1]) + Number(match[2]);
    if (match[3] === "") index += 2;
  }

  const added = new Set(
    paths
      .split("\0")
      .map((path) => path.replace(/^\n+/, ""))
      .filter(Boolean),
  );

  return {
    commits: commits ? commits.split("\n").length : 0,
    lines,
    added: added.size,
    moved: tip !== reviewedSha,
  };
}
