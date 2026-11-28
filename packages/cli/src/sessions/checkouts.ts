import { realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { foldsCase, isDirectory } from "../io.ts";
import { RELOCATIONS, relocationRecord } from "../plans/relocations.ts";
import { asciiLower } from "../project.ts";
import { readSync } from "../read.ts";
import { encodedName } from "./claude.ts";
import type { SessionStore } from "./claude.ts";
import { childPath, directoryEntries, note, pathString } from "./jsonl.ts";
import type { Notes } from "./jsonl.ts";

const asWritten = (text: string): string => text;

function listedWorktrees(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const listed = readSync(["git", "worktree", "list", "--porcelain", "-z"], {
    cwd,
    env,
    deadline: 10_000,
  });

  if (!listed.ok || listed.code !== 0) return [];

  return listed.stdout
    .split("\0")
    .flatMap((line) =>
      line.startsWith("worktree ") ? [pathString(line.slice("worktree ".length))] : [],
    );
}

function rootsOf(worktrees: readonly string[], cwd: string, home: string): string[] {
  const main = worktrees[0];
  if (main === undefined) return [pathString(cwd)];
  return [...worktrees, t3Worktrees(home, main)];
}

export function checkoutRoots(cwd: string, home: string, env: NodeJS.ProcessEnv): string[] {
  return rootsOf(listedWorktrees(cwd, env), cwd, home);
}

function t3Worktrees(home: string, checkout: string): string {
  return childPath(home, `.t3/worktrees/${basename(checkout)}`);
}

function physical(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

function within(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);
}

type Root = {
  readonly path: string;
  readonly prefix: string;
  readonly spelling: (text: string) => string;
};

function rootAt(path: string): Root {
  const spelling = foldsCase(path) ? asciiLower : asWritten;
  return { path: spelling(path), prefix: spelling(encodedName(path)), spelling };
}

function tailAndAncestors(tail: string): string[] {
  const parts = tail.split("/").filter(Boolean);
  return ["", ...parts.map((_, index) => `/${parts.slice(0, index + 1).join("/")}`)];
}

function formerPaths(plans: string, checkout: string, notes: Notes): readonly string[] {
  try {
    return relocationRecord(plans).formerPathsOf(checkout);
  } catch {
    note(notes, `${join(plans, RELOCATIONS)} is unavailable`);
    return [];
  }
}

export function repositoryStore(
  projects: string,
  home: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  notes: Notes,
  plans: string,
): SessionStore {
  const worktrees = listedWorktrees(cwd, env);
  const main = worktrees[0];
  const checkout = physical(main ?? cwd);
  const formers = main === undefined ? [] : formerPaths(plans, checkout, notes);

  const named = formers.map((former) => t3Worktrees(home, former));
  const roots = [...new Set([...rootsOf(worktrees, cwd, home), ...named])].map(rootAt);
  const left = formers.map((former) => ({ former, root: rootAt(former) }));
  const target = rootAt(checkout);

  const carried = (path: string, folder: string): boolean =>
    left.some(({ former, root }) => {
      if (!within(root.path, root.spelling(path))) return false;

      const name = target.spelling(basename(folder));
      return tailAndAncestors(path.slice(former.length)).some(
        (tail) => target.spelling(encodedName(checkout + tail)) === name,
      );
    });

  const keeps = (recorded: string, folder: string): boolean => {
    const path = pathString(recorded);
    return roots.some((root) => within(root.path, root.spelling(path))) || carried(path, folder);
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
