import { existsSync, linkSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import {
  decodeUtf8,
  formatRow,
  indexIn,
  parseIndexText,
  plansDir,
  syncDirectory,
  type IndexRow,
} from "./index-tsv.ts";
import { parseTrailText, trailIn, type TrailEntry } from "./trail.ts";
import {
  appendEvent,
  latestRevision,
  openStore,
  projectedRows,
  recordRevision,
  renderIndex,
  renderTrail,
  rowKey,
  storePath,
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
    .filter((project) => isFile(indexIn(join(root, project))))
    .map((project) => {
      const path = indexIn(join(root, project));
      const text = readText(path);
      return { project, path, text, rows: parseIndexText(text) };
    });

  const trailFile = trailIn(root);
  const trailText = isFile(trailFile) ? readText(trailFile) : undefined;
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

function importTrail(store: Store, root: string, trail: Trail | undefined): number {
  const stored = trailLines(store);
  if (!trail) {
    if (stored.length > 0)
      throw new Refusal(
        `${trailIn(root)} is missing, the store holds ${stored.length} of its lines`,
      );

    return 0;
  }

  const storedText = renderTrail(stored);
  if (!trail.text.startsWith(storedText)) {
    const line = firstDifference(storedText, trail.text);
    const reason =
      stored.length === 0 ? "does not round trip through the store" : "changed after import";

    throw new Refusal(`${trail.path}:${line}: ${reason}`);
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

function roundTrip(store: Store, snapshot: Snapshot): void {
  const projected = projectedRows(store);
  const views = snapshot.indexes.map((index) => ({
    path: index.path,
    text: index.text,
    rendered: renderIndex(projected.get(index.project)?.values() ?? []),
  }));

  if (snapshot.trail) views.push({ ...snapshot.trail, rendered: renderTrail(trailLines(store)) });

  for (const view of views)
    if (view.rendered !== view.text)
      throw new Refusal(
        `${view.path}:${firstDifference(view.rendered, view.text)}: does not round trip through the store`,
      );

  const listed = new Set(snapshot.indexes.map((index) => index.project));
  for (const project of projected.keys())
    if (!listed.has(project))
      throw new Refusal(
        `${indexIn(join(snapshot.root, project))} is missing, the store holds its rows`,
      );
}

function unchangedSince(snapshot: Snapshot): void {
  const views = [...snapshot.indexes, ...(snapshot.trail ? [snapshot.trail] : [])];
  for (const view of views)
    if (!isFile(view.path) || readText(view.path) !== view.text)
      throw new Refusal(`${view.path} changed during the import, run it again`);
}

function reconcile(store: Store, root: string): Counts {
  return write(store, () => {
    const snapshot = readSnapshot(root);
    const events = importTrail(store, root, snapshot.trail);
    const rows = importRows(store, snapshot.indexes);
    const files = importFiles(store, snapshot.files);

    roundTrip(store, snapshot);
    unchangedSince(snapshot);
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

function buildFresh(path: string, root: string): Counts {
  if (existsSync(path)) return reconcileExisting(path, root);

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
    } finally {
      store.db.close();
    }

    linkSync(temporary, path);
    openStore(path).db.close();
    return counts;
  } finally {
    for (const suffix of ["", "-journal", "-wal", "-shm"])
      rmSync(`${temporary}${suffix}`, { force: true });

    syncDirectory(folder);
  }
}

export async function importStore(env: NodeJS.ProcessEnv = process.env): Promise<Counts> {
  const root = plansDir(env);
  if (!isDirectory(root)) throw new Refusal(`no plans directory at ${root}`);

  const path = storePath(env);
  if (existsSync(path)) return reconcileExisting(path, root);

  return withLock(join(root, ".plans.db.lock"), "store", () => buildFresh(path, root));
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
