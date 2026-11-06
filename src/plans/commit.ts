import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
  importedViews,
  lastTrailEvent,
  markPending,
  openStore,
  pendingViews,
  projectRows,
  publishedView,
  readCopy,
  readView,
  recordCopy,
  recordWorkingCopy,
  workingCopyChange,
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

export type RecordCopy = (path: string) => boolean;

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

function verify(store: Store, view: View): Uint8Array | undefined {
  const disk = readDisk(view.absolute);
  if (disk === undefined) return undefined;

  const fresh = !readView(store, view.relative);
  if (fresh && (view.relative === TRAIL || parseIndexText(decodeUtf8(disk)).length > 0))
    throw new Refusal(`${view.absolute} is not in the store yet, run skills plans import`);

  if (!fresh && !isOwn(store, view, disk)) throw outside(view);

  return disk;
}

function claim(store: Store, view: View): void {
  const disk = verify(store, view);
  if (disk) publishedView(store, view.relative, sha256(disk));
  markPending(store, view.relative);
}

export function verifyRecordedViews(store: Store, root: string): void {
  for (const relative of importedViews(store)) verify(store, viewAt(root, relative));
}

export async function checkViews(root: string, project: string): Promise<void> {
  const store = await openPlansStore(root);
  try {
    verify(store, indexView(root, project));
    verify(store, trailView(root));
  } finally {
    store.db.close();
  }
}

function publish(store: Store, root: string, touched: ReadonlySet<string>): void {
  write(store, () => {
    const missing = importedViews(store).filter(
      (path) => existsSync(dirname(join(root, path))) && !existsSync(join(root, path)),
    );

    for (const relative of new Set([...touched, ...pendingViews(store), ...missing])) {
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

export async function openPlansStore(root: string): Promise<Store> {
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

export async function recordWorkingCopies(
  root: string,
  paths: readonly string[],
): Promise<Map<string, Uint8Array>> {
  const copies = new Map<string, Uint8Array>();
  for (const path of paths) {
    const bytes = readCopy(path);
    if (bytes !== undefined) copies.set(path, bytes);
  }

  const store = await openPlansStore(root);
  try {
    const changed = store.db
      .transaction(() =>
        [...copies].filter(([path, bytes]) => workingCopyChange(store, root, path, bytes)),
      )
      .deferred();

    if (changed.length > 0)
      write(store, () => {
        for (const [path, bytes] of changed) recordCopy(store, root, path, bytes);
      });

    return copies;
  } finally {
    store.db.close();
  }
}

export async function commitPlans<T>(
  root: string,
  touches: Touches,
  edit: (trail: Trail, rows: IndexRow[], record: RecordCopy) => T,
): Promise<T> {
  const { index: project } = touches;
  const store = await openPlansStore(root);
  try {
    const touched = new Set<string>();
    const touch = (view: View) => {
      if (touched.has(view.relative)) return;
      claim(store, view);
      touched.add(view.relative);
    };

    const result = write(store, () => {
      const at = Date.now();

      if (project !== undefined) {
        const view = indexView(root, project);
        const known = readView(store, view.relative) && existsSync(dirname(view.absolute));
        if (!known && !existsSync(view.absolute)) throw new Error(`no index at ${view.absolute}`);

        touch(view);
      }

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

      const value = edit(trail, rows, (path) => recordWorkingCopy(store, root, path));

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
  edit: (rows: IndexRow[], trail: Trail, record: RecordCopy) => T,
  touchesTrail = false,
): Promise<T> {
  const directory = dirname(path);
  return commitPlans(
    dirname(directory),
    { index: basename(directory), trail: touchesTrail },
    (trail, rows, record) => edit(rows, trail, record),
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
