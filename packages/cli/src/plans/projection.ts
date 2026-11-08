import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { type IndexRow, type TrailEntry, type World } from "skills-core";
import { verifyRecordedViews } from "./commit.ts";
import { importRoot, Refusal } from "./import.ts";
import {
  decodeUtf8,
  indexIn,
  indexPath,
  missingIndex,
  parseIndexText,
  plansDir,
  projectDir,
} from "./index-tsv.ts";
import {
  indexedProjects,
  openStore,
  projectedRows,
  projectSince,
  rowsUntil,
  trailEntries,
  type Store,
} from "./store.ts";

export type PlansIndex = { project: string; index: string; rows: IndexRow[] };

export type Failed = { kind: "failed"; reason: string; refused: boolean };

export type Projection<T> = { kind: "absent" } | Failed | { kind: "read"; value: T };

export type Plans = {
  projects: ReadonlyMap<string, readonly IndexRow[]>;
  unimported: ReadonlyMap<string, string>;
  trail: readonly TrailEntry[];
};

export type PlansRead = { kind: "plans"; plans: Plans } | Failed;

export async function readStore<T>(
  root: string,
  read: (store: Store) => T,
): Promise<Projection<T>> {
  try {
    if (!statSync(root).isDirectory()) return { kind: "absent" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return {
      kind: "failed",
      reason: `cannot read ${root}: ${code ?? String(error)}`,
      refused: false,
    };
  }

  try {
    if (!existsSync(join(root, "plans.db"))) await importRoot(root, true);

    const store = openStore(join(root, "plans.db"));
    try {
      return { kind: "read", value: store.db.transaction(() => read(store)).deferred() };
    } finally {
      store.db.close();
    }
  } catch (error) {
    if (error instanceof Refusal) return { kind: "failed", reason: error.message, refused: true };

    const reason = error instanceof Error ? error.message : String(error);
    return {
      kind: "failed",
      reason: `cannot read ${join(root, "plans.db")}: ${reason}`,
      refused: false,
    };
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

function unrecordedIndex(path: string): "none" | "empty" | "unimported" {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "none" : "unimported";
  }

  try {
    return parseIndexText(decodeUtf8(bytes)).length === 0 ? "empty" : "unimported";
  } catch {
    return "unimported";
  }
}

function notInStore(path: string): string {
  return `${path} is not in the store yet, run skills plans import`;
}

function project(store: Store, root: string, checked: boolean): Plans {
  const rows = projectedRows(store);
  const recorded = new Set(indexedProjects(store));
  const projects = new Map<string, IndexRow[]>();
  const unimported = new Map<string, string>();
  for (const name of projectDirectories(root)) {
    const index = indexIn(join(root, name));
    if (recorded.has(name)) projects.set(name, [...(rows.get(name)?.values() ?? [])]);
    else {
      const state = unrecordedIndex(index);
      if (state === "empty") projects.set(name, []);
      if (state === "unimported") unimported.set(name, index);
    }
  }

  const [first] = unimported.values();
  if (checked && first) throw new Refusal(notInStore(first));

  return { projects, unimported, trail: trailEntries(store) };
}

export async function readPlans(
  env: NodeJS.ProcessEnv = process.env,
  checked = false,
): Promise<PlansRead> {
  const root = plansDir(env);
  const read = await readStore(root, (store) => {
    if (checked) verifyRecordedViews(store, root);
    return project(store, root, checked);
  });

  if (read.kind === "failed") return read;

  return {
    kind: "plans",
    plans:
      read.kind === "read" ? read.value : { projects: new Map(), unimported: new Map(), trail: [] },
  };
}

export type ProjectRows = { kind: "rows"; rows: IndexRow[] } & World;

export type ProjectRead = ProjectRows | { kind: "absent" } | Failed;

export async function readProject(
  project: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectRead> {
  projectDir(project, env);

  const read = await readPlans(env);
  if (read.kind === "failed") return read;

  const unimported = read.plans.unimported.get(project);
  if (unimported) return { kind: "failed", reason: notInStore(unimported), refused: true };

  const { projects } = read.plans;
  const rows = projects.get(project);
  return rows ? { kind: "rows", rows: [...rows], projects } : { kind: "absent" };
}

export type ProjectReadAt = ProjectRead | { kind: "before"; since: number };

export async function readProjectAt(
  project: string,
  until: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProjectReadAt> {
  const now = await readProject(project, env);
  if (now.kind !== "rows") return now;

  const read = await readStore(plansDir(env), (store): ProjectReadAt => {
    const since = projectSince(store, project);
    if (since !== undefined && until < since) return { kind: "before", since };

    const projects = new Map<string, readonly IndexRow[]>(
      [...now.projects.keys()].map((name) => [name, []]),
    );

    for (const [name, rows] of rowsUntil(store, until)) projects.set(name, rows);

    return { kind: "rows", rows: [...(projects.get(project) ?? [])], projects };
  });

  return read.kind === "read" ? read.value : read;
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
