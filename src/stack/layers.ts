import { readFileSync } from "node:fs";
import { defaultBranch } from "../publish/commit.ts";
import { apply, checkIdle, git, plan, push, Refusal, refuse, type Move, type Session } from "./restack.ts";

export async function ok(s: Session, args: readonly string[]): Promise<boolean> {
  return (await git(s, args, { stderr: "ignore" })).code === 0;
}

export async function trunk(s: Session): Promise<string> {
  return await defaultBranch(s.cwd) ?? "";
}

export function indexRows(index: string): string[][] {
  return readFileSync(index, "utf8").split("\n").slice(1).map((line) => line.split("\t"));
}

export async function findLayers(s: Session, branch: string, index: string): Promise<string[]> {
  const rows = indexRows(index);
  const owned = new Set(rows.map((fields) => fields[7]).filter((name) => name && name !== "-"));
  const local = (await git(s, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])).stdout.split("\n").filter(Boolean);
  const config = await git(s, ["config", "-z", "--get-regexp", "^branch\\..*\\.skills-base$"], { stderr: "ignore" });
  const bases = new Map(config.stdout.split("\0").filter(Boolean).map((record) => {
    const split = record.indexOf("\n");
    return [record.slice(7, split - ".skills-base".length), record.slice(split + 1)];
  }));

  const layers: string[] = [];
  const visited = new Set([branch]);
  let parent = branch;
  while (true) {
    const children = local.filter((candidate) => bases.get(candidate) === parent);
    const [first, second] = children;
    if (second) refuse(`two layers above ${parent}: ${first} ${second}`);
    if (!first) break;
    if (!owned.has(first)) refuse(`${first} above ${branch} is not an owned branch`);
    if (visited.has(first)) refuse(`cycle in recorded bases at ${first}`);

    visited.add(first);
    layers.push(first);
    parent = first;
  }

  for (const layer of layers) {
    const doing = rows.find((fields) => fields[2] === "DOING" && fields[7] === layer)?.[0];
    if (doing) refuse(`row ${doing} is DOING on ${layer}`);

    await checkIdle(s, layer);
  }

  return layers;
}

export async function remote(s: Session, branch: string): Promise<boolean> {
  const listed = await git(s, ["ls-remote", "--exit-code", "--heads", "origin", branch], { stderr: "ignore" });
  if (listed.code === 0) return true;
  if (listed.code === 2) return false;

  return refuse(`cannot read origin/${branch}`);
}

export async function readOrigin(s: Session, layers: readonly string[]): Promise<Map<string, string>> {
  const leases = new Map<string, string>();
  for (const layer of layers) {
    const local = (await git(s, ["rev-parse", `refs/heads/${layer}`])).stdout.trimEnd();
    if (!await remote(s, layer)) continue;

    const fetched = await git(s, ["fetch", "--quiet", "origin", `+refs/heads/${layer}:refs/remotes/origin/${layer}`], { stdoutToStderr: true });
    if (fetched.code !== 0) refuse(`cannot fetch origin/${layer}`);

    const tip = (await git(s, ["rev-parse", `refs/remotes/origin/${layer}`])).stdout.trimEnd();
    if (tip !== local) refuse(`origin/${layer} differs from ${layer}, sync it first`);

    leases.set(layer, tip);
  }

  return leases;
}

export function completedLines(completed: readonly Move[], exists: ReadonlyMap<string, string>): string[] {
  return completed.map(({ branch }) => exists.has(branch)
    ? `rebased ${branch} and pushed`
    : `rebased ${branch} (not on origin, not pushed)`);
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
  const suffix = prefix === "fix-round"
    ? `the round is pushed on ${branch}, every layer above it is untouched`
    : `${branch} is pushed, every layer above it is untouched`;

  let planned;
  let pushed;
  try {
    planned = await plan(s, branch, parentOld, layers);
    if (planned.kind === "conflict") refuse(planned.reason);

    pushed = await push(s, planned.moves, leases);
    if (!pushed) refuse("lease push rejected");
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refuse(`${error.message}, ${suffix}`);
  }

  const applied = await apply(s, planned.moves, pushed, leases, prefix);
  process.stdout.write([...output, ...completedLines(applied.completed, leases)].join("\n") + "\n");
  if (applied.error) refuse(applied.error);

  return 0;
}
