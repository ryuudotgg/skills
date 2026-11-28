import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type Io = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out(text: string): void;
  err(text: string): void;
  capture: boolean;
};

export function processIo(): Io {
  return {
    cwd: process.cwd(),
    env: process.env,
    out: (text) => {
      process.stdout.write(text);
    },
    err: (text) => {
      process.stderr.write(text);
    },
    capture: false,
  };
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify(value)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function nearestExisting(path: string): string | undefined {
  for (let at = path; ; at = dirname(at))
    try {
      lstatSync(at);
      return at;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(at) === at)
        return undefined;
    }
}

function sameDirectory(one: string, other: string): boolean {
  try {
    const first = lstatSync(one, { bigint: true });
    const second = lstatSync(other, { bigint: true });
    return first.dev === second.dev && first.ino === second.ino && statSync(one).isDirectory();
  } catch {
    return false;
  }
}

export function foldsCase(root: string): boolean {
  const parts = nearestExisting(root)?.split("/") ?? [];
  const last = parts.findLastIndex((part) => /[A-Za-z]/u.test(part));
  if (last === -1) return false;

  const respelled = parts[last]!.replace(/[A-Za-z]/gu, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );

  const kept = parts.slice(0, last);
  return sameDirectory([...kept, parts[last]].join("/"), [...kept, respelled].join("/"));
}
