import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { AD_HOC_ID, bookkeepingEvents, type Histories, historiesOf, historyKey } from "skills-core";
import type { Io } from "../io.ts";
import { asciiLower, gitRead } from "../project.ts";
import { closedStatus, holds, listWorktrees, physical, type Worktree } from "./checkouts.ts";
import { readPlans, type Plans } from "./projection.ts";

export type Owner =
  | { kind: "plan"; project: string; id: string }
  | { kind: "adhoc"; repo: string; branch: string }
  | { kind: "id"; id: string };

export type Artifact =
  | { kind: "simulator"; name: string; udid: string; booted: boolean }
  | { kind: "avd"; name: string; serials: readonly string[] }
  | { kind: "compose"; name: string; directories: readonly string[] }
  | { kind: "volume"; name: string }
  | { kind: "listener"; name: string; pid: number; started: string; cwd: string };

export type Kind = Artifact["kind"];

export type Hold = { reason: string; failed: boolean };

export function failure(error: unknown): Hold {
  return { reason: error instanceof Error ? error.message : String(error), failed: true };
}

export type Base = {
  project: string;
  trail: string;
  repos: readonly string[];
  trunk: string;
  scratch: string;
  mine?: readonly Owner[];
};

export type Run = "open" | "handed back";

export type World = {
  projects: Plans["projects"];
  histories: Histories;
  adHoc: ReadonlyMap<string, Run>;
  worktrees: readonly Worktree[];
};

type AdHocLine = { event: string; handback: number };

export type Verdict =
  | { kind: "reap"; token: string }
  | { kind: "kept"; token: string; hold: Hold }
  | { kind: "silent" };

const SWEEP_TRASH = /^\.plans-([0-9]+)\.sweep-[0-9a-f-]{36}$/;
const SCRATCH = /^plans-([0-9]+)$/;

export async function readWorld(base: Base, io: Io): Promise<World | string> {
  const read = await readPlans(io.env, true);
  if (read.kind === "failed") return read.reason;

  const { projects, trail } = read.plans;
  if (base.project && !projects.has(base.project)) return `cannot read ${base.project} index.tsv`;

  const histories = historiesOf(trail);
  const ignored: readonly string[] = bookkeepingEvents;
  const lines = new Map<string, AdHocLine>();
  for (const entry of trail)
    if (entry.id === AD_HOC_ID && !ignored.includes(entry.event)) {
      const key = historyKey(entry.project, entry.detail.split(" ")[0] ?? "");
      const handback = lines.get(key)?.handback ?? Number.NEGATIVE_INFINITY;
      const at = entry.event === "handback" ? Date.parse(entry.ts) / 1000 : handback;
      lines.set(key, { event: entry.event, handback: Math.max(handback, at) });
    }

  const worktrees = await listWorktrees(io);
  if (!worktrees) return "git worktree list failed";

  return { projects, histories, adHoc: await adHocRuns(lines, base, io), worktrees };
}

async function adHocRuns(
  lines: ReadonlyMap<string, AdHocLine>,
  base: Base,
  io: Io,
): Promise<Map<string, Run>> {
  const runs = await Promise.all(
    [...lines].map(async ([key, line]): Promise<[string, Run]> => {
      if (line.event !== "handback") return [key, "open"];

      const [repo = "", branch = ""] = key.split("\t");
      const reused = sameRepo(repo, base) && (await createdAfter(branch, line.handback, io));
      return [key, reused ? "open" : "handed back"];
    }),
  );

  return new Map(runs);
}

async function createdAfter(branch: string, handback: number, io: Io): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  const state = await refState(ref, io);
  if (state !== "present") return state === "unreadable";

  const args = ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", ref, "--"];
  const log = await gitRead(io.cwd, args, {}, io);
  if (!log.ok || log.code !== 0) return true;

  const oldest = log.stdout.trimEnd().split("\n").at(-1) ?? "";
  if (!oldest) return (await gitFile(`logs/${ref}`, io)) === "unreadable";

  const created = /@\{([0-9]+)\}\tbranch: Created from /.exec(oldest)?.[1];
  return created !== undefined && Number(created) > handback;
}

async function refState(ref: string, io: Io): Promise<"present" | "absent" | "unreadable"> {
  const exists = await gitRead(io.cwd, ["show-ref", "--exists", ref], {}, io);
  if (!exists.ok) return "unreadable";
  if (exists.code === 0) return "present";
  if (exists.code === 2) return "absent";
  if (exists.code === 129) {
    const verify = await gitRead(io.cwd, ["show-ref", "--verify", "--quiet", ref], {}, io);
    if (verify.ok && verify.code === 0) return "present";
    if (!verify.ok || verify.code !== 1) return "unreadable";
  } else if (exists.code !== 1) return "unreadable";

  return (await gitFile(ref, io)) === "missing" ? "absent" : "unreadable";
}

