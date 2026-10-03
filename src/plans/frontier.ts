import type { IndexRow } from "./index-tsv.ts";

export type Ready = { row: IndexRow; stacksOn?: string };
export type Held = { row: IndexRow; blockers: string[]; twoStacks: boolean };
export type Frontier = { ready: Ready[]; held: Held[]; review: IndexRow[]; doing: IndexRow[] };

function ids(list: string): string[] {
  return list
    .split(",")
    .map((id) => id.replace(/[ \t]/g, ""))
    .filter((id, index, all) => id !== "" && id !== "-" && all.indexOf(id) === index);
}

function descendsFrom(deps: Map<string, string>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return false;

  const seen = new Set([descendant]);
  const queue = [descendant];
  for (let current = queue.pop(); current !== undefined; current = queue.pop())
    for (const parent of ids(deps.get(current) ?? "")) {
      if (parent === ancestor) return true;

      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }

  return false;
}

function compareReady(left: Ready, right: Ready): number {
  for (const column of ["pri", "effort", "id"] as const)
    if (left.row[column] !== right.row[column])
      return left.row[column] < right.row[column] ? -1 : 1;

  return 0;
}

export function frontier(rows: readonly IndexRow[]): Frontier {
  const status = new Map(rows.map((row) => [row.id, row.status]));
  const deps = new Map(rows.map((row) => [row.id, row.blocked_by]));
  const result: Frontier = { ready: [], held: [], review: [], doing: [] };
  for (const row of rows) {
    if (row.status === "DOING") result.doing.push(row);
    if (row.status === "REVIEW") result.review.push(row);
    if (row.status !== "TODO") continue;

    const blockers = ids(row.blocked_by).filter((id) => {
      const state = status.get(id);
      return state !== "DONE" && state !== "DROPPED";
    });

    const reviewsOnly = blockers.every((id) => status.get(id) === "REVIEW");
    const stacksOn = reviewsOnly
      ? blockers.find((candidate, index) =>
          blockers.every(
            (other, position) => position === index || descendsFrom(deps, other, candidate),
          ),
        )
      : undefined;

    if (blockers.length === 0 || stacksOn !== undefined) result.ready.push({ row, stacksOn });
    else result.held.push({ row, blockers, twoStacks: reviewsOnly });
  }

  result.ready.sort(compareReady);
  return result;
}

const pad = (value: string, width: number) => value.padEnd(width);

export function renderFrontier(rows: readonly IndexRow[]): string {
  const { ready, held, review, doing } = frontier(rows);
  const blocked = rows.filter((row) => row.status === "BLOCKED");
  const branch = new Map(rows.map((row) => [row.id, row.branch]));
  const lines = [`READY ${ready.length}`];
  for (const { row, stacksOn } of ready) {
    const note =
      stacksOn !== undefined
        ? `stacks on ${stacksOn} (${branch.get(stacksOn) ?? ""})`
        : row.note.length > 52
          ? `${row.note.slice(0, 49)}...`
          : row.note;

    lines.push(
      `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.effort, 3)} ${pad(row.slug.slice(0, 34), 34)} ${note}`,
    );
  }

  if (held.length + blocked.length > 0) {
    lines.push("", `BLOCKED ${held.length + blocked.length}`);

    for (const { row, blockers, twoStacks } of held)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} waits on ${blockers.join(",")}${twoStacks ? " (two stacks)" : ""}`,
      );

    for (const row of blocked)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} ${row.branch} ${row.note}`,
      );
  }

  if (review.length > 0) {
    lines.push("", `REVIEW ${review.length}`);

    for (const row of review)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} ${row.branch}`,
      );
  }

  if (doing.length > 0)
    lines.push("", `DOING ${doing.map((row) => `${row.id} ${row.slug} ${row.branch}`).join(", ")}`);

  return `${lines.join("\n")}\n`;
}

export function next(rows: readonly IndexRow[]): string | undefined {
  return frontier(rows).ready[0]?.row.id;
}

export function stacksOn(rows: readonly IndexRow[], id: string): string[] {
  return frontier(rows)
    .ready.filter((entry) => entry.stacksOn === id)
    .map((entry) => entry.row.id);
}
