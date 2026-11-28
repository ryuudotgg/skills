import { lstatSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isDirectory } from "../io.ts";
import { asciiLower } from "../project.ts";
import { readSync } from "../read.ts";
import { encodedName } from "./claude.ts";
import type { SessionStore } from "./claude.ts";
import { childPath, directoryEntries, note, pathString } from "./jsonl.ts";
import type { Notes } from "./jsonl.ts";

const asWritten = (text: string): string => text;

export function checkoutRoots(cwd: string, home: string, env: NodeJS.ProcessEnv): string[] {
  const listed = readSync(["git", "worktree", "list", "--porcelain", "-z"], {
    cwd,
    env,
    deadline: 10_000,
  });

  const worktrees =
    listed.ok && listed.code === 0
      ? listed.stdout
          .split("\0")
          .flatMap((line) =>
            line.startsWith("worktree ") ? [pathString(line.slice("worktree ".length))] : [],
          )
      : [];

  const main = worktrees[0];
  if (main === undefined) return [pathString(cwd)];

  const t3Worktrees = childPath(home, `.t3/worktrees/${basename(main)}`);
  return [...worktrees, t3Worktrees];
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

function foldsCase(root: string): boolean {
  const parts = nearestExisting(root)?.split("/") ?? [];
  const last = parts.findLastIndex((part) => /[A-Za-z]/u.test(part));
  if (last === -1) return false;

  const respelled = parts[last]!.replace(/[A-Za-z]/gu, (letter) =>
    letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase(),
  );

  const kept = parts.slice(0, last);
  return sameDirectory([...kept, parts[last]].join("/"), [...kept, respelled].join("/"));
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function repositoryStore(
  projects: string,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notes: Notes,
): SessionStore {
  const roots = checkoutRoots(cwd, home, env).map((path) => {
    const spelling = foldsCase(path) ? asciiLower : asWritten;
    return { path: spelling(path), prefix: spelling(encodedName(path)), spelling };
  });

  const keeps = (recorded: string): boolean => {
    const path = pathString(recorded);
    return roots.some((root) => within(root.path, root.spelling(path)));
  };

  let names: string[];
  try {
    names = directoryEntries(projects);
  } catch {
    note(notes, `${projects} is unavailable`);
    return { folders: [], keeps };
  }

  const folders = names
    .filter((name) =>
      roots.some(({ prefix, spelling }) => {
        const spelled = spelling(name);
        return spelled === prefix || spelled.startsWith(`${prefix}-`);
      }),
    )
    .sort()
    .map((name) => childPath(projects, name))
    .filter(isDirectory);

  return { folders, keeps };
}
