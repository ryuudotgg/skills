import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { ghOutput } from "../gh.ts";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { checkoutIs, defaultBranch, gitOutput } from "../project.ts";
import { describe } from "../read.ts";
import { OPERATIONS } from "../stack/restack.ts";
import {
  indexIn,
  indexPath,
  missingIndex,
  plansDir,
  readIndex,
  readIndexTolerant,
  scratchLock,
  type IndexRow,
} from "./index-tsv.ts";
import { readTrailTolerant, trailPath } from "./trail.ts";
import { closePlan, mergedLine, type Stamp } from "./verbs.ts";

type Pr = {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
  sha: string;
  head: string;
  title: string;
  ended: number;
  conflicting: boolean;
};

type Merged = Pr & { state: "MERGED" };

type Verdict =
  | { kind: "merged"; pr: Merged }
  | { kind: "open"; pr: Pr }
  | { kind: "elsewhere"; number: number; base: string }
  | { kind: "abandoned"; number: number }
  | { kind: "none" }
  | { kind: "trunk" }
  | { kind: "unstarted"; number: number }
  | { kind: "unreadable"; reason: string };

type History = {
  start: number | undefined;
  live: boolean;
  thread: string | undefined;
  sent: Set<string>;
};

type Conflict = {
  id: string;
  slug: string;
  pr: number;
  sha: string;
  thread: string | null;
  sent: boolean;
};

type Histories = Map<string, History>;
type Projects = Map<string, IndexRow[] | undefined>;
type Worktree = { path: string; branch: string; locked: boolean; primary: boolean };

const PR_FIELDS =
  "number,state,baseRefName,mergeCommit,headRefOid,title,isCrossRepository,mergedAt,closedAt,mergeable";

const PR_LIMIT = 200;
const TRASH = /^\.plans-[0-9]+\.sweep-[0-9a-f-]{36}$/;
const GH_WIDTH = 4;
const CONFLICT_SENT = "conflict-sent";
const OPENS_THREAD: Record<string, boolean> = {
  start: true,
  review: true,
  handback: false,
  done: false,
};

function historyKey(project: string, id: string): string {
  return `${project}\t${id}`;
}

function emptyHistory(): History {
  return { start: undefined, live: false, thread: undefined, sent: new Set() };
}

function readHistories(io: Io): Histories | undefined {
  const table = readTrailTolerant(trailPath(io.env));
  if (table.kind === "failed") return undefined;

  const histories: Histories = new Map();
  if (table.kind === "absent") return histories;

  for (const entry of table.rows) {
    const key = historyKey(entry.project, entry.id);
    const history = histories.get(key) ?? emptyHistory();

    histories.set(key, history);
    if (entry.event === "thread") history.thread = entry.detail;
    if (entry.event === CONFLICT_SENT) history.sent.add(entry.detail);
    if (entry.event === "start") history.start = Date.parse(entry.ts);

    const live = OPENS_THREAD[entry.event];
    if (live !== undefined) history.live = live;
  }

  return histories;
}

function parsePr(entry: unknown): Pr | undefined {
  if (typeof entry !== "object" || entry === null) throw new Error("PR entry is not an object");

  const fields = entry as Record<string, unknown>;
  const { number, state, mergeCommit } = fields;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0)
    throw new Error("PR entry has no number");

  if (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")
    throw new Error(`PR ${number} has state ${String(state)}`);

  if (fields.isCrossRepository !== false) return undefined;

  const oid =
    typeof mergeCommit === "object" && mergeCommit !== null && "oid" in mergeCommit
      ? mergeCommit.oid
      : undefined;

  const sha = typeof oid === "string" ? oid : "";
  if (state === "MERGED" && !/^[0-9a-f]{7,40}$/i.test(sha))
    throw new Error(`PR ${number} merged with no merge commit`);

  const stamp = state === "MERGED" ? fields.mergedAt : fields.closedAt;
  const ended = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  if (state !== "OPEN" && Number.isNaN(ended)) throw new Error(`PR ${number} has no close time`);

  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    number,
    state,
    base: text(fields.baseRefName),
    sha,
    head: text(fields.headRefOid),
    title: text(fields.title),
    ended,
    conflicting: fields.mergeable === "CONFLICTING",
  };
}

