import { existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { importRoot } from "./import.ts";
import { indexIn, type IndexRow } from "./index-tsv.ts";
import { importedViews, openStore, projectedRows, type Store } from "./store.ts";

export type PlansIndex = { project: string; index: string; rows: IndexRow[] };

export type Projection<T> =
  | { kind: "absent" }
  | { kind: "failed"; reason: string }
  | { kind: "read"; value: T };

const INDEX_VIEW = /\/index\.tsv$/;

function isDirectory(root: string): boolean | undefined {
  try {
    return statSync(root).isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
  }
}

export async function readStore<T>(
  root: string,
  read: (store: Store) => T,
): Promise<Projection<T>> {
  const directory = isDirectory(root);
  if (directory === false) return { kind: "absent" };
  if (directory === undefined) return { kind: "failed", reason: `${root}: unreadable` };

  try {
    if (!existsSync(join(root, "plans.db"))) await importRoot(root, true);

    const store = openStore(join(root, "plans.db"));
    try {
      return { kind: "read", value: store.db.transaction(() => read(store)).deferred() };
    } finally {
      store.db.close();
    }
  } catch (error) {
    return { kind: "failed", reason: error instanceof Error ? error.message : String(error) };
  }
}

export function plansIndexes(store: Store, root: string): PlansIndex[] {
  const rows = projectedRows(store);
  return importedViews(store)
    .filter((path) => INDEX_VIEW.test(path))
    .map((path) => {
      const project = dirname(path);
      return {
        project,
        index: indexIn(join(root, project)),
        rows: [...(rows.get(project)?.values() ?? [])],
      };
    });
}
