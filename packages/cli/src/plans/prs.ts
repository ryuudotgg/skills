import { ghOutput } from "../gh.ts";
import type { Io } from "../io.ts";

export type Pr = {
  number: number;
  state: "OPEN" | "MERGED" | "CLOSED";
  base: string;
  sha: string;
  head: string;
  title: string;
  ended: number;
  conflicting: boolean;
};

export type Merged = Pr & { state: "MERGED" };

const PR_FIELDS =
  "number,state,baseRefName,mergeCommit,headRefOid,title,isCrossRepository,mergedAt,closedAt,mergeable";

const PR_LIMIT = 200;

export function parsePr(entry: unknown): Pr | undefined {
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

export function prListArgs(branch: string): string[] {
  return [
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
  ];
}

export async function readPrs(
  branch: string,
  io: Io,
  gh: typeof ghOutput = ghOutput,
): Promise<Pr[] | string> {
  const output = await gh(prListArgs(branch), io);
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

export function ownPrs(prs: readonly Pr[], start: number | undefined): Pr[] {
  return prs.filter((pr) => pr.state === "OPEN" || start === undefined || pr.ended > start);
}

export function isMerged(pr: Pr): pr is Merged {
  return pr.state === "MERGED";
}

export function latestMerge(prs: readonly Pr[], trunk: string): Merged | undefined {
  return prs
    .filter((pr): pr is Merged => isMerged(pr) && pr.base === trunk)
    .sort((left, right) => right.ended - left.ended)[0];
}

export type ReadPrs = (branch: string) => Promise<Pr[] | string>;

export type Landing =
  | { kind: "landed"; pr: Merged; landing: Merged }
  | { kind: "stranded" }
  | { kind: "unreadable"; reason: string };

type Top = Merged | undefined | { reason: string };
type Walk = { trunk: string; read: ReadPrs; seen: Map<string, Promise<Top>> };

export function landing(merges: readonly Merged[], trunk: string, read: ReadPrs): Promise<Landing> {
  return bestOf(merges, { trunk, read, seen: new Map() }, new Set());
}

async function bestOf(
  merges: readonly Merged[],
  walk: Walk,
  path: ReadonlySet<string>,
): Promise<Landing> {
  let best: Landing = { kind: "stranded" };
  for (const pr of merges) {
    const top = await climb(pr, walk, path);
    if (top && "reason" in top) return { kind: "unreadable", reason: top.reason };
    if (top && (best.kind !== "landed" || top.ended > best.landing.ended))
      best = { kind: "landed", pr, landing: top };
  }

  return best;
}

function climb(merge: Merged, walk: Walk, path: ReadonlySet<string>): Promise<Top> {
  if (merge.base === walk.trunk) return Promise.resolve(merge);
  if (!merge.base || path.has(merge.base)) return Promise.resolve(undefined);

  const key = `${merge.base}\n${merge.ended}`;
  const known = walk.seen.get(key);
  if (known) return known;

  const found = above(merge, walk, new Set(path).add(merge.base));
  walk.seen.set(key, found);
  return found;
}

async function above(merge: Merged, walk: Walk, path: ReadonlySet<string>): Promise<Top> {
  const prs = await walk.read(merge.base);
  if (typeof prs === "string") return { reason: `cannot read PRs for ${merge.base}: ${prs}` };

  const hops = prs.filter((pr): pr is Merged => isMerged(pr) && pr.ended >= merge.ended);
  const found = await bestOf(hops, walk, path);
  if (found.kind === "unreadable") return { reason: found.reason };

  return found.kind === "landed" ? found.landing : undefined;
}

export function memoReads(io: Io): ReadPrs {
  const reads = new Map<string, Promise<Pr[] | string>>();
  return (branch) => {
    const known = reads.get(branch);
    if (known) return known;

    const read = readPrs(branch, io);
    reads.set(branch, read);
    return read;
  };
}

export function pushedHead(prs: readonly Pr[], trunk: string): string | undefined {
  const newest = prs.toSorted((left, right) => right.number - left.number)[0];
  return (latestMerge(prs, trunk) ?? newest)?.head || undefined;
}