async function readPrs(branch: string, io: Io): Promise<Pr[] | string> {
  const output = await ghOutput(
    [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "all",
      "--json",
      PR_FIELDS,
      "--limit",
      String(PR_LIMIT),
    ],
    io,
  );

  if (output === undefined) return "gh pr list failed";

  try {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("PR list is not an array");
    if (value.length >= PR_LIMIT) throw new Error(`${PR_LIMIT} or more PRs, the list may be cut`);

    return value.map(parsePr).filter((pr) => pr !== undefined);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function inBatches<In, Out>(
  items: readonly In[],
  run: (item: In) => Promise<Out>,
): Promise<Out[]> {
  const results: Out[] = [];
  for (let start = 0; start < items.length; start += GH_WIDTH)
    results.push(...(await Promise.all(items.slice(start, start + GH_WIDTH).map(run))));

  return results;
}

function latestMerge(prs: readonly Pr[], trunk: string): Merged | undefined {
  return prs
    .filter((pr): pr is Merged => pr.state === "MERGED" && pr.base === trunk)
    .sort((left, right) => right.ended - left.ended)[0];
}

function verdict(prs: Pr[] | string, trunk: string, start: number | undefined): Verdict {
  if (typeof prs === "string") return { kind: "unreadable", reason: prs };

  const open = prs.find((pr) => pr.state === "OPEN");
  if (open) return { kind: "open", pr: open };

  const ours = prs.filter((pr) => start === undefined || pr.ended > start);
  const merged = latestMerge(ours, trunk);
  if (merged && start === undefined) return { kind: "unstarted", number: merged.number };
  if (merged) return { kind: "merged", pr: merged };

  const elsewhere = ours.find((pr) => pr.state === "MERGED");
  if (elsewhere) return { kind: "elsewhere", number: elsewhere.number, base: elsewhere.base };

  const closed = ours.find((pr) => pr.state === "CLOSED");
  return closed ? { kind: "abandoned", number: closed.number } : { kind: "none" };
}

function waitingLine(row: IndexRow, found: Exclude<Verdict, { kind: "merged" }>): string {
  switch (found.kind) {
    case "open":
      return `open ${row.id} #${found.pr.number}`;

    case "elsewhere":
      return `elsewhere ${row.id} #${found.number}: merged into ${found.base}, not the default branch`;

    case "abandoned":
      return `unmerged ${row.id} #${found.number}: closed without merging, the operator's call`;

    case "none":
      return `nopr ${row.id} ${row.branch || "-"}`;

    case "trunk":
      return `skipped ${row.id} ${row.branch}: the default branch`;

    case "unstarted":
      return `unstarted ${row.id} #${found.number}: merged, but log.tsv has no start for the row`;

    case "unreadable":
      return `unreadable ${row.id} ${row.branch}: ${found.reason}`;
  }
}

function closedStatus(row: IndexRow): boolean {
  return row.status === "DONE" || row.status === "DROPPED";
}

function holds(project: string, row: IndexRow, histories: Histories): string | undefined {
  const history = histories.get(historyKey(project, row.id));
  if (closedStatus(row))
    return history?.live ? `${project} ${row.id} has not handed back` : undefined;

  if (row.status === "TODO")
    return history?.start === undefined ? undefined : `${project} ${row.id} is TODO after a start`;

  return `${project} ${row.id} is ${row.status}`;
}

function readProjects(io: Io): Projects {
  const plans = plansDir(io.env);
  const projects: Projects = new Map();
  for (const name of readdirSync(plans).sort()) {
    const table = readIndexTolerant(indexIn(join(plans, name)));
    if (table.kind === "rows") projects.set(name, table.rows);
    else if (table.kind === "failed") projects.set(name, undefined);
  }

  return projects;
}

function scratchHolder(
  id: string,
  projects: Projects,
  histories: Histories | undefined,
): { reason: string; unreadable: boolean } | undefined {
  if (!histories) return { reason: "log.tsv is unreadable", unreadable: true };

  for (const [project, rows] of projects) {
    if (!rows) return { reason: `${project} index.tsv is unreadable`, unreadable: true };

    for (const row of rows.filter((entry) => entry.id === id)) {
      const reason = holds(project, row, histories);
      if (reason) return { reason, unreadable: false };
    }
  }

  return undefined;
}

function ownScratch(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && stat.uid === process.getuid?.();
  } catch {
    return false;
  }
}

async function listWorktrees(io: Io): Promise<Worktree[] | undefined> {
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

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

async function checkoutState(
  worktree: Worktree,
  current: string,
  head: string | undefined,
  io: Io,
): Promise<string> {
  if (worktree.primary) return "primary";
  if (physical(worktree.path) === current) return "current";
  if (worktree.locked) return "busy";

  const admin = (
    await gitOutput(worktree.path, ["rev-parse", "--absolute-git-dir"], { quiet: true }, io)
  )?.trim();

  if (!admin) return "unreadable";
  if (OPERATIONS.some((operation) => existsSync(join(admin, operation)))) return "busy";

  const status = await gitOutput(
    worktree.path,
    ["--no-optional-locks", "status", "--porcelain", "--untracked-files=all"],
    { timeout: 10_000, quiet: true },
    io,
  );

  if (status === undefined) return "unreadable";
  if (status.trim()) return "dirty";
  if (!head) return "unpushed";

  const pushed = await gitOutput(
    worktree.path,
    ["merge-base", "--is-ancestor", "HEAD", head],
    { quiet: true },
    io,
  );

  return pushed === undefined ? "unpushed" : "clean";
}

export async function sweepVerb(
  args: readonly string[],
  usage: string,
  given: Io,
  scratch = "/tmp",
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const json = args.includes("--json");
  const rest = args.filter((arg) => arg !== "--dry-run" && arg !== "--json");
  const printed: string[] = [];
  const io: Io = json ? { ...given, out: (text) => printed.push(text) } : given;

  const [project = ""] = rest;
  if (rest.length !== 1 || project.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`sweep: ${reason}\n`);
    return 1;
  };

  let index: string;
  try {
    index = indexPath(project, io.env);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) return refuse(missingIndex(project));

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return refuse(elsewhere);
  if (!Bun.which("gh", { PATH: io.env.PATH })) return refuse("gh not found, cannot read PRs");

  const trunk = await defaultBranch(io.cwd, io);
  if (!trunk.ok) {
    if (trunk.failure) io.err(`${describe(trunk.failure)}\n`);
    return refuse("cannot read the default branch of origin");
  }

  const rows = readIndex(index);
  const histories = readHistories(io);
  if (!histories) return refuse(`cannot read ${trailPath(io.env)}`);

  const candidates = rows.filter((row) => row.status === "DOING" || row.status === "REVIEW");
  const lists = await inBatches(candidates, async (row) =>
    !row.branch || row.branch === "-" || row.branch === trunk.branch ? [] : readPrs(row.branch, io),
  );

  let failed = false;
  let pending = false;
  const closed = new Set<string>();
  const heads = new Map<string, string>();
  const conflicts: Conflict[] = [];
  for (const [position, row] of candidates.entries()) {
    const history = histories.get(historyKey(project, row.id));
    const found: Verdict =
      row.branch === trunk.branch
        ? { kind: "trunk" }
        : verdict(lists[position] ?? [], trunk.branch, history?.start);

    if (found.kind === "open" && row.status === "REVIEW" && found.pr.conflicting && found.pr.head) {
      const { number, head } = found.pr;
      const sent = history?.sent.has(head) ?? false;
      conflicts.push({
        id: row.id,
        slug: row.slug,
        pr: number,
        sha: head,
        thread: history?.thread ?? null,
        sent,
      });

      io.out(`${sent ? "sent" : "conflict"} ${row.id} #${number} ${head}\n`);
      continue;
    }

    if (found.kind !== "merged") {
      if (found.kind === "unreadable" || found.kind === "unstarted") failed = pending = true;
      io.out(`${waitingLine(row, found)}\n`);
      continue;
    }

    const { pr } = found;
    if (row.status === "DOING" && history?.live) {
      pending = true;
      io.out(`live ${row.id} #${pr.number}: merged while its thread still works\n`);
      continue;
    }

    const stamp: Stamp = async (branch) =>
      branch === row.branch
        ? mergedLine(pr.sha, branch, pr.number)
        : { refusal: `the landed draft names ${branch}, the row's branch is ${row.branch}` };

    const guard = (current: IndexRow): string | undefined => {
      if (current.status !== row.status || current.branch !== row.branch)
        return `row ${row.id} is now ${current.status} on ${current.branch}`;

      const now = readHistories(io)?.get(historyKey(project, row.id));
      return now?.start === history?.start && now?.live === history?.live
        ? undefined
        : `row ${row.id} was started or reviewed during the sweep`;
    };

    const result = await closePlan({
      index,
      project,
      id: row.id,
      status: "DONE",
      note: pr.title || row.slug,
      stamp,
      dryRun,
      env: io.env,
      guard,
    });

    if (result.kind === "already") {
      io.out(`already ${row.id} #${pr.number}: closed by another run\n`);
      continue;
    }

    if (result.kind === "refused") {
      failed = pending = true;
      io.out(
        result.draftless
          ? `draft ${row.id} #${pr.number} ${result.draftless}\n`
          : `refused ${row.id} #${pr.number}: ${result.reason}\n`,
      );

      continue;
    }

    closed.add(row.id);
    heads.set(row.branch, pr.head);
    io.out(`${dryRun ? "would close" : "closed"} ${row.id} #${pr.number} ${row.slug}\n`);
  }

  const settled = (entry: IndexRow): IndexRow =>
    dryRun && closed.has(entry.id) ? { ...entry, status: "DONE" } : entry;

  const after = (dryRun ? rows : readIndex(index)).map(settled);
  const owners = new Map<string, string>();
  for (const row of after)
    if (closedStatus(row) && row.branch && row.branch !== "-") owners.set(row.branch, row.id);

  for (const row of after)
    if (!closedStatus(row) && holds(project, row, histories)) owners.delete(row.branch);

  owners.delete(trunk.branch);

  const worktrees = await listWorktrees(io);
  if (!worktrees) {
    failed = true;
    io.out("unreadable checkouts: git worktree list failed\n");
  }

  const doing = new Map(
    after.filter((row) => row.status === "DOING").map((row) => [row.branch, row.id]),
  );

  const busy: Record<string, string> | null = worktrees ? {} : null;
  for (const worktree of worktrees ?? []) {
    const id = doing.get(worktree.branch);
    if (busy && id !== undefined) busy[worktree.path] = id;
  }

  const top = await gitOutput(io.cwd, ["rev-parse", "--show-toplevel"], { quiet: true }, io);
  const current = physical(top?.trim() || io.cwd);
  for (const worktree of worktrees ?? []) {
    const id = owners.get(worktree.branch);
    if (id === undefined) continue;

    let head = heads.get(worktree.branch);
    if (head === undefined) {
      const prs = await readPrs(worktree.branch, io);
      head = typeof prs === "string" ? undefined : latestMerge(prs, trunk.branch)?.head;
    }

    const state = await checkoutState(worktree, current, head, io);
    if (state === "unreadable") failed = true;

    io.out(`checkout ${id} ${worktree.path} ${state}\n`);
  }

  const holderNow = (id: string) => {
    const projects = readProjects(io);
    projects.set(project, projects.get(project)?.map(settled));

    const fresh = readHistories(io);
    for (const shut of dryRun ? closed : []) {
      const key = historyKey(project, shut);
      fresh?.set(key, { ...(fresh.get(key) ?? emptyHistory()), live: false });
    }

    return scratchHolder(id, projects, fresh);
  };

  const remove = (path: string, shown: string) => {
    if (dryRun) {
      io.out(`would remove ${shown}\n`);
      return;
    }

    try {
      rmSync(path, { recursive: true, force: true });
      io.out(`removed ${shown}\n`);
    } catch (error) {
      failed = true;
      io.out(`kept ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  };

  for (const name of readdirSync(scratch).sort())
    if (TRASH.test(name) && ownScratch(join(scratch, name)))
      remove(join(scratch, name), join(scratch, name));

  for (const row of after) {
    const path = join(scratch, `plans-${row.id}`);
    if (!closedStatus(row) || !/^[0-9]+$/.test(row.id) || !ownScratch(path)) continue;

    let claim: { holder?: ReturnType<typeof scratchHolder>; trash?: string };
    try {
      claim = dryRun
        ? { holder: holderNow(row.id) }
        : await withLock(scratchLock(io.env), "scratch", () => {
            const holder = holderNow(row.id);
            if (holder || !ownScratch(path)) return { holder };

            const trash = join(scratch, `.plans-${row.id}.sweep-${randomUUID()}`);
            renameSync(path, trash);
            return { trash };
          });
    } catch (error) {
      failed = true;
      io.out(`kept ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
      continue;
    }

    const { holder, trash } = claim;
    if (holder) {
      if (holder.unreadable) failed = true;
      if (holder.unreadable || closed.has(row.id)) io.out(`kept ${path}: ${holder.reason}\n`);
    } else if (dryRun || trash) remove(trash ?? path, path);
  }

  const verb = dryRun ? "would close" : "closed";
  io.out(
    closed.size === 0 && !pending
      ? "nothing left to close\n"
      : `${verb} ${closed.size} of ${candidates.length}\n`,
  );

  if (json) {
    const lines = printed.join("").split("\n").slice(0, -1);
    given.out(`${JSON.stringify({ lines, conflicts, busy })}\n`);
  }

  return failed ? 1 : 0;
}