async function gitFile(name: string, io: Io): Promise<"missing" | "readable" | "unreadable"> {
  const path = await gitRead(io.cwd, ["rev-parse", "--git-path", name], {}, io);
  if (!path.ok || path.code !== 0) return "unreadable";

  try {
    await readFile(resolve(io.cwd, path.stdout.trim()));
    return "readable";
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unreadable";
  }
}

export function avdWord(word: string): string {
  return word.replace(/[^A-Za-z0-9.-]/g, "-");
}

export function ownerToken(owner: Owner): string {
  switch (owner.kind) {
    case "plan":
      return `${owner.project} ${owner.id}`;

    case "adhoc":
      return `${owner.repo} ${owner.branch}`;

    case "id":
      return owner.id;
  }
}

function sameRepo(name: string, base: Base): boolean {
  return base.repos.some((repo) => asciiLower(repo) === asciiLower(name));
}

function avdOwners(name: string, base: Base, world: World): Owner[] {
  const legacy = /^Plans_([0-9]+)_./.exec(name);
  if (legacy) return [{ kind: "id", id: legacy[1]! }];

  const plan = /^plans_([A-Za-z0-9.-]+)_([0-9]+)_./.exec(name);
  if (plan) {
    const [, word = "", id = ""] = plan;
    const projects = [...world.projects.keys()].filter((project) => avdWord(project) === word);
    return (projects.length ? projects : [word]).map((project) => ({ kind: "plan", project, id }));
  }

  const adhoc = /^adhoc_([A-Za-z0-9.-]+)_([A-Za-z0-9.-]+)_./.exec(name);
  if (!adhoc) return [];

  const [, repoWord = "", word = ""] = adhoc;
  const keys = new Set(world.adHoc.keys());
  for (const owner of base.mine ?? [])
    if (owner.kind === "adhoc") keys.add(historyKey(owner.repo, owner.branch));

  for (const worktree of world.worktrees)
    if (worktree.branch !== base.trunk) keys.add(historyKey(base.trail, worktree.branch));

  const known: Owner[] = [...keys].flatMap((key) => {
    const [repo = "", branch = ""] = key.split("\t");
    return asciiLower(avdWord(repo)) === asciiLower(repoWord) && avdWord(branch) === word
      ? [{ kind: "adhoc", repo, branch }]
      : [];
  });

  const ours = base.repos.some((name) => asciiLower(avdWord(name)) === asciiLower(repoWord));
  return known.length
    ? known
    : [{ kind: "adhoc", repo: ours ? base.trail : repoWord, branch: word }];
}

function simulatorOwners(name: string, base: Base): Owner[] {
  const legacy = /^plans-([0-9]+) ./.exec(name);
  if (legacy) return [{ kind: "id", id: legacy[1]! }];

  const plan = /^plans (\S+) ([0-9]+) ./.exec(name);
  if (plan) return [{ kind: "plan", project: plan[1]!, id: plan[2]! }];

  const adhoc = /^adhoc (\S+) (\S+) ./.exec(name);
  if (!adhoc) return [];

  const [, repo = "", branch = ""] = adhoc;
  return [{ kind: "adhoc", repo: sameRepo(repo, base) ? base.trail : repo, branch }];
}

function within(root: string, path: string): string | undefined {
  if (path === root) return "";
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined;
}

export function branchOwners(branch: string, base: Base, world: World): Owner[] {
  const rows = (world.projects.get(base.project) ?? [])
    .filter((row) => row.branch === branch)
    .sort((left, right) => Number(left.id) - Number(right.id));

  const open = rows.filter((row) => !closedStatus(row));
  const owning = open.length ? open : rows.slice(0, 1);
  return owning.length
    ? owning.map((row) => ({ kind: "plan", project: base.project, id: row.id }))
    : [{ kind: "adhoc", repo: base.trail, branch }];
}

function checkoutOwners(worktree: Worktree, base: Base, world: World): Owner[] {
  if (worktree.primary || worktree.branch === base.trunk) return [];

  const { branch } = worktree;
  const owner = branchOwners(branch, base, world)[0]!;
  if (owner.kind !== "plan" || !closedIds(base, world).has(owner.id)) return [owner];

  const runs: Owner[] = [...world.adHoc.keys()].flatMap((key) => {
    const [repo = "", line = ""] = key.split("\t");
    return line === branch && sameRepo(repo, base) ? [{ kind: "adhoc", repo, branch }] : [];
  });

  return [owner, ...runs];
}

