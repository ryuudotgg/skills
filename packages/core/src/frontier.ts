import { blockerState, localIds, parseBlockers, type World } from "./blockers.ts";
import type { IndexRow } from "./rows.ts";

export type Ready = { row: IndexRow; stacksOn?: string };
export type Held = { row: IndexRow; blockers: string[]; twoStacks: boolean };
export type Frontier = { ready: Ready[]; held: Held[]; review: IndexRow[]; doing: IndexRow[] };
export type PlanNeeds = ReadonlyMap<string, { needs: readonly string[]; met: boolean }>;

function descendsFrom(
  deps: Map<string, string>,
  layer: (id: string) => readonly string[],
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return false;

  const seen = new Set([descendant]);
  const queue = [descendant];
  for (let current = queue.pop(); current !== undefined; current = queue.pop())
    for (const parent of layer(current).flatMap((peer) => localIds(deps.get(peer) ?? ""))) {
      if (layer(parent).includes(ancestor)) return true;

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

export function frontier(rows: readonly IndexRow[], world: World): Frontier {
  const status = new Map(rows.map((row) => [row.id, row.status]));
  const deps = new Map(rows.map((row) => [row.id, row.blocked_by]));
  const branch = new Map(rows.map((row) => [row.id, row.branch]));
  const sameLayer = (one: string, other: string) =>
    branch.get(one) === branch.get(other) && (branch.get(one) ?? "-") !== "-";

  const layer = (id: string) => {
    const name = branch.get(id) ?? "-";
    return name === "-" ? [id] : rows.filter((row) => row.branch === name).map((row) => row.id);
  };

  const busy = new Set(
    rows.filter((row) => ["DOING", "BLOCKED"].includes(row.status)).map((row) => row.branch),
  );

  const result: Frontier = { ready: [], held: [], review: [], doing: [] };
  for (const row of rows) {
    if (row.status === "DOING") result.doing.push(row);
    if (row.status === "REVIEW") result.review.push(row);
    if (row.status !== "TODO") continue;

    const open = parseBlockers(row.blocked_by).filter(
      (ref) => blockerState(ref, rows, world).kind !== "released",
    );

    const blockers = open.map((ref) => ref.text);
    const reviewsOnly = open.every(
      (ref) =>
        ref.kind === "local" &&
        status.get(ref.id) === "REVIEW" &&
        !busy.has(branch.get(ref.id) ?? ""),
    );

    const stacksOn = reviewsOnly
      ? blockers.find((candidate, index) =>
          blockers.every(
            (other, position) =>
              position === index ||
              sameLayer(other, candidate) ||
              descendsFrom(deps, layer, other, candidate),
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
export function renderFrontier(
  rows: readonly IndexRow[],
  world: World,
  needs: PlanNeeds = new Map(),
): string {
  const { ready, held, review, doing } = frontier(rows, world);
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

    const words = needs.get(row.id)?.needs ?? [];
    lines.push(
      `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.effort, 3)} ${pad(row.slug.slice(0, 34), 34)} ${note}${words.length > 0 ? `  needs ${words.join(",")}` : ""}`,
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

export function next(
  rows: readonly IndexRow[],
  world: World,
  needs: PlanNeeds = new Map(),
): string | undefined {
  return frontier(rows, world).ready.find(({ row }) => needs.get(row.id)?.met !== false)?.row.id;
}

export function stacksOn(rows: readonly IndexRow[], id: string, world: World): string[] {
  return frontier(rows, world)
    .ready.filter((entry) => entry.stacksOn === id)
    .map((entry) => entry.row.id);
}
