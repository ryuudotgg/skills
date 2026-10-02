import { gitRead } from "../project.ts";
import { processIo, type Io } from "../io.ts";
import { git } from "../publish/commit.ts";
import { describe } from "../read.ts";

export type BaseRead = { ok: true; base: string | undefined } | { ok: false; reason: string };
type BasesRead = { ok: true; bases: ReadonlyMap<string, string> } | { ok: false; reason: string };
type ChainRead = { ok: true; stack: string[] } | { ok: false; reason: string };

export async function recordedBase(cwd: string, branch: string, io: Io = processIo()): Promise<BaseRead> {
  const key = `branch.${branch}.skills-base`;
  const result = await gitRead(cwd, ["config", "--get", key], {}, io);
  if (!result.ok) return { ok: false, reason: `cannot read ${key} (${describe(result.failure)})` };
  if (result.code === 0) return { ok: true, base: result.stdout.trim() || undefined };
  if (result.code === 1) return { ok: true, base: undefined };

  return { ok: false, reason: `cannot read ${key} (git config exited ${result.code})` };
}

export async function recordedBases(cwd: string, io: Io = processIo()): Promise<BasesRead> {
  const result = await gitRead(cwd, ["config", "-z", "--get-regexp", "^branch\\..*\\.skills-base$"], {}, io);
  const reason = "cannot read recorded skills-base keys";
  if (!result.ok) return { ok: false, reason: `${reason} (${describe(result.failure)})` };
  if (result.code === 1) return { ok: true, bases: new Map() };
  if (result.code !== 0) return { ok: false, reason: `${reason} (git config exited ${result.code})` };

  const bases = new Map(result.stdout.split("\0").filter(Boolean).map((record) => {
    const split = record.indexOf("\n");
    return [record.slice(7, split - ".skills-base".length), record.slice(split + 1).trim()];
  }));

  return { ok: true, bases };
}

export async function recordBase(cwd: string, branch: string, base: string, io: Io = processIo()): Promise<boolean> {
  const result = await git(cwd, ["config", `branch.${branch}.skills-base`, base], { capture: true, write: true }, io);
  return result.code === 0;
}

export async function chain(cwd: string, branch: string, io: Io = processIo()): Promise<ChainRead> {
  const stack = [branch];
  for (let current = branch; ; ) {
    const result = await recordedBase(cwd, current, io);
    if (!result.ok) return result;

    const base = result.base;
    if (!base || base.startsWith("origin/")) return { ok: true, stack };
    if (stack.includes(base)) return { ok: false, reason: `cycle in recorded bases at ${base}` };

    stack.unshift(base);
    current = base;
  }
}