export function placeOwners(directory: string, base: Base, world: World): Owner[] {
  const bare = directory.replace(/ \(deleted\)$/, "");
  if (!bare.startsWith("/")) return [];

  const paths = [...new Set([bare, physical(bare)])];
  const found: { depth: number; owners: Owner[] }[] = [];
  for (const worktree of world.worktrees)
    for (const root of new Set([worktree.path, physical(worktree.path)]))
      if (paths.some((path) => within(root, path) !== undefined))
        found.push({ depth: root.length, owners: checkoutOwners(worktree, base, world) });

  for (const root of new Set([base.scratch, physical(base.scratch)]))
    for (const path of paths) {
      const first = within(root, path)?.split("/")[0] ?? "";
      const id = (SCRATCH.exec(first) ?? SWEEP_TRASH.exec(first))?.[1];
      if (id) found.push({ depth: root.length + first.length + 1, owners: [{ kind: "id", id }] });
    }

  return found.sort((left, right) => right.depth - left.depth)[0]?.owners ?? [];
}

export function ownersOf(artifact: Artifact, base: Base, world: World): Owner[] {
  switch (artifact.kind) {
    case "simulator":
      return simulatorOwners(artifact.name, base);

    case "avd":
      return avdOwners(artifact.name, base, world);

    case "volume": {
      const legacy = /^plans-([0-9]+)-./.exec(artifact.name);
      return legacy ? [{ kind: "id", id: legacy[1]! }] : [];
    }

    case "compose": {
      const places = artifact.directories.map((directory) => placeOwners(directory, base, world));
      if (places.some((owners) => owners.length === 0)) return [];

      const unique = new Map(
        places.flat().map((owner) => [`${owner.kind} ${ownerToken(owner)}`, owner]),
      );

      return [...unique.values()];
    }

    case "listener":
      return placeOwners(artifact.cwd, base, world);
  }
}

function closedIds(base: Base, world: World): Set<string> {
  return new Set(
    (world.projects.get(base.project) ?? []).filter(closedStatus).map((row) => row.id),
  );
}

function inScope(owner: Owner, base: Base, world: World): boolean {
  switch (owner.kind) {
    case "plan":
      return owner.project === base.project && closedIds(base, world).has(owner.id);

    case "id":
      return closedIds(base, world).has(owner.id);

    case "adhoc":
      return sameRepo(owner.repo, base);
  }
}

function batchHold(project: string, id: string, world: World): Hold | undefined {
  const rows = world.projects.get(project) ?? [];
  const row = rows.find((entry) => entry.id === id);
  if (!row) return undefined;

  const batch =
    row.branch && row.branch !== "-" ? rows.filter((entry) => entry.branch === row.branch) : [row];

  const reason = batch.map((entry) => holds(project, entry, world.histories)).find(Boolean);
  return reason ? { reason, failed: false } : undefined;
}

function holdOf(owner: Owner, world: World): Hold | undefined {
  switch (owner.kind) {
    case "plan":
      return batchHold(owner.project, owner.id, world);

    case "id":
      return [...world.projects.keys()]
        .map((project) => batchHold(project, owner.id, world))
        .find(Boolean);

    case "adhoc":
      return world.adHoc.get(historyKey(owner.repo, owner.branch)) === "handed back"
        ? undefined
        : { reason: `${owner.repo} ${owner.branch} has not handed back`, failed: false };
  }
}

function sameOwner(owner: Owner, mine: Owner): boolean {
  switch (owner.kind) {
    case "plan":
      return mine.kind === "plan" && owner.project === mine.project && owner.id === mine.id;

    case "id":
      return mine.kind === "plan" && owner.id === mine.id;

    case "adhoc":
      return (
        mine.kind === "adhoc" &&
        asciiLower(owner.repo) === asciiLower(mine.repo) &&
        owner.branch === mine.branch
      );
  }
}

function holdBesides(owner: Owner, mine: readonly Owner[], world: World): Hold | undefined {
  const match = mine.find((entry) => sameOwner(owner, entry));
  if (!match) return holdOf(owner, world);
  if (owner.kind !== "id" || match.kind !== "plan") return undefined;

  return [...world.projects.keys()]
    .filter((project) => project !== match.project)
    .map((project) => batchHold(project, owner.id, world))
    .find(Boolean);
}

function judgeMine(owners: readonly Owner[], mine: readonly Owner[], world: World): Verdict {
  const own = owners.find((owner) => mine.some((entry) => sameOwner(owner, entry)));
  if (!own) return { kind: "silent" };

  const token = ownerToken(own);
  const [hold] = owners.flatMap((owner) => holdBesides(owner, mine, world) ?? []);
  return hold ? { kind: "kept", token, hold } : { kind: "reap", token };
}

export function judge(artifact: Artifact, base: Base, world: World): Verdict {
  const owners = ownersOf(artifact, base, world);
  if (base.mine) return judgeMine(owners, base.mine, world);

  const scoped = owners.filter((owner) => inScope(owner, base, world));
  if (scoped.length === 0) return { kind: "silent" };

  const token = ownerToken(scoped[0]!);
  const [hold] = owners.flatMap((owner) => holdOf(owner, world) ?? []);
  if (!hold) return { kind: "reap", token };

  return scoped.some((owner) => owner.kind !== "adhoc")
    ? { kind: "kept", token, hold }
    : { kind: "silent" };
}
