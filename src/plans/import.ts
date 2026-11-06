import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join, relative } from "node:path";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import {
  decodeUtf8,
  formatRow,
  indexIn,
  parseIndexText,
  plansDir,
  replaceDurably,
  syncDirectory,
  type IndexRow,
} from "./index-tsv.ts";
import { parseTrailText, trailIn, type TrailEntry } from "./trail.ts";
import {
  appendEvent,
  importedViews,
  latestRevision,
  openStore,
  projectedRows,
  recordRevision,
  recordView,
  renderIndex,
  renderTrail,
  pendingViews,
  publishedView,
  readView,
  rowKey,
  sha256,
  trailLines,
  write,
  type Store,
} from "./store.ts";

export type Counts = { rows: number; events: number; files: number };

type Index = { project: string; path: string; text: string; rows: IndexRow[] };
type Trail = { path: string; text: string; entries: TrailEntry[] };
type WorkingCopy = { project: string; path: string; bytes: Uint8Array; sha256: string };
type Snapshot = { root: string; indexes: Index[]; trail: Trail | undefined; files: WorkingCopy[] };

export class Refusal extends Error {}

const PLAN_FILE = /^\d{3}-.*\.md$/;
const CTX_FILE = /^ctx-.*\.md$/;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isView(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new Refusal(`${path}: ${code ?? "unreadable"}, run it again`);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function readBytes(path: string): Uint8Array {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Refusal(
      `${path}: ${(error as NodeJS.ErrnoException).code ?? "unreadable"}, run it again`,
    );
  }
}

function readText(path: string): string {
  const bytes = readBytes(path);
  try {
    return decodeUtf8(bytes);
  } catch {
    throw new Refusal(`${path}: not valid UTF-8`);
  }
}

function workingCopies(root: string, project: string): WorkingCopy[] {
  const folders = [
    { folder: project, pattern: (name: string) => PLAN_FILE.test(name) || CTX_FILE.test(name) },
    { folder: join(project, "done"), pattern: (name: string) => PLAN_FILE.test(name) },
  ];

  return folders.flatMap(({ folder, pattern }) => {
    if (!isDirectory(join(root, folder))) return [];

    return readdirSync(join(root, folder))
      .filter((name) => pattern(name) && isFile(join(root, folder, name)))
      .sort()
      .map((name) => {
        const path = join(folder, name);
        const bytes = readBytes(join(root, path));
        const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
        return { project, path, bytes, sha256 };
      });
  });
}

function readSnapshot(root: string): Snapshot {
  const projects = readdirSync(root)
    .filter((name) => !name.startsWith(".") && isDirectory(join(root, name)))
    .sort();

  const indexes = projects
    .filter((project) => isView(indexIn(join(root, project))))
    .map((project) => {
      const path = indexIn(join(root, project));
      const text = readText(path);
      return { project, path, text, rows: parseIndexText(text) };
    });

  const trailFile = trailIn(root);
  const trailText = isView(trailFile) ? readText(trailFile) : undefined;
  const trail =
    trailText === undefined
      ? undefined
      : { path: trailFile, text: trailText, entries: parseTrailText(trailText) };

  const files = projects.flatMap((project) => workingCopies(root, project));
  return { root, indexes, trail, files };
}

function firstDifference(expected: string, actual: string): number {
  const want = expected.split("\n");
  const have = actual.split("\n");

  let line = 0;
  while (line < Math.max(want.length, have.length) && want[line] === have[line]) line += 1;

  return line + 1;
}

function importTrail(store: Store, trail: Trail | undefined): number {
  if (!trail) return 0;

  const stored = trailLines(store);

  const storedText = renderTrail(stored);
  if (!trail.text.startsWith(storedText)) {
    const line = firstDifference(storedText, trail.text);
    const reason =
      stored.length === 0 ? "does not round trip through the store" : "changed after import";

    const aside = stored.length === 0 ? "" : `; ${MOVE_ASIDE}`;
    throw new Refusal(`${trail.path}:${line}: ${reason}${aside}`);
  }

  const added = trail.entries.slice(stored.length);
  for (const entry of added)
    appendEvent(store, {
      type: entry.event,
      at: Date.parse(entry.ts),
      ts: entry.ts,
      project: entry.project,
      plan: entry.id,
      payload: { detail: entry.detail, line: entry.line },
    });

  return added.length;
}

function importRows(store: Store, indexes: readonly Index[]): number {
  const projected = projectedRows(store);

  let changed = 0;
  for (const index of indexes) {
    const current = projected.get(index.project);
    const seen = new Set<string>();
    for (const row of index.rows) {
      const key = rowKey(row);
      if (seen.has(key))
        throw new Refusal(`${index.path}: id ${row.id} slug ${row.slug} appears twice`);

      seen.add(key);

      const before = current?.get(key);
      if (before && formatRow(before) === formatRow(row)) continue;

      appendEvent(store, {
        type: before ? "row" : "imported",
        at: Date.now(),
        project: index.project,
        plan: row.id,
        payload: { row },
      });

      changed += 1;
    }
  }

  return changed;
}

function importFiles(store: Store, files: readonly WorkingCopy[]): number {
  const changed = files.filter((file) => latestRevision(store, file.path) !== file.sha256);
  for (const file of changed)
    recordRevision(store, file.project, file.path, file.bytes, file.sha256);

  return changed.length;
}

