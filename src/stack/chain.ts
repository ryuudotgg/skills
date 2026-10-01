import { gitOutput } from "../project.ts";

export async function recordedBase(cwd: string, branch: string): Promise<string | undefined> {
  const output = await gitOutput(cwd, ["config", "--get", `branch.${branch}.skills-base`]);
  return output?.trim() || undefined;
}

export async function chain(cwd: string, branch: string): Promise<string[]> {
  const stack = [branch];
  for (let current = branch; ; ) {
    const base = await recordedBase(cwd, current);
    if (!base || base.startsWith("origin/") || stack.includes(base)) return stack;

    stack.unshift(base);
    current = base;
  }
}
