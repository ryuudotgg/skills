import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { gitOutput, gitRead } from "../project.ts";
import { OPERATIONS } from "../stack/restack.ts";
import type { IndexRow } from "./index-tsv.ts";
import { latestMerge, readPrs } from "./prs.ts";
import { historyKey, type Histories } from "./trail.ts";

export type Worktree = { path: string; branch: string; locked: boolean; primary: boolean };

export function closedStatus(row: IndexRow): boolean {
  return row.status === "DONE" || row.status === "DROPPED";
}

export function holds(project: string, row: IndexRow, histories: Histories): string | undefined {
  const history = histories.get(historyKey(project, row.id));
  if (closedStatus(row))
    return history?.live ? `${project} ${row.id} has not handed back` : undefined;

  if (row.status === "TODO")
    return history?.start === undefined ? undefined : `${project} ${row.id} is TODO after a start`;

  return `${project} ${row.id} is ${row.status}`;
}

export async function listWorktrees(io: Io): Promise<Worktree[] | undefined> {
  const output = await gitOutput(io.cwd, ["worktree", "list", "--porcelain"], {}, io);
  if (output === undefined) return undefined;

  const worktrees: Worktree[] = [];
  for (const [position, block] of output.split("\n\n").entries()) {
    const path = /^worktree (.+)$/m.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1];
    if (path && branch)
      worktrees.push({ path, branch, locked: /^locked\b/m.test(block), primary: position === 0 });
  }

  return worktrees;
}

export function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

export async function currentCheckout(io: Io): Promise<string> {
  const top = await gitOutput(io.cwd, ["rev-parse", "--show-toplevel"], { quiet: true }, io);
  return physical(top?.trim() || io.cwd);
}

export type CheckoutState =
  | { state: "clean" }
  | {
      state: "primary" | "current" | "busy" | "unreadable" | "dirty" | "unpushed";
      reason: string;
      failed?: boolean;
    };

export type Candidate = { id: string; worktree: Worktree };

export function checkoutCandidates(
  rows: readonly IndexRow[],
  project: string,
  histories: Histories,
  trunk: string,
  worktrees: readonly Worktree[],
): Candidate[] {
  const owners = new Map<string, string>();
  for (const row of rows)
    if (closedStatus(row) && row.branch && row.branch !== "-") owners.set(row.branch, row.id);

  for (const row of rows)
    if (!closedStatus(row) && holds(project, row, histories)) owners.delete(row.branch);

  owners.delete(trunk);
  return worktrees.flatMap((worktree) => {
    const id = owners.get(worktree.branch);
    return id === undefined ? [] : [{ id, worktree }];
  });
}

export async function mergedHead(
  branch: string,
  trunk: string,
  io: Io,
): Promise<string | undefined> {
  const prs = await readPrs(branch, io);
  return typeof prs === "string" ? undefined : latestMerge(prs, trunk)?.head;
}

function changed(status: string): string {
  const line = status.split("\n").find(Boolean) ?? "";
  const path = line.slice(3);
  return line.startsWith("??") ? `untracked ${path}` : `tracked change ${path}`;
}

export async function checkoutState(
  worktree: Worktree,
  current: string,
  head: string | undefined,
  io: Io,
): Promise<CheckoutState> {
  if (worktree.primary) return { state: "primary", reason: "the primary checkout" };
  if (physical(worktree.path) === current)
    return { state: "current", reason: "the checkout this runs in" };

  if (worktree.locked) return { state: "busy", reason: "locked by git worktree lock" };

  const admin = (
    await gitOutput(worktree.path, ["rev-parse", "--absolute-git-dir"], { quiet: true }, io)
  )?.trim();

  if (!admin) return { state: "unreadable", reason: "git rev-parse failed" };

  const operation = OPERATIONS.find((name) => existsSync(join(admin, name)));
  if (operation) return { state: "busy", reason: `${operation} is in progress` };

  const status = await gitOutput(
    worktree.path,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    { timeout: 10_000, quiet: true },
    io,
  );

  if (status === undefined) return { state: "unreadable", reason: "git status failed" };
  if (status.trim()) return { state: "dirty", reason: changed(status) };
  if (!head) return { state: "unpushed", reason: "no merged PR head to check its commits against" };

  const pushed = await gitRead(
    worktree.path,
    ["merge-base", "--is-ancestor", "HEAD", head],
    {},
    io,
  );

  if (pushed.ok && pushed.code === 0) return { state: "clean" };

  return pushed.ok && pushed.code === 1
    ? { state: "unpushed", reason: "a commit outside the merged PR's head" }
    : { state: "unpushed", reason: `cannot check its commits against ${head}`, failed: true };
}