function roundTrip(store: Store, snapshot: Snapshot, recorded: readonly string[] = []): void {
  const projected = projectedRows(store);
  const views = snapshot.indexes.map((index) => ({
    path: index.path,
    text: index.text,
    rendered: renderIndex(projected.get(index.project)?.values() ?? []),
  }));

  if (snapshot.trail) views.push({ ...snapshot.trail, rendered: renderTrail(trailLines(store)) });

  for (const view of views)
    if (view.rendered !== view.text) {
      const known = recorded.includes(relative(snapshot.root, view.path));
      throw new Refusal(
        `${view.path}:${firstDifference(view.rendered, view.text)}: does not round trip through the store${known ? `; ${MOVE_ASIDE}` : ""}`,
      );
    }
}

function importViews(store: Store, snapshot: Snapshot): void {
  const present = [...snapshot.indexes, ...(snapshot.trail ? [snapshot.trail] : [])].map((view) =>
    relative(snapshot.root, view.path),
  );

  for (const path of importedViews(store))
    if (!present.includes(path))
      throw new Refusal(`${join(snapshot.root, path)} is missing, the store imported it`);

  for (const path of present) recordView(store, path);
}

function recordHashes(store: Store, snapshot: Snapshot): void {
  for (const view of [...snapshot.indexes, ...(snapshot.trail ? [snapshot.trail] : [])])
    publishedView(store, relative(snapshot.root, view.path), sha256(view.text));
}

export const MOVE_ASIDE =
  "save the edit, move the file aside and run skills plans import again, which writes the store's copy back";

function unfinishedWrites(store: Store, snapshot: Snapshot): void {
  const views = [...snapshot.indexes, ...(snapshot.trail ? [snapshot.trail] : [])];
  const pending = new Set(pendingViews(store));
  const projected = projectedRows(store);
  for (const view of views) {
    const path = relative(snapshot.root, view.path);
    if (!pending.has(path)) continue;

    const isTrail = view === snapshot.trail;
    const rendered = isTrail
      ? renderTrail(trailLines(store))
      : renderIndex(projected.get(dirname(path))?.values() ?? []);

    if (view.text === rendered) continue;

    if (sha256(view.text) === readView(store, path)?.current)
      throw new Refusal(
        `${view.path} has a write that has not reached it yet, run any plans write to finish it, then import`,
      );

    throw new Refusal(
      `${view.path} changed while a write to it was unfinished, so import cannot take the edit in without undoing that write; ${MOVE_ASIDE}`,
    );
  }
}

function restoreMissing(store: Store, root: string): void {
  const projected = projectedRows(store);
  for (const path of importedViews(store)) {
    const absolute = join(root, path);
    if (!isDirectory(dirname(absolute)) || isFile(absolute)) continue;

    const text =
      path === "log.tsv"
        ? renderTrail(trailLines(store))
        : renderIndex(projected.get(dirname(path))?.values() ?? []);

    replaceDurably(absolute, text);
  }
}

function unchangedSince(snapshot: Snapshot): void {
  const views = [...snapshot.indexes, ...(snapshot.trail ? [snapshot.trail] : [])];
  for (const view of views)
    if (!isFile(view.path) || readText(view.path) !== view.text)
      throw new Refusal(`${view.path} changed during the import, run it again`);
}

function reconcile(store: Store, root: string): Counts {
  return write(store, () => {
    restoreMissing(store, root);

    const snapshot = readSnapshot(root);
    const recorded = importedViews(store);
    unfinishedWrites(store, snapshot);
    importViews(store, snapshot);

    const events = importTrail(store, snapshot.trail);
    const rows = importRows(store, snapshot.indexes);
    const files = importFiles(store, snapshot.files);

    roundTrip(store, snapshot, recorded);
    unchangedSince(snapshot);
    recordHashes(store, snapshot);
    return { rows, events, files };
  });
}

function reconcileExisting(path: string, root: string): Counts {
  const store = openStore(path);
  try {
    return reconcile(store, root);
  } finally {
    store.db.close();
  }
}

const NOTHING: Counts = { rows: 0, events: 0, files: 0 };
function buildFresh(path: string, root: string, onlyCreate: boolean): Counts {
  if (existsSync(path)) return onlyCreate ? NOTHING : reconcileExisting(path, root);

  const folder = dirname(path);
  for (const name of readdirSync(folder))
    if (name.startsWith(`${basename(path)}.`) && /\.tmp(-journal|-wal|-shm)?$/.test(name))
      rmSync(join(folder, name), { force: true });

  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const store = openStore(temporary, true);

    let counts: Counts;
    try {
      counts = reconcile(store, root);
      store.db.run("PRAGMA journal_mode = WAL");
    } finally {
      store.db.close();
    }

    renameSync(temporary, path);
    openStore(path).db.close();
    return counts;
  } finally {
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      rmSync(`${temporary}${suffix}`, { force: true });

    syncDirectory(folder);
  }
}

export async function importStore(env: NodeJS.ProcessEnv = process.env): Promise<Counts> {
  return importRoot(plansDir(env));
}

export async function importRoot(root: string, onlyCreate = false): Promise<Counts> {
  if (!isDirectory(root)) throw new Refusal(`no plans directory at ${root}`);

  const path = join(root, "plans.db");
  if (existsSync(path)) return onlyCreate ? NOTHING : reconcileExisting(path, root);

  return withLock(join(root, ".plans.db.lock"), "store", () => buildFresh(path, root, onlyCreate));
}

export async function importVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  if (args.length > 0) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    const counts = await importStore(io.env);
    io.out(`imported ${counts.rows} rows, ${counts.events} events, ${counts.files} files\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`import refused: ${error.message}\n`);
    return 1;
  }
}
