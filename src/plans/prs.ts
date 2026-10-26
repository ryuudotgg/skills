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

export async function readPrs(branch: string, io: Io): Promise<Pr[] | string> {
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

export function latestMerge(prs: readonly Pr[], trunk: string): Merged | undefined {
  return prs
    .filter((pr): pr is Merged => pr.state === "MERGED" && pr.base === trunk)
    .sort((left, right) => right.ended - left.ended)[0];
}
