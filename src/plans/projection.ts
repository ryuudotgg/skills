import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openPlansStore, verifyRecordedViews } from "./commit.ts";
import { Refusal } from "./import.ts";
import {
  decodeUtf8,
  indexIn,
  indexPath,
  missingIndex,
  parseIndexText,
  plansDir,
  projectDir,
  type IndexRow,
} from "./index-tsv.ts";
import { indexedProjects, projectedRows, trailEntries, type Store } from "./store.ts";
import type { TrailEntry } from "./trail.ts";

export type PlansIndex = { project: string; index: string; rows: IndexRow[] };

export type Projection<T> =
  | { kind: "absent" }
  | { kind: "failed"; reason: string }
  | { kind: "read"; value: T };

export type Plans = {
  projects: ReadonlyMap<string, readonly IndexRow[]>;
  trail: readonly TrailEntry[];
};

export type PlansRead = { kind: "plans"; plans: Plans } | { kind: "failed"; reason: string };

export async function readStore<T>(
  root: string,
  read: (store: Store) => T,
): Promise<Projection<T>> {
  try {
    if (!statSync(root).isDirectory()) return { kind: "absent" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "failed", reason: `cannot read ${root}: ${code ?? String(error)}` };
  }

  try {
    const store = await openPlansStore(root);
    try {
      return { kind: "read", value: store.db.transaction(() => read(store)).deferred() };
    } finally {
      store.db.close();
    }
  } catch (error) {
    if (error instanceof Refusal) return { kind: "failed", reason: error.message };
    const reason = error instanceof Error ? error.message : String(error);
    return { kind: "failed", reason: `cannot read ${join(root, "plans.db")}: ${reason}` };
  }
}

export function plansIndexes(store: Store, root: string): PlansIndex[] {
  const rows = projectedRows(store);
  return indexedProjects(store).map((project) => ({
    project,
    index: indexIn(join(root, project)),
    rows: [...(rows.get(project)?.values() ?? [])],
  }));
}

function projectDirectories(root: string): string[] {
  return readdirSync(root)
    .filter((name) => !name.startsWith("."))
    .sort()
    .filter((name) => statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory());
}

function bootstrapped(root: string, name: string): boolean {
  try {
    return parseIndexText(decodeUtf8(readFileSync(indexIn(join(root, name))))).length === 0;
  } catch {
    return false;
  }
}

function project(store: Store, root: string): Plans {
  const rows = projectedRows(store);
  const recorded = new Set(indexedProjects(store));
  const projects = new Map<string, IndexRow[]>();
  for (const name of projectDirectories(root))
    if (recorded.has(name)) projects.set(name, [...(rows.get(name)?.values() ?? [])]);
    else if (bootstrapped(root, name)) projects.set(name, []);

  return { projects, trail: trailEntries(store) };
}

export async function readPlans(
  env: NodeJS.ProcessEnv = process.env,
  checked = false,
): Promise<PlansRead> {
  const root = plansDir(env);
  const read = await readStore(root, (store) => {
    if (checked) verifyRecordedViews(store, root);
    return project(store, root);
  });

  if (read.kind === "failed") return read;

  return {
    kind: "plans",
    plans: read.kind === "read" ? read.value : { projects: new Map(), trail: [] },
  };
}

export type ProjectRead =
  | { kind: "rows"; rows: IndexRow[] }
  | { kind: "absent" }
  | { kind: "failed"; reason: string };

export async function readProject(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRead> {
  projectDir(project, env);

  const read = await readPlans(env);
  if (read.kind === "failed") return read;

  const rows = read.plans.projects.get(project);
  return rows ? { kind: "rows", rows: [...rows] } : { kind: "absent" };
}

export async function writableIndex(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ index: string } | { refusal: string }> {
  const index = indexPath(project, env);
  const read = await readProject(project, env);
  if (read.kind === "failed") return { refusal: read.reason };
  if (read.kind === "absent") return { refusal: missingIndex(project) };

  return { index };
}
