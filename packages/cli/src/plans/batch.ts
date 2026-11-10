import {
  blockerState,
  describeState,
  type IndexRow,
  localIds,
  parseBlockers,
  type World,
} from "skills-core";
import { leftNeedsLine, type Unmet } from "./needs.ts";

export type Left =
  | { id: string; kind: "effort"; effort: string }
  | { id: string; kind: "waits"; on: string; status: string }
  | { id: string; kind: "cycle" }
  | { id: string; kind: "needs"; unmet: Unmet }
  | { id: string; kind: "held"; reason: string };

export type Batch = { members: IndexRow[]; left: Left[] };

const BATCH_EFFORTS = new Set(["XS", "S"]);

const CTX_PREFIX = "ctx-";

export function isCtxSlug(value: string): boolean {
  return /^ctx-[a-z0-9-]+$/.test(value);
}

export function batchBranch(ctx: string, attempt: number): string {
  const name = `feat/batch-${ctx.slice(CTX_PREFIX.length)}`;
  return attempt > 1 ? `${name}-${attempt}` : name;
}

export function isBatchBranch(ctx: string, branch: string): boolean {
  const name = batchBranch(ctx, 1);
  return (
    branch === name ||
    (branch.startsWith(`${name}-`) && /^[0-9]+$/.test(branch.slice(name.length + 1)))
  );
}

export function leftLine(left: Left): string {
  switch (left.kind) {
    case "effort":
      return `left ${left.id} effort ${left.effort}`;

    case "waits":
      return `left ${left.id} waits on ${left.on} ${left.status}`;

    case "cycle":
      return `left ${left.id} in or behind a blocker cycle`;

    case "needs":
      return leftNeedsLine(left.id, left.unmet);

    case "held":
      return `left ${left.id} ${left.reason}`;
  }
}

function byPriority(left: IndexRow, right: IndexRow): number {
  if (left.pri !== right.pri) return left.pri < right.pri ? -1 : 1;
  return Number(left.id) - Number(right.id);
}

export function batchRows(rows: readonly IndexRow[], ctx: string): IndexRow[] {
  return rows.filter((row) => row.ctx === ctx && row.status === "TODO");
}

export function selectBatch(
  rows: readonly IndexRow[],
  ctx: string,
  world: World,
  unmet: (id: string) => Unmet | undefined = () => undefined,
  held: (id: string) => string | undefined = () => undefined,
): Batch {
  const todo = batchRows(rows, ctx);
  const left: Left[] = todo
    .filter((row) => !BATCH_EFFORTS.has(row.effort))
    .map((row) => ({ id: row.id, kind: "effort", effort: row.effort }));

  const inside = new Map(
    todo.filter((row) => BATCH_EFFORTS.has(row.effort)).map((row) => [row.id, row]),
  );

  for (const id of inside.keys()) {
    const missing = unmet(id);
    if (!missing) continue;

    inside.delete(id);
    left.push({ id, kind: "needs", unmet: missing });
  }

  for (const id of inside.keys()) {
    const reason = held(id);
    if (reason === undefined) continue;

    inside.delete(id);
    left.push({ id, kind: "held", reason });
  }

  for (let changed = true; changed;) {
    changed = false;

    for (const row of inside.values()) {
      const outside = parseBlockers(row.blocked_by)
        .filter((ref) => ref.kind !== "local" || !inside.has(ref.id))
        .map((ref) => ({ ref, state: blockerState(ref, rows, world) }))
        .find(({ state }) => state.kind !== "released");

      if (outside === undefined) continue;

      inside.delete(row.id);
      left.push({
        id: row.id,
        kind: "waits",
        on: outside.ref.text,
        status: describeState(outside.state),
      });

      changed = true;
    }
  }

  const members = dependencyOrder([...inside.values()]);
  const placed = new Set(members.map((row) => row.id));
  for (const row of inside.values())
    if (!placed.has(row.id)) left.push({ id: row.id, kind: "cycle" });

  left.sort((one, other) => Number(one.id) - Number(other.id));
  return { members, left };
}

export function dependencyOrder(rows: readonly IndexRow[]): IndexRow[] {
  const inside = new Set(rows.map((row) => row.id));
  const ordered: IndexRow[] = [];
  const placed = new Set<string>();
  for (;;) {
    const next = rows
      .filter((row) => !placed.has(row.id))
      .filter((row) => localIds(row.blocked_by).every((id) => !inside.has(id) || placed.has(id)))
      .sort(byPriority)[0];

    if (!next) return ordered;

    ordered.push(next);
    placed.add(next.id);
  }
}
