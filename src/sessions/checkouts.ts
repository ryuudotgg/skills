import { basename } from "node:path";
import { readSync } from "../read.ts";
import { encodedName, projectsDir } from "./claude.ts";
import type { SessionStore } from "./claude.ts";
import { childPath, directoryEntries, isDirectory, note, pathString } from "./jsonl.ts";
import type { Notes } from "./jsonl.ts";

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

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

export function repositoryStore(
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notes: Notes,
): SessionStore {
  const roots = checkoutRoots(cwd, home, env);
  const keeps = (recorded: string): boolean =>
    roots.some((root) => within(root, pathString(recorded)));

  const projects = projectsDir(home);

  let names: string[];
  try {
    names = directoryEntries(projects);
  } catch {
    note(notes, `${projects} is unavailable`);
    return { folders: [], keeps };
  }

  const prefixes = roots.map(encodedName);
  const folders = names
    .filter((name) => prefixes.some((prefix) => name === prefix || name.startsWith(`${prefix}-`)))
    .sort()
    .map((name) => childPath(projects, name))
    .filter(isDirectory);

  return { folders, keeps };
}
