import { gitOutput } from "../project.ts";
import { processIo, type Io } from "../io.ts";
import { git } from "../publish/commit.ts";

export async function recordedBase(cwd: string, branch: string, io: Io = processIo()): Promise<string | undefined> {
  const output = await gitOutput(cwd, ["config", "--get", `branch.${branch}.skills-base`], {}, io);
  return output?.trim() || undefined;
}

export async function recordBase(cwd: string, branch: string, base: string, io: Io = processIo()): Promise<boolean> {
  const result = await git(cwd, ["config", `branch.${branch}.skills-base`, base], { capture: true, write: true }, io);
  return result.code === 0;
}

export async function chain(cwd: string, branch: string, io: Io = processIo()): Promise<string[]> {
  const stack = [branch];
  for (let current = branch; ; ) {
    const base = await recordedBase(cwd, current, io);
    if (!base || base.startsWith("origin/") || stack.includes(base)) return stack;

    stack.unshift(base);
    current = base;
  }
}
