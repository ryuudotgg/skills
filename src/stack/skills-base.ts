import { gitRead } from "../project.ts";
import { processIo, type Io } from "../io.ts";
import { git } from "../publish/commit.ts";
import { describe, type Read } from "../read.ts";

export type BaseRead = { ok: true; base: string | undefined } | { ok: false; reason: string };
type BasesRead = { ok: true; bases: ReadonlyMap<string, string> } | { ok: false; reason: string };
type ChainRead = { ok: true; stack: string[] } | { ok: false; reason: string };

export function baseKey(branch: string): string {
  return `branch.${branch}.skills-base`;
}

export function noBase(branch: string): string {
  return `no skills-base for ${branch}`;
}

export function baseUnresolved(ref: string): string {
  return `skills-base ${ref} does not resolve, using origin/main`;
}

export function parseBase(branch: string, code: number, stdout: string): BaseRead {
  if (code === 0) return { ok: true, base: stdout.trim() || undefined };
  if (code === 1) return { ok: true, base: undefined };
  return { ok: false, reason: `cannot read ${baseKey(branch)} (git config exited ${code})` };
}

export function baseFrom(branch: string, result: Read): BaseRead {
  if (!result.ok)
    return { ok: false, reason: `cannot read ${baseKey(branch)} (${describe(result.failure)})` };

  return parseBase(branch, result.code, result.stdout);
}

export async function recordedBase(
  cwd: string,
  branch: string,
  io: Io = processIo(),
): Promise<BaseRead> {
  const result = await gitRead(cwd, ["config", "--get", baseKey(branch)], {}, io);
  return baseFrom(branch, result);
}

export async function recordedBases(cwd: string, io: Io = processIo()): Promise<BasesRead> {
  const suffix = baseKey("").slice("branch.".length);
  const result = await gitRead(
    cwd,
    ["config", "-z", "--get-regexp", `^branch\\..*\\${suffix}$`],
    {},
    io,
  );

  const reason = "cannot read recorded skills-base keys";
  if (!result.ok) return { ok: false, reason: `${reason} (${describe(result.failure)})` };
  if (result.code === 1) return { ok: true, bases: new Map() };
  if (result.code !== 0)
    return { ok: false, reason: `${reason} (git config exited ${result.code})` };

  const bases = new Map(
    result.stdout
      .split("\0")
      .filter(Boolean)
      .map((record) => {
        const split = record.indexOf("\n");
        return [record.slice(7, split - suffix.length), record.slice(split + 1).trim()];
      }),
  );

  return { ok: true, bases };
}

export async function recordBase(
  cwd: string,
  branch: string,
  base: string,
  io: Io = processIo(),
): Promise<boolean> {
  const result = await git(
    cwd,
    ["config", baseKey(branch), base],
    { capture: true, write: true },
    io,
  );

  return result.code === 0;
}

export async function chain(cwd: string, branch: string, io: Io = processIo()): Promise<ChainRead> {
  const stack = [branch];
  for (let current = branch; ;) {
    const result = await recordedBase(cwd, current, io);
    if (!result.ok) return result;

    const base = result.base;
    if (!base || base.startsWith("origin/")) return { ok: true, stack };
    if (stack.includes(base)) return { ok: false, reason: `cycle in recorded bases at ${base}` };

    stack.unshift(base);
    current = base;
  }
}
