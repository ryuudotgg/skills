import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { checkoutIs } from "../project.ts";
import { indexIn, projectDir, readIndexTolerant } from "./index-tsv.ts";
import { probePlan, withProbeTree } from "./wave.ts";

const PLAN_FILE = /^([0-9]{3})-.*\.md$/;

export type OverlapPlan = {
  id: string;
  blockedBy: readonly string[];
  added: boolean;
  probe: { ok: true; hits: readonly string[] } | { ok: false; reason: string };
};

export function frontmatterBlockers(markdown: string): string[] {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return [];

  for (const line of lines.slice(1)) {
    if (line === "---") return [];
    const value = /^blocked_by:(.*)$/.exec(line)?.[1];
    if (value !== undefined) return value.replace(/(^|[ \t])#.*$/, "").match(/[0-9]{3}/g) ?? [];
  }

  return [];
}

function ordered(plans: readonly OverlapPlan[]): (a: string, b: string) => boolean {
  const edges = new Map(plans.map((plan) => [plan.id, plan.blockedBy]));
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set<string>();
    const stack = [from];
    while (stack.length) {
      const id = stack.pop()!;
      if (id === to) return true;
      if (seen.has(id)) continue;

      seen.add(id);
      stack.push(...(edges.get(id) ?? []));
    }

    return false;
  };

  return (a, b) => reaches(a, b) || reaches(b, a);
}

export function findOverlaps(plans: readonly OverlapPlan[]): {
  overlaps: string[];
  unprobed: string[];
} {
  const overlaps: string[] = [];
  const sorted = [...plans].sort((a, b) => a.id.localeCompare(b.id));
  const isOrdered = ordered(sorted);
  for (const [index, first] of sorted.entries()) {
    if (!first.probe.ok) continue;

    for (const second of sorted.slice(index + 1)) {
      if (!second.probe.ok || (first.added && second.added)) continue;

      const theirs = new Set(second.probe.hits);
      const shared = first.probe.hits.find((path) => theirs.has(path));
      if (shared === undefined || isOrdered(first.id, second.id)) continue;

      overlaps.push(`overlap ${first.id} ${second.id} ${shared}`);
    }
  }

  const unprobed = sorted.flatMap((plan) =>
    plan.probe.ok ? [] : [`unprobed ${plan.id}: ${plan.probe.reason}`],
  );

  return { overlaps, unprobed };
}

function fileBlockers(path: string): string[] {
  try {
    return frontmatterBlockers(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

export async function overlapVerb(project: string, io: Io): Promise<number> {
  const refuse = (reason: string): number => {
    io.err(`lint: ${reason}\n`);
    return 1;
  };

  const mismatch = await checkoutIs(io.cwd, project, io);
  if (mismatch) return refuse(mismatch);

  const directory = projectDir(project, io.env);

  let names: string[];
  try {
    names = readdirSync(directory).filter((name) => PLAN_FILE.test(name));
  } catch {
    return refuse(`no plans directory ${directory}`);
  }

  const table = readIndexTolerant(indexIn(directory));
  if (table.kind === "failed") return refuse(`cannot read ${indexIn(directory)}`);

  const rows = new Map(
    table.kind === "rows" ? table.rows.map((row) => [`${row.id}-${row.slug}.md`, row]) : [],
  );

  const open = names
    .sort()
    .filter((name) => rows.get(name)?.status !== "DONE" && rows.get(name)?.status !== "DROPPED");

  const twin = open.find(
    (name, index) => index > 0 && open[index - 1]!.slice(0, 3) === name.slice(0, 3),
  );

  if (twin) return refuse(`two open plan files hold id ${twin.slice(0, 3)}`);

  if (open.every((name) => rows.has(name))) {
    io.out("ok\n");
    return 0;
  }

  return withProbeTree(io, refuse, async (tree) => {
    const plans: OverlapPlan[] = [];
    for (const name of open) {
      const row = rows.get(name);
      const path = join(directory, name);

      plans.push({
        id: name.slice(0, 3),
        blockedBy: row ? (row.blocked_by.match(/[0-9]{3}/g) ?? []) : fileBlockers(path),
        added: row !== undefined,
        probe: await probePlan(path, tree.root, io, tree.ripgrep),
      });
    }

    const { overlaps, unprobed } = findOverlaps(plans);
    const lines = [...overlaps, ...unprobed];
    io.out(lines.length ? `${lines.join("\n")}\n` : "ok\n");
    return overlaps.length ? 1 : 0;
  });
}
