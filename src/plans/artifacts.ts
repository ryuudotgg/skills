import type { Io } from "../io.ts";
import { asciiLower } from "../project.ts";
import { closedStatus, holds, listWorktrees, physical, type Worktree } from "./checkouts.ts";
import { readProjects, type Projects } from "./sweep.ts";
import {
  AD_HOC_ID,
  bookkeepingEvents,
  historyKey,
  readHistories,
  readTrailTolerant,
  trailPath,
  type Histories,
} from "./trail.ts";

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

export type Base = {
  project: string;
  trail: string;
  repos: readonly string[];
  trunk: string;
  scratch: string;
  mine?: readonly Owner[];
};

export type World = {
  projects: Projects;
  histories: Histories;
  adHoc: ReadonlyMap<string, string>;
  worktrees: readonly Worktree[];
};

export type Verdict =
  | { kind: "reap"; token: string }
  | { kind: "kept"; token: string; hold: Hold }
  | { kind: "silent" };

const SWEEP_TRASH = /^\.plans-([0-9]+)\.sweep-[0-9a-f-]{36}$/;
const SCRATCH = /^plans-([0-9]+)$/;

export async function readWorld(base: Base, io: Io): Promise<World | string> {
  const projects = readProjects(io);
  if (base.project && !projects.has(base.project)) return `cannot read ${base.project} index.tsv`;

  for (const [project, rows] of projects) if (!rows) return `cannot read ${project} index.tsv`;

  const histories = readHistories(io.env);
  const trail = readTrailTolerant(trailPath(io.env));
  if (!histories || trail.kind === "failed") return `cannot read ${trailPath(io.env)}`;

  const ignored: readonly string[] = bookkeepingEvents;
  const adHoc = new Map<string, string>();
  for (const entry of trail.kind === "rows" ? trail.rows : [])
    if (entry.id === AD_HOC_ID && !ignored.includes(entry.event))
      adHoc.set(historyKey(entry.project, entry.detail.split(" ")[0] ?? ""), entry.event);

  const worktrees = await listWorktrees(io);
  if (!worktrees) return "git worktree list failed";

  return { projects, histories, adHoc, worktrees };
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

function checkoutOwner(worktree: Worktree, base: Base, world: World): Owner | undefined {
  if (worktree.primary || worktree.branch === base.trunk) return undefined;
  return branchOwners(worktree.branch, base, world)[0];
}

export function placeOwner(directory: string, base: Base, world: World): Owner | undefined {
  const bare = directory.replace(/ \(deleted\)$/, "");
  if (!bare.startsWith("/")) return undefined;

  const paths = [...new Set([bare, physical(bare)])];
  const found: { depth: number; owner: Owner | undefined }[] = [];
  for (const worktree of world.worktrees)
    for (const root of new Set([worktree.path, physical(worktree.path)]))
      if (paths.some((path) => within(root, path) !== undefined))
        found.push({ depth: root.length, owner: checkoutOwner(worktree, base, world) });

  for (const root of new Set([base.scratch, physical(base.scratch)]))
    for (const path of paths) {
      const first = within(root, path)?.split("/")[0] ?? "";
      const id = (SCRATCH.exec(first) ?? SWEEP_TRASH.exec(first))?.[1];
      if (id) found.push({ depth: root.length + first.length + 1, owner: { kind: "id", id } });
    }

  return found.sort((left, right) => right.depth - left.depth)[0]?.owner;
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
      const owners = artifact.directories.map((directory) => placeOwner(directory, base, world));
      if (owners.some((owner) => owner === undefined)) return [];

      const unique = new Map(owners.map((owner) => [ownerToken(owner!), owner!]));
      return [...unique.values()];
    }

    case "listener": {
      const owner = placeOwner(artifact.cwd, base, world);
      return owner ? [owner] : [];
    }
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
      return world.adHoc.get(historyKey(owner.repo, owner.branch)) === "handback"
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
  const found = owners.flatMap((owner) => holdBesides(owner, mine, world) ?? []);
  const hold = found.find((entry) => entry.failed) ?? found[0];
  return hold ? { kind: "kept", token, hold } : { kind: "reap", token };
}

export function judge(artifact: Artifact, base: Base, world: World): Verdict {
  const owners = ownersOf(artifact, base, world);
  if (base.mine) return judgeMine(owners, base.mine, world);

  const scoped = owners.filter((owner) => inScope(owner, base, world));
  if (scoped.length === 0) return { kind: "silent" };

  const token = ownerToken(scoped[0]!);
  const found = owners.flatMap((owner) => holdOf(owner, world) ?? []);
  const hold = found.find((entry) => entry.failed) ?? found[0];
  if (!hold) return { kind: "reap", token };

  return scoped.some((owner) => owner.kind !== "adhoc")
    ? { kind: "kept", token, hold }
    : { kind: "silent" };
}
