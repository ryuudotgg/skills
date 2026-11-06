import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { importRoot, Refusal } from "./import.ts";
import {
  decodeUtf8,
  flatten,
  formatRow,
  parseIndexText,
  plansDir,
  replaceDurably,
  type IndexRow,
} from "./index-tsv.ts";
import { logDetail, trailIn, type History } from "./trail.ts";
import {
  appendEvent,
  lastTrailEvent,
  markPending,
  openStore,
  pendingViews,
  projectRows,
  publishedView,
  readView,
  renderIndex,
  renderTrail,
  rowKey,
  secondStamp,
  sha256,
  trailHistory,
  trailLines,
  write,
  type Store,
} from "./store.ts";

export type Trail = {
  log(
    project: string,
    id: string,
    event: string,
    detail: string,
    cut?: (detail: string) => string,
  ): void;
  last(
    project: string,
    id: string,
    ignored?: readonly string[],
  ): { event: string; detail: string } | undefined;
  history(project: string, id: string): History;
};

export type Touches = { index?: string; trail?: boolean };

type View = { relative: string; absolute: string; render: (store: Store) => string };

const TRAIL = "log.tsv";

function readDisk(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function indexView(root: string, project: string): View {
  return {
    relative: join(project, "index.tsv"),
    absolute: join(root, project, "index.tsv"),
    render: (store) => renderIndex(projectRows(store, project)),
  };
}

function trailView(root: string): View {
  return {
    relative: TRAIL,
    absolute: trailIn(root),
    render: (store) => renderTrail(trailLines(store)),
  };
}

function viewAt(root: string, relative: string): View {
  return relative === TRAIL ? trailView(root) : indexView(root, dirname(relative));
}

function outside(view: View): Refusal {
  return new Refusal(
    `${view.absolute} changed outside the store, run skills plans import to take the edit in`,
  );
}

function isOwn(store: Store, view: View, disk: Uint8Array): boolean {
  const recorded = readView(store, view.relative);
  if (!recorded) return false;
  if (sha256(disk) === recorded.current) return true;

  return decodeUtf8(disk) === view.render(store);
}

function claim(store: Store, view: View): void {
  const disk = readDisk(view.absolute);
  if (disk !== undefined) {
    const fresh = !readView(store, view.relative);
    if (fresh && (view.relative === TRAIL || parseIndexText(decodeUtf8(disk)).length > 0))
      throw new Refusal(`${view.absolute} is not in the store yet, run skills plans import`);

    if (fresh) publishedView(store, view.relative, sha256(disk));
    else if (!isOwn(store, view, disk)) throw outside(view);
  }

  markPending(store, view.relative);
}

function publish(store: Store, root: string, touched: ReadonlySet<string>): void {
  write(store, () => {
    for (const relative of new Set([...touched, ...pendingViews(store)])) {
      const view = viewAt(root, relative);
      const text = view.render(store);
      const disk = readDisk(view.absolute);
      if (disk === undefined || decodeUtf8(disk) !== text) {
        if (disk !== undefined && !isOwn(store, view, disk)) {
          if (!touched.has(relative)) continue;
          throw new Refusal(`the write is in the store, but ${outside(view).message}`);
        }

        mkdirSync(dirname(view.absolute), { recursive: true });
        replaceDurably(view.absolute, text);
      }

      publishedView(store, relative, sha256(text));
    }
  });
}

export async function openForWrite(root: string): Promise<Store> {
  try {
    if (!existsSync(join(root, "plans.db"))) await importRoot(root, true);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    throw new Refusal(
      `the first import refused: ${error.message}; fix it, then run skills plans import`,
    );
  }

  return openStore(join(root, "plans.db"));
}

export async function commitPlans<T>(
  root: string,
  touches: Touches,
  edit: (trail: Trail, rows: IndexRow[]) => T,
): Promise<T> {
  const { index: project } = touches;
  const store = await openForWrite(root);
  try {
    const touched = new Set<string>();
    const touch = (view: View) => {
      if (touched.has(view.relative)) return;
      claim(store, view);
      touched.add(view.relative);
    };

    const result = write(store, () => {
      const at = Date.now();
      if (project !== undefined) touch(indexView(root, project));
      if (touches.trail) touch(trailView(root));

      const before = project === undefined ? [] : projectRows(store, project);
      const rows = before.map((row) => ({ ...row }));
      const original = new Map(before.map((row) => [rowKey(row), formatRow(row)]));

      const trail: Trail = {
        log(logProject, id, event, detail, cut = logDetail) {
          touch(trailView(root));

          const ts = secondStamp(at);
          const [, flatProject = "", flatId = "", , flatDetail = ""] = [
            ts,
            logProject,
            id,
            event,
            cut(detail),
          ].map(flatten);

          appendEvent(store, {
            type: flatten(event),
            at,
            ts,
            project: flatProject,
            plan: flatId,
            payload: {
              detail: flatDetail,
              line: [ts, flatProject, flatId, flatten(event), flatDetail].join("\t"),
            },
          });
        },
        last: (logProject, id, ignored = []) => lastTrailEvent(store, logProject, id, ignored),
        history: (logProject, id) => trailHistory(store, logProject, id),
      };

      const value = edit(trail, rows);

      const kept = new Set(rows.map(rowKey));
      for (const key of original.keys())
        if (!kept.has(key))
          throw new Error(`a write cannot remove the row ${key.replace("\t", " ")}`);

      if (project !== undefined)
        for (const row of rows) {
          const was = original.get(rowKey(row));
          if (was === formatRow(row)) continue;

          appendEvent(store, {
            type: was === undefined ? "added" : "row",
            at,
            project,
            plan: row.id,
            payload: { row: { ...row } },
          });
        }

      return value;
    });

    publish(store, root, touched);
    return result;
  } finally {
    store.db.close();
  }
}

export async function updateIndex<T>(
  path: string,
  edit: (rows: IndexRow[], trail: Trail) => T,
  touchesTrail = false,
): Promise<T> {
  if (!statSync(path).isFile()) throw new Error(`no index at ${path}`);

  const directory = dirname(path);
  return commitPlans(
    dirname(directory),
    { index: basename(directory), trail: touchesTrail },
    (trail, rows) => edit(rows, trail),
  );
}

export async function appendLog(
  project: string,
  id: string,
  event: string,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
  cut: (detail: string) => string = logDetail,
): Promise<void> {
  const root = plansDir(env);
  mkdirSync(root, { recursive: true });
  await commitPlans(root, { trail: true }, (trail) => trail.log(project, id, event, detail, cut));
}
