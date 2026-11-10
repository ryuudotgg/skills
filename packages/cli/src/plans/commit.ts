import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  formatRow,
  type History,
  type IndexRow,
  issuesByRef,
  renderIndex,
  renderTrail,
  rowKey,
  secondStamp,
  trailEntry,
  type World,
} from "skills-core";
import { importRoot, Refusal } from "./import.ts";
import { decodeUtf8, parseIndexText, plansDir, replaceDurably } from "./index-tsv.ts";
import { logDetail, trailIn } from "./trail.ts";
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
  rowsUntil,
  storedIssues,
  workingCopyChange,
  sha256,
  trailHistory,
  trailEntries,
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

export const TRAIL = "log.tsv";

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
    relative: indexOf(project),
    absolute: join(root, project, "index.tsv"),
    render: (store) => renderIndex(projectRows(store, project)),
  };
}

function trailView(root: string): View {
  return {
    relative: TRAIL,
    absolute: trailIn(root),
    render: (store) => renderTrail(trailEntries(store)),
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
        for (const [path] of changed) {
          const bytes = readCopy(path);
          if (bytes === undefined) copies.delete(path);
          else {
            recordCopy(store, root, path, bytes);
            copies.set(path, bytes);
          }
        }
      });

    return copies;
  } finally {
    store.db.close();
  }
}

export type Touch = (relative: string) => void;

export function indexOf(project: string): string {
  return join(project, "index.tsv");
}

export async function commitEvents<T>(
  root: string,
  edit: (store: Store, touch: Touch) => T,
  repairs = true,
): Promise<T> {
  const store = await openPlansStore(root);
  try {
    const touched = new Set<string>();
    const touch = (relative: string) => {
      if (touched.has(relative)) return;
      claim(store, viewAt(root, relative));
      touched.add(relative);
    };

    const result = write(store, () => edit(store, touch));
    if (repairs || touched.size > 0) publish(store, root, touched);
    return result;
  } finally {
    store.db.close();
  }
}

export type Tx = {
  store: Store;
  at: number;
  rows(project: string): IndexRow[];
  world(): World;
};

type Loaded = { rows: IndexRow[]; original: Map<string, string> };

export async function commitPlans<T>(
  root: string,
  touches: Touches,
  edit: (trail: Trail, rows: IndexRow[], record: RecordCopy, world: () => World, tx: Tx) => T,
): Promise<T> {
  const { index: project } = touches;
  return commitEvents(
    root,
    (store, touch) => {
      const at = Date.now();
      const loaded = new Map<string, Loaded>();
      const load = (name: string): Loaded => {
        const view = indexView(root, name);
        const known = readView(store, view.relative) && existsSync(dirname(view.absolute));
        if (!known && !existsSync(view.absolute)) throw new Refusal(`no index at ${view.absolute}`);

        touch(view.relative);

        const before = projectRows(store, name);
        const entry = {
          rows: before.map((row) => ({ ...row })),
          original: new Map(before.map((row) => [rowKey(row), formatRow(row)])),
        };

        loaded.set(name, entry);
        return entry;
      };

      const rowsOf = (name: string) => (loaded.get(name) ?? load(name)).rows;
      const rows = project === undefined ? [] : rowsOf(project);

      if (touches.trail) touch(TRAIL);

      const trail: Trail = {
        log(logProject, id, event, detail, cut = logDetail) {
          touch(TRAIL);

          appendEvent(store, {
            kind: "trail",
            at,
            entry: trailEntry({
              ts: secondStamp(at),
              project: logProject,
              id,
              event,
              detail: cut(detail),
            }),
          });
        },
        last: (logProject, id, ignored = []) => lastTrailEvent(store, logProject, id, ignored),
        history: (logProject, id) => trailHistory(store, logProject, id),
      };

      let stored: Map<string, IndexRow[]> | undefined;
      const world = (): World => {
        stored ??= new Map(
          [...rowsUntil(store, Number.MAX_SAFE_INTEGER)].filter(([name]) =>
            existsSync(join(root, name)),
          ),
        );

        const projects = new Map<string, readonly IndexRow[]>(stored);
        for (const [name, entry] of loaded) projects.set(name, entry.rows);
        return { projects, issues: issuesByRef(storedIssues(store)) };
      };

      const tx: Tx = { store, at, rows: rowsOf, world };
      const value = edit(trail, rows, (path) => recordWorkingCopy(store, root, path), world, tx);

      for (const [name, { rows: edited, original }] of loaded) {
        const kept = new Set(edited.map(rowKey));
        for (const key of original.keys())
          if (!kept.has(key))
            throw new Error(`a write cannot remove the row ${key.replace("\t", " ")}`);

        for (const row of edited) {
          const was = original.get(rowKey(row));
          if (was === formatRow(row)) continue;

          appendEvent(store, {
            kind: "row",
            type: was === undefined ? "added" : "row",
            at,
            project: name,
            row: { ...row },
          });
        }
      }

      return value;
    },
    project !== undefined || touches.trail === true,
  );
}

export async function updateIndex<T>(
  path: string,
  edit: (rows: IndexRow[], trail: Trail, record: RecordCopy, world: () => World, tx: Tx) => T,
  touchesTrail = false,
): Promise<T> {
  const directory = dirname(path);
  return commitPlans(
    dirname(directory),
    { index: basename(directory), trail: touchesTrail },
    (trail, rows, record, world, tx) => edit(rows, trail, record, world, tx),
  );
}

export async function appendLog(
  project: string,
  id: string,
  event: string,
  detail: string,
  env: NodeJS.ProcessEnv = process.env,
  cut: (detail: string) => string = logDetail,
  also: (tx: Tx) => void = () => {},
): Promise<void> {
  const root = plansDir(env);
  mkdirSync(root, { recursive: true });
  await commitPlans(root, { trail: true }, (trail, _rows, _record, _world, tx) => {
    trail.log(project, id, event, detail, cut);
    also(tx);
  });
}
