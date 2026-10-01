import { readFileSync } from "node:fs";

export type IndexRow = {
  id: string;
  slug: string;
  status: string;
  pri: string;
  effort: string;
  blocked_by: string;
  ctx: string;
  branch: string;
  updated: string;
  note: string;
};

export function readIndex(path: string, includeHeader = false): IndexRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();

  return lines.slice(includeHeader ? 0 : 1).map((line) => {
    const [
      id = "",
      slug = "",
      status = "",
      pri = "",
      effort = "",
      blocked_by = "",
      ctx = "",
      branch = "",
      updated = "",
      note = "",
    ] = line.split("\t");

    return { id, slug, status, pri, effort, blocked_by, ctx, branch, updated, note };
  });
}
