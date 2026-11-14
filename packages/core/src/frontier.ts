import { blockerState, localIds, parseBlockers, type BlockerRef, type World } from "./blockers.ts";
import { foldRows, type PlanEvent } from "./events.ts";
import { foldIssues, inInbox, issueRef, issuesByRef, type Issue } from "./issues.ts";
import type { IndexRow } from "./rows.ts";

export type Ready = { row: IndexRow; stacksOn?: string };
export type Held = { row: IndexRow; blockers: string[]; twoStacks: boolean };
export type Frontier = {
  ready: Ready[];
  held: Held[];
  blocked: IndexRow[];
  review: IndexRow[];
  doing: IndexRow[];
};

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

  const result: Frontier = { ready: [], held: [], blocked: [], review: [], doing: [] };
  for (const row of rows) {
    if (row.status === "BLOCKED") result.blocked.push(row);
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
  marks: ReadonlyMap<string, string> = new Map(),
): string {
  const { ready, held, blocked, review, doing } = frontier(rows, world);
  const mark = (id: string, gap = "  ") => {
    const found = marks.get(id);
    return found === undefined ? "" : `${gap}${found}`;
  };

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
      `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.effort, 3)} ${pad(row.slug.slice(0, 34), 34)} ${note}${words.length > 0 ? `  needs ${words.join(",")}` : ""}${mark(row.id)}`,
    );
  }

  if (held.length + blocked.length > 0) {
    lines.push("", `BLOCKED ${held.length + blocked.length}`);

    for (const { row, blockers, twoStacks } of held)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} waits on ${blockers.join(",")}${twoStacks ? " (two stacks)" : ""}${mark(row.id)}`,
      );

    for (const row of blocked)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} ${row.branch} ${row.note}${mark(row.id)}`,
      );
  }

  if (review.length > 0) {
    lines.push("", `REVIEW ${review.length}`);

    for (const row of review)
      lines.push(
        `${pad(row.id, 4)} ${pad(row.pri, 3)} ${pad(row.slug.slice(0, 34), 34)} ${row.branch}${mark(row.id)}`,
      );
  }

  if (doing.length > 0)
    lines.push(
      "",
      `DOING ${doing.map((row) => `${row.id} ${row.slug} ${row.branch}${mark(row.id, " ")}`).join(", ")}`,
    );

  return `${lines.join("\n")}\n`;
}

export function next(
  rows: readonly IndexRow[],
  world: World,
  needs: PlanNeeds = new Map(),
  marks: ReadonlyMap<string, string> = new Map(),
): string | undefined {
  return frontier(rows, world).ready.find(
    ({ row }) => needs.get(row.id)?.met !== false && !marks.has(row.id),
  )?.row.id;
}

export function stacksOn(rows: readonly IndexRow[], id: string, world: World): string[] {
  return frontier(rows, world)
    .ready.filter((entry) => entry.stacksOn === id)
    .map((entry) => entry.row.id);
}

export type ProjectFrontier = Frontier & { project: string; inbox: Issue[] };

export type GraphNode = {
  key: string;
  kind: "plan" | "issue";
  project: string;
  id: string;
  label: string;
  status: string;
  column: number;
  row: number;
};

export type GraphEdge = { from: string; to: string };

export type Frontiers = { projects: ProjectFrontier[]; nodes: GraphNode[]; edges: GraphEdge[] };

type Vertex = Omit<GraphNode, "column" | "row"> & { rank: number; number: number };

const PRIORITIES = ["P0", "P1", "P2", "P3"];
function rankOf(pri: string): number {
  const rank = PRIORITIES.indexOf(pri);
  return rank === -1 ? PRIORITIES.length : rank;
}

function compareVertices(left: Vertex, right: Vertex): number {
  if (left.rank !== right.rank) return left.rank - right.rank;
  if (left.project !== right.project) return left.project < right.project ? -1 : 1;
  if (left.number !== right.number) return left.number - right.number;

  return left.key < right.key ? -1 : left.key > right.key ? 1 : 0;
}

function blockerKey(project: string, ref: BlockerRef): string | undefined {
  if (ref.kind === "local") return `${project}/${ref.id}`;
  return ref.kind === "bad" ? undefined : ref.text;
}

function planVertex(project: string, row: IndexRow): Vertex {
  return {
    key: `${project}/${row.id}`,
    kind: "plan",
    project,
    id: row.id,
    label: `${project} ${row.id} ${row.slug}`,
    status: row.status,
    rank: rankOf(row.pri),
    number: Number(row.id),
  };
}

function issueVertex(issue: Issue): Vertex {
  const key = issueRef(issue);
  return {
    key,
    kind: "issue",
    project: issue.project,
    id: String(issue.n),
    label: `${key} ${issue.title}`,
    status: "open",
    rank: PRIORITIES.length + 1,
    number: issue.n,
  };
}

function depths(
  keys: readonly string[],
  below: ReadonlyMap<string, string[]>,
): Map<string, number> {
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (key: string): number => {
    const known = depth.get(key);
    if (known !== undefined) return known;
    if (visiting.has(key)) return -1;

    visiting.add(key);
    const deepest = Math.max(-1, ...(below.get(key) ?? []).map(visit));
    visiting.delete(key);

    depth.set(key, deepest + 1);
    return deepest + 1;
  };

  for (const key of keys) visit(key);
  return depth;
}

function graph(world: World, open: readonly Issue[]): Pick<Frontiers, "nodes" | "edges"> {
  const { projects } = world;
  const vertices = [
    ...[...projects].flatMap(([project, rows]) => rows.map((row) => planVertex(project, row))),
    ...open.map(issueVertex),
  ].sort(compareVertices);

  const known = new Set(vertices.map((vertex) => vertex.key));
  const below = new Map<string, string[]>();
  const edges: GraphEdge[] = [];
  for (const [project, rows] of projects)
    for (const row of rows) {
      const to = `${project}/${row.id}`;
      for (const ref of parseBlockers(row.blocked_by)) {
        if (blockerState(ref, rows, world).kind === "released") continue;

        const from = blockerKey(project, ref);
        if (from === undefined || !known.has(from) || below.get(to)?.includes(from)) continue;

        edges.push({ from, to });
        below.set(to, [...(below.get(to) ?? []), from]);
      }
    }

  const depth = depths(
    vertices.map((vertex) => vertex.key),
    below,
  );

  const filled = new Map<number, number>();
  const nodes = vertices.map(({ rank: _rank, number: _number, ...vertex }) => {
    const column = depth.get(vertex.key) ?? 0;
    const row = filled.get(column) ?? 0;

    filled.set(column, row + 1);
    return { ...vertex, column, row };
  });

  return { nodes, edges };
}

export function frontiers(events: Iterable<PlanEvent>): Frontiers {
  const list = [...events];
  const projects = new Map(
    [...foldRows(list)].map(([project, rows]) => [project, [...rows.values()]] as const),
  );

  const issues = foldIssues(list);
  const open = issues.filter((issue) => issue.state.kind === "open");
  const inbox = issues.filter(inInbox);
  const world: World = { projects, issues: issuesByRef(issues) };
  const names = [...new Set([...projects.keys(), ...inbox.map((issue) => issue.project)])].sort();
  return {
    projects: names.map((project) => ({
      project,
      ...frontier(projects.get(project) ?? [], world),
      inbox: inbox.filter((issue) => issue.project === project),
    })),
    ...graph(world, open),
  };
}
