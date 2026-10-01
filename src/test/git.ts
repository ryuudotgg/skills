import { runCommand, suiteEnvironment, type CommandResult } from "./process.ts";

export async function gitRead(
  repo: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<CommandResult> {
  const result = await runCommand(["git", ...args], {
    cwd: repo,
    env: suiteEnvironment(),
    timeout: 30_000,
    signal,
  });

  if (result.timedOut)
    throw new Error(`git ${args[0]}: timed out`);

  return result;
}

export async function gitPaths(repo: string, args: readonly string[]): Promise<string[]> {
  const result = await gitRead(repo, args);
  if (result.code !== 0)
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  return result.stdout.split("\0").filter(Boolean);
}

export async function mergeBase(
  repo: string,
  signal?: AbortSignal,
  stderr: (text: string) => void = (text) => process.stderr.write(text),
): Promise<string | null> {
  const branch = await gitRead(repo, ["rev-parse", "--abbrev-ref", "HEAD"], signal);
  const configured = await gitRead(
    repo,
    ["config", "--get", `branch.${branch.stdout.trim()}.skills-base`],
    signal,
  );

  const refs = configured.code === 0 ? [configured.stdout.trim(), "origin/main"] : ["origin/main"];
  for (const ref of refs) {
    const resolved = await gitRead(
      repo,
      ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
      signal,
    );

    if (resolved.code !== 0) {
      if (configured.code === 0 && ref === configured.stdout.trim())
        stderr(`test: skills-base ${ref} does not resolve, using origin/main\n`);
      continue;
    }

    const base = await gitRead(repo, ["merge-base", resolved.stdout.trim(), "HEAD"], signal);
    if (base.code === 0)
      return base.stdout.trim();

    return null;
  }

  return null;
}
