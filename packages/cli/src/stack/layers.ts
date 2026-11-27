import { type IndexRow } from "skills-core";
import type { Io } from "../io.ts";
import { indexPath, missingIndex } from "../plans/index-tsv.ts";
import type { PlansIndex } from "../plans/projection.ts";
import { answersAmong, asciiLower, checkoutIs, defaultBranch, readCheckout } from "../project.ts";
import {
  ancestor,
  apply,
  checkIdle,
  dropTopLayerFirst,
  fetchRemoteTip,
  git,
  plan,
  push,
  read,
  readPlans,
  recordedMoves,
  requireReplay,
  Refusal,
  refuse,
  UnknownOutcome,
  type Applied,
  type Move,
  type Recorded,
  type Session,
} from "./restack.ts";
import { moveKey, ownedKey, recordedBases } from "./skills-base.ts";

export async function trunk(s: Session): Promise<string> {
  const result = await defaultBranch(s.cwd, s);
  return result.ok ? result.branch : "";
}

type Indexes = { indexes: PlansIndex[]; owners?: PlansIndex[] };

export async function projectIndexes(project: string | undefined, io: Io): Promise<Indexes> {
  if (project === undefined) {
    const indexes = await readPlans(io.env);
    const { names } = await readCheckout(io.cwd, false, io);
    const [answer] = answersAmong(
      names,
      indexes.map((index) => index.project),
    );

    const owner = indexes.find((index) => index.project === answer?.project);
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

export function refuseDoing(s: Session, layer: string): void {
  if (s.ownRows.has(layer)) return;

  const doing = indexRows(s.indexes).find(
    (row) => row.status === "DOING" && row.branch === layer,
  )?.id;

  if (doing) refuse(`row ${doing} is DOING on ${layer}`);
}

export async function findLayers(
  s: Session,
  branch: string,
  defaultBranch: string,
): Promise<string[]> {
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

  if (layers.includes(defaultBranch)) refuse(`cannot rebase the default branch ${defaultBranch}`);

  for (const layer of layers) {
    refuseDoing(s, layer);
    await checkIdle(s, layer);
  }

  return layers;
}

export async function remote(s: Session, branch: string): Promise<boolean> {
  const ref = `refs/heads/${branch}`;
  const listed = await git(s, ["ls-remote", "--exit-code", "origin", ref], { stderr: "ignore" });
  if (listed.code === 0) return listed.stdout.split("\n").some((line) => line.endsWith(`\t${ref}`));
  if (listed.code === 2) return false;

  return refuse(`cannot read origin/${branch}`);
}

export type Replan = { parent: string; cutoff: string; layers: string[] };
type Resumed = Applied & { published: ReadonlySet<string>; recorded: string; replan?: Replan };
type Read = { move: Recorded; local: string; origin: string | undefined };
type State = "owed" | "done" | "abandoned";

const AFTER: Record<State | "start", readonly State[]> = {
  start: ["done", "owed", "abandoned"],
  done: ["done", "owed", "abandoned"],
  owed: ["owed"],
  abandoned: ["abandoned"],
};

function stateOf(move: Recorded, local: string, origin: string): State | undefined {
  if (local === move.old && origin === move.next) return "owed";
  if (local === move.next && origin === move.next) return "done";
  if (local === move.old && origin === (move.lease ?? move.old)) return "abandoned";
}

function unfinished(move: Recorded): string {
  return `${move.branch} has an unfinished restack from ${move.old} to ${move.next}`;
}

export async function resume(
  s: Session,
  layers: readonly string[],
  below: string,
  prefix: string,
): Promise<Resumed | undefined> {
  const records = await recordedMoves(s);
  const unparsed = [below, ...layers].find((branch) => records.get(branch) === null);
  if (unparsed) refuse(`cannot parse ${moveKey(unparsed)}`);

  const own = records.get(below);
  if (own)
    refuse(`${unfinished(own)}, finish it first with a rerun of the command that recorded it`);

  const states = new Map<State, Recorded[]>([
    ["owed", []],
    ["done", []],
    ["abandoned", []],
  ]);

  const published = new Set<string>();
  const reads: Read[] = [];
  for (const layer of layers) {
    const move = records.get(layer);
    if (!move) continue;

    const local = (
      await read(s, ["rev-parse", `refs/heads/${layer}`], `cannot read the tip of ${layer}`)
    ).stdout.trimEnd();

    const onOrigin = await remote(s, layer);
    if (onOrigin) published.add(layer);

    reads.push({ move, local, origin: onOrigin ? await fetchRemoteTip(s, layer) : undefined });
  }

  const neverLanded = reads.some(
    ({ move, origin }) => move.lease && origin === move.lease && origin !== move.next,
  );

  let last: State | "start" = "start";
  for (const { move, local, origin } of reads) {
    const standIn = neverLanded ? move.old : move.next;
    const state = stateOf(move, local, origin ?? (move.lease ? "" : standIn));
    if (!state || !AFTER[last].includes(state))
      refuse(
        `${unfinished(move)} that does not fit ${move.branch} at ${local} and origin/${move.branch} ${origin ? `at ${origin}` : "missing"}, check both, then drop the record with git config --unset ${moveKey(move.branch)}`,
      );

    states.get(state)!.push(move);
    last = state;
  }

  const recorded = reads[0]?.move.parentOld ?? "";

  const done = states.get("done")!;
  const owed = states.get("owed")!;
  const abandoned = states.get("abandoned")!;
  const [lowest] = abandoned;

  const kept = await dropTopLayerFirst(s, done);
  if (kept.length) refuse(`cannot drop ${kept.join(" ")}`);

  if (lowest) {
    const index = layers.indexOf(lowest.branch);
    const parent = index > 0 ? layers[index - 1]! : below;
    const replan = { parent, cutoff: lowest.parentOld, layers: layers.slice(index) };
    return { completed: done, published, recorded, replan };
  }

  if (!owed.length && !done.length) return undefined;

  const applied = await apply(s, owed, [], new Map(), prefix);
  return { ...applied, completed: [...done, ...applied.completed], published, recorded };
}

export async function resumeAbove(
  s: Session,
  branch: string,
  layers: readonly string[],
  prefix: "fix-round" | "restack-layer",
): Promise<{ resumed: Move[]; recorded?: string; replan?: Replan }> {
  const resumed = await resume(s, layers, branch, prefix);
  if (!resumed) return { resumed: [] };

  const lines = completedLines(resumed.completed, resumed.published);
  if (lines.length) s.out(lines.join("\n") + "\n");
  if (resumed.error) refuse(resumed.error);

  return { resumed: resumed.completed, recorded: resumed.recorded, replan: resumed.replan };
}

export async function restackSuffix(
  s: Session,
  branch: string,
  replan: Replan | undefined,
  leases: ReadonlyMap<string, string>,
  prefix: "fix-round" | "restack-layer",
): Promise<boolean> {
  if (!replan || replan.parent === branch) return false;

  await requireReplay(s);
  await restackLayers(s, branch, replan.cutoff, replan.layers, leases, prefix, [], replan.parent);
  return true;
}

export async function requireStacked(
  s: Session,
  parent: string,
  layers: readonly string[],
): Promise<void> {
  const left: string[] = [];

  let below = parent;
  for (const layer of layers) {
    const ref = `refs/heads/${layer}`;
    if (!(await ancestor(s, below, ref, `cannot read whether ${below} is an ancestor of ${layer}`)))
      left.push(`${layer} lacks ${below.replace(/^refs\/heads\//, "")}`);

    below = ref;
  }

  if (left.length) refuse(`after the recorded restack, ${left.join(", ")}`);
}

export async function recordsAbove(s: Session, branch: string): Promise<boolean> {
  const records = await recordedMoves(s);
  if (!records.size) return false;

  const config = await recordedBases(s.cwd, s);
  if (!config.ok) refuse(`${config.reason} for ${branch}`);

  for (const start of records.keys()) {
    const seen = new Set<string>();
    for (let at = config.bases.get(start); at && !seen.has(at); at = config.bases.get(at)) {
      if (at === branch) return true;
      seen.add(at);
    }
  }

  return false;
}

export async function readOrigin(
  s: Session,
  branch: string,
  layers: readonly string[],
  prefix: "fix-round" | "restack-layer",
): Promise<{ leases: Map<string, string>; resumed: Move[]; recorded?: string; replan?: Replan }> {
  const { resumed, recorded, replan } = await resumeAbove(s, branch, layers, prefix);

  const leases = new Map<string, string>();
  for (const layer of layers) {
    const local = (
      await read(s, ["rev-parse", `refs/heads/${layer}`], `cannot read the tip of ${layer}`)
    ).stdout.trimEnd();

    if (!(await remote(s, layer))) continue;

    const tip = await fetchRemoteTip(s, layer);
    if (tip !== local) refuse(`origin/${layer} differs from ${layer}, sync it first`);

    leases.set(layer, tip);
  }

  return { leases, resumed, recorded, replan };
}

export function completedLines(
  completed: readonly Move[],
  exists: Pick<ReadonlySet<string>, "has">,
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
  from = branch,
): Promise<number> {
  const suffix =
    prefix === "fix-round" ? `the round is pushed on ${branch}` : `${branch} is pushed`;

  let planned;
  let pushed;
  try {
    planned = await plan(s, from, parentOld, layers);
    if (planned.kind === "conflict") refuse(planned.reason);

    pushed = await push(s, parentOld, planned.moves, leases);
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
