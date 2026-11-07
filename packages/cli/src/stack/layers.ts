import { type IndexRow } from "skills-core";
import type { Io } from "../io.ts";
import { indexPath, missingIndex } from "../plans/index-tsv.ts";
import type { PlansIndex } from "../plans/projection.ts";
import { asciiLower, checkoutIs, defaultBranch, readCheckout } from "../project.ts";
import {
  apply,
  checkIdle,
  git,
  plan,
  push,
  read,
  readPlans,
  Refusal,
  refuse,
  UnknownOutcome,
  type Move,
  type Session,
} from "./restack.ts";
import { ownedKey, recordedBases } from "./skills-base.ts";

export async function trunk(s: Session): Promise<string> {
  const result = await defaultBranch(s.cwd, s);
  return result.ok ? result.branch : "";
}

type Indexes = { indexes: PlansIndex[]; owners?: PlansIndex[] };

export async function projectIndexes(project: string | undefined, io: Io): Promise<Indexes> {
  if (project === undefined) {
    const indexes = await readPlans(io.env);
    const { candidates } = await readCheckout(io.cwd, false, io);
    const owner = candidates
      .map((candidate) =>
        indexes.find((index) => asciiLower(index.project) === asciiLower(candidate)),
      )
      .find(Boolean);

    return { indexes, owners: owner ? [owner] : [] };
  }

  const checkout = await checkoutIs(io.cwd, project, io);
  if (checkout) refuse(checkout);

  try {
    indexPath(project, io.env);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  const indexes = await readPlans(io.env);
  const exact = indexes.filter((index) => index.project === project);
  if (exact.length) return { indexes: exact };

  const folded = indexes.filter((index) => asciiLower(index.project) === asciiLower(project));
  return { indexes: folded.length === 1 ? folded : [] };
}

export function requireIndex(project: string | undefined, indexes: readonly PlansIndex[]): void {
  if (project !== undefined && indexes.length === 0) refuse(missingIndex(project));
}

function indexRows(indexes: readonly PlansIndex[]): IndexRow[] {
  return indexes.flatMap((index) => index.rows);
}

export async function owned(s: Session, branch: string): Promise<boolean> {
  if (indexRows(s.owners ?? s.indexes).some((row) => row.branch === branch)) return true;
  if (!s.owners) return false;
  return marked(s, branch);
}

export async function marked(s: Session, branch: string): Promise<boolean> {
  const key = ownedKey(branch);
  const mark = await read(s, ["config", "--get", key], `cannot read ${key}`, [0, 1]);
  return mark.stdout.trim() === "true";
}

export async function findLayers(s: Session, branch: string): Promise<string[]> {
  const rows = indexRows(s.indexes);
  const local = (
    await read(
      s,
      ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
      `cannot read local branches above ${branch}`,
    )
  ).stdout
    .split("\n")
    .filter(Boolean);

  const config = await recordedBases(s.cwd, s);
  if (!config.ok) refuse(`${config.reason} for ${branch}`);

  const bases = config.bases;

  const layers: string[] = [];
  const visited = new Set([branch]);

  let parent = branch;
  while (true) {
    const children = local.filter((candidate) => bases.get(candidate) === parent);

    const [first, second] = children;
    if (second) refuse(`two layers above ${parent}: ${first} ${second}`);
    if (!first) break;
    if (!(await owned(s, first))) refuse(`${first} above ${branch} is not an owned branch`);
    if (visited.has(first)) refuse(`cycle in recorded bases at ${first}`);

    visited.add(first);
    layers.push(first);
    parent = first;
  }

  for (const layer of layers) {
    const doing = rows.find((row) => row.status === "DOING" && row.branch === layer)?.id;
    if (doing && !s.ownRows.has(layer)) refuse(`row ${doing} is DOING on ${layer}`);
    await checkIdle(s, layer);
  }

  return layers;
}

export async function remote(s: Session, branch: string): Promise<boolean> {
  const listed = await git(s, ["ls-remote", "--exit-code", "--heads", "origin", branch], {
    stderr: "ignore",
  });

  if (listed.code === 0) return true;
  if (listed.code === 2) return false;

  return refuse(`cannot read origin/${branch}`);
}

export async function readOrigin(
  s: Session,
  layers: readonly string[],
): Promise<Map<string, string>> {
  const leases = new Map<string, string>();
  for (const layer of layers) {
    const local = (
      await read(s, ["rev-parse", `refs/heads/${layer}`], `cannot read the tip of ${layer}`)
    ).stdout.trimEnd();

    if (!(await remote(s, layer))) continue;

    const fetched = await git(
      s,
      ["fetch", "--quiet", "origin", `+refs/heads/${layer}:refs/remotes/origin/${layer}`],
      { stdoutToStderr: true },
    );

    if (fetched.code !== 0) refuse(`cannot fetch origin/${layer}`);

    const tip = (
      await read(
        s,
        ["rev-parse", `refs/remotes/origin/${layer}`],
        `cannot read the tip of origin/${layer}`,
      )
    ).stdout.trimEnd();

    if (tip !== local) refuse(`origin/${layer} differs from ${layer}, sync it first`);

    leases.set(layer, tip);
  }

  return leases;
}

export function completedLines(
  completed: readonly Move[],
  exists: ReadonlyMap<string, string>,
): string[] {
  return completed.map(({ branch }) =>
    exists.has(branch)
      ? `rebased ${branch} and pushed`
      : `rebased ${branch} (not on origin, not pushed)`,
  );
}

export async function restackLayers(
  s: Session,
  branch: string,
  parentOld: string,
  layers: readonly string[],
  leases: ReadonlyMap<string, string>,
  prefix: "fix-round" | "restack-layer",
  output: readonly string[],
): Promise<number> {
  const suffix =
    prefix === "fix-round" ? `the round is pushed on ${branch}` : `${branch} is pushed`;

  let planned;
  let pushed;
  try {
    planned = await plan(s, branch, parentOld, layers);
    if (planned.kind === "conflict") refuse(planned.reason);

    pushed = await push(s, planned.moves, leases);
    if (!pushed) refuse("lease push rejected");
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;

    refuse(
      `${error.message}, ${suffix}${error instanceof UnknownOutcome ? "" : ", every layer above it is untouched"}`,
    );
  }

  const applied = await apply(s, planned.moves, pushed, leases, prefix);
  s.out([...output, ...completedLines(applied.completed, leases)].join("\n") + "\n");
  if (applied.error) refuse(applied.error);

  return 0;
}
