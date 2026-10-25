import { ids } from "./frontier.ts";
import type { IndexRow } from "./index-tsv.ts";

export type Left =
  | { id: string; kind: "effort"; effort: string }
  | { id: string; kind: "waits"; on: string; status: string }
  | { id: string; kind: "cycle" };

export type Batch = { members: IndexRow[]; left: Left[] };

const BATCH_EFFORTS = new Set(["XS", "S"]);
const CLOSED = new Set(["DONE", "DROPPED"]);

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
  }
}

function byPriority(left: IndexRow, right: IndexRow): number {
  if (left.pri !== right.pri) return left.pri < right.pri ? -1 : 1;
  return Number(left.id) - Number(right.id);
}

export function selectBatch(rows: readonly IndexRow[], ctx: string): Batch {
  const status = new Map(rows.map((row) => [row.id, row.status]));
  const todo = rows.filter((row) => row.ctx === ctx && row.status === "TODO");
  const left: Left[] = todo
    .filter((row) => !BATCH_EFFORTS.has(row.effort))
    .map((row) => ({ id: row.id, kind: "effort", effort: row.effort }));

  const inside = new Map(
    todo.filter((row) => BATCH_EFFORTS.has(row.effort)).map((row) => [row.id, row]),
  );

  for (let changed = true; changed;) {
    changed = false;

    for (const row of inside.values()) {
      const outside = ids(row.blocked_by).find(
        (id) => !inside.has(id) && !CLOSED.has(status.get(id) ?? ""),
      );

      if (outside === undefined) continue;

      inside.delete(row.id);
      left.push({
        id: row.id,
        kind: "waits",
        on: outside,
        status: status.get(outside) ?? "missing",
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
      .filter((row) => ids(row.blocked_by).every((id) => !inside.has(id) || placed.has(id)))
      .sort(byPriority)[0];

    if (!next) return ordered;

    ordered.push(next);
    placed.add(next.id);
  }
}
