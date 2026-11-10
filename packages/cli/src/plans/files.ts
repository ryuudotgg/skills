import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
  type Dirent,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { CHUNK_SIZE, compareEvents, type FileRevisionRecord } from "skills-core";
import { FILE_PLAN, IGNORE_FILE, projectIgnore } from "./ignore.ts";
import { syncDirectory } from "./index-tsv.ts";
import {
  ancestryOf,
  lineage,
  newest,
  type Conflicted,
  type Landed,
  type Lineage,
} from "./landing.ts";
import { recordConflict } from "./outbox.ts";
import {
  appendEvent,
  insertFileRevision,
  isCopyKey,
  fetchableLocator,
  isDeleted,
  locatorOf,
  RECORDED_HERE,
  sha256,
  storeBlob,
  write,
  type FileChunkRef,
  type Store,
} from "./store.ts";

export const MAX_FILE_SIZE = 128 * CHUNK_SIZE;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const TEMPORARY = new RegExp(`(\\.\\d+\\.${UUID}|(^|/)\\.plans-${UUID})\\.tmp$`);

export type Skipped = { readonly path: string; readonly reason: "symlink" | "large" };

export type Walked = { readonly read: number; readonly skipped: Skipped[] };

export type WalkLimits = { readonly deadline: number; readonly bytes: number };

export type Refused = { readonly path: string; readonly reason: string };

export type FileLandings = {
  readonly landed: Landed[];
  readonly conflicts: Conflicted[];
  readonly refused: Refused[];
};

type Shape = { size: number; mtime: number; executable: boolean };

type Known = { sha256: string; executable: boolean };

type LandingState = "landed" | "conflict" | "superseded" | "gone" | "refused" | "blocked" | null;

export function projectsOf(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(root, name, "index.tsv")))
      .sort();
  } catch {
    return [];
  }
}

export function isOwnFile(project: string, path: string): boolean {
  if (isCopyKey(path) || path === join(project, "index.tsv")) return true;
  return basename(path) === IGNORE_FILE || TEMPORARY.test(path);
}

function shapeOf(stat: Stats): Shape {
  return { size: stat.size, mtime: stat.mtimeMs, executable: (stat.mode & 0o111) !== 0 };
}

type Listed = { readonly path: string; readonly kind: "file" | "symlink" | "dir" };

const WALK_CURSOR = "file_walk";

function sortKey(entry: Dirent): string {
  return entry.isDirectory() ? `${entry.name}/` : entry.name;
}

function* listed(root: string, after: string): Generator<Listed> {
  const projects = projectsOf(root).sort((a, b) => (`${a}/` < `${b}/` ? -1 : 1));
  for (const project of projects) {
    const ignore = projectIgnore(root, project);
    if (ignore.ignores(project, true)) continue;

    function* visit(dir: string): Generator<Listed> {
      if (`${dir}/` < after && !after.startsWith(`${dir}/`)) return;

      yield { path: dir, kind: "dir" };

      let entries: Dirent[];
      try {
        entries = readdirSync(join(root, dir), { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries.sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : 1))) {
        const path = join(dir, entry.name);
        const folder = entry.isDirectory();
        if (ignore.ignores(path, folder)) continue;

        if (folder) yield* visit(path);
        else if (path <= after) continue;
        else if (entry.isSymbolicLink()) yield { path, kind: "symlink" };
        else if (entry.isFile() && !isOwnFile(project, path)) yield { path, kind: "file" };
      }
    }

    yield* visit(project);
  }
}

function walkCursor(store: Store): string {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(WALK_CURSOR) as {
    value: string;
  } | null;

  return row?.value ?? "";
}

function setWalkCursor(store: Store, path: string | undefined): void {
  write(store, () => {
    if (path === undefined) store.db.run("DELETE FROM meta WHERE key = ?", [WALK_CURSOR]);
    else
      store.db.run(
        `INSERT INTO meta (key, value) VALUES (?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
        [WALK_CURSOR, path],
      );
  });
}

const RACY_MS = 2_000;
function cachedShape(store: Store, path: string): Shape | undefined {
  const row = store.db
    .query("SELECT size, mtime, executable, checked FROM file_stats WHERE path = ?")
    .get(path) as { size: number; mtime: number; executable: number; checked: number } | null;

  if (row === null || row.mtime > row.checked - RACY_MS) return undefined;
  return { size: row.size, mtime: row.mtime, executable: row.executable === 1 };
}

function sameShape(left: Shape, right: Shape): boolean {
  return (
    left.size === right.size && left.mtime === right.mtime && left.executable === right.executable
  );
}

function remember(store: Store, path: string, shape: Shape): void {
  store.db.run(
    `INSERT INTO file_stats (path, size, mtime, executable, checked) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime,
       executable = excluded.executable, checked = excluded.checked`,
    [path, shape.size, shape.mtime, shape.executable ? 1 : 0, Date.now()],
  );
}

function newestFileHere(store: Store, path: string): (Known & { node: Node }) | undefined {
  const row = store.db
    .query(
      `SELECT ${NODE}, f.executable FROM files f
       JOIN events e ON e.id = f.event AND e.quarantined IS NULL
       WHERE f.path = ? AND ${RECORDED_HERE}
       ORDER BY e.wall DESC, e.counter DESC, e.machine DESC, e.id DESC LIMIT 1`,
    )
    .get(path) as (Node & { executable: number }) | null;

  return row === null
    ? undefined
    : { sha256: row.sha256, executable: row.executable === 1, node: row };
}

function recordFile(store: Store, path: string, bytes: Uint8Array, executable: boolean): void {
  const captured = new Date().toISOString();
  const digest = sha256(bytes);
  const here = newestFileHere(store, path);

  const chunks: FileChunkRef[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_SIZE) {
    const part = new Uint8Array(bytes.subarray(offset, offset + CHUNK_SIZE));
    const chunk = sha256(part);
    const locator = locatorOf(store, chunk);
    storeBlob(store, chunk, part, locator);
    chunks.push({ sha256: chunk, locator });
  }

  const [project = ""] = path.split(sep);
  const payload: FileRevisionRecord = {
    path,
    sha256: digest,
    captured,
    size: bytes.byteLength,
    executable,
    chunks: chunks.map((chunk) => ({ sha256: chunk.sha256, blob: chunk.locator })),
    ...(here === undefined ? {} : { base: here.sha256, parent: here.node.id }),
  };

  const event = appendEvent(store, {
    kind: "stored",
    type: "revision",
    at: Date.parse(captured),
    project,
    plan: FILE_PLAN,
    payload,
  });

  insertFileRevision(store, {
    event,
    project,
    path,
    sha256: digest,
    size: bytes.byteLength,
    executable,
    captured,
    machine: store.machine,
    chunks,
  });
}

type Read =
  | { kind: "same" }
  | { kind: "later" }
  | { kind: "large" }
  | { kind: "read"; shape: Shape; bytes: Buffer };

function readChanged(store: Store, root: string, path: string, allowance: number): Read {
  const fd = openSync(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "same" };

    const shape = shapeOf(stat);
    const cached = cachedShape(store, path);
    if (cached !== undefined && sameShape(cached, shape)) return { kind: "same" };
    if (shape.size > MAX_FILE_SIZE) return { kind: "large" };
    if (shape.size > allowance) return { kind: "later" };

    return { kind: "read", shape, bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}

function captureOne(store: Store, root: string, path: string, allowance: number): Read {
  let read: Read;
  try {
    read = readChanged(store, root, path, allowance);
  } catch {
    return { kind: "same" };
  }

  if (read.kind !== "read") return read;

  const { shape, bytes } = read;
  const digest = sha256(bytes);
  write(store, () => {
    const known = newestFileHere(store, path);
    const differs = known?.sha256 !== digest || known.executable !== shape.executable;
    if (differs) recordFile(store, path, bytes, shape.executable);

    remember(store, path, shape);
  });

  return read;
}

export function walkFiles(store: Store, root: string, limits: WalkLimits): Walked {
  const skipped: Skipped[] = [];

  const after = walkCursor(store);

  let read = 0;
  let last: string | undefined;
  for (const { path, kind } of listed(root, after)) {
    if (Date.now() > limits.deadline) {
      if (last !== undefined) setWalkCursor(store, last);
      return { read, skipped };
    }

    if (path > after) last = path;
    if (kind === "dir") continue;

    if (kind === "symlink") {
      skipped.push({ path, reason: "symlink" });
      continue;
    }

    const allowance = read === 0 ? MAX_FILE_SIZE : limits.bytes - read;
    const captured = captureOne(store, root, path, allowance);
    if (captured.kind === "large") skipped.push({ path, reason: "large" });
    if (captured.kind === "read") read += captured.bytes.byteLength;
  }

  setWalkCursor(store, undefined);
  return { read, skipped };
}

type Node = Lineage & { readonly path: string; readonly parent: string | null };

type Pending = Node & {
  readonly project: string;
  readonly size: number;
  readonly executable: number;
  readonly author: string | null;
};

const NODE = `e.id, e.machine, e.wall, e.counter, f.path, f.sha256,
  json_extract(e.payload, '$.base') AS base, json_extract(e.payload, '$.parent') AS parent`;

function pending(store: Store): Pending[] {
  return store.db
    .query(
      `SELECT ${NODE}, f.project, f.size, f.executable, e.author
       FROM landings l
       JOIN files f ON f.event = l.event
       JOIN events e ON e.id = l.event AND e.quarantined IS NULL
       WHERE l.state IS NULL`,
    )
    .all() as Pending[];
}

function settle(store: Store, event: string, state: LandingState): void {
  store.db.run("UPDATE landings SET state = ? WHERE event = ?", [state, event]);
}

function isMissing(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

function settled(store: Store, state: LandingState): (Node & { event: string })[] {
  return store.db
    .query(
      `SELECT ${NODE}, l.event FROM landings l
       JOIN files f ON f.event = l.event
       JOIN events e ON e.id = l.event AND e.quarantined IS NULL
       WHERE l.state IS ?`,
    )
    .all(state) as (Node & { event: string })[];
}

function requeue(store: Store, event: string): boolean {
  const missing = store.db
    .query(
      `SELECT c.sha256 FROM file_chunks c
       WHERE c.event = ? AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = c.sha256)`,
    )
    .all(event) as { sha256: string }[];

  const located = missing.map((chunk) => ({
    ...chunk,
    locator: fetchableLocator(store.db, chunk.sha256),
  }));

  if (located.some((chunk) => chunk.locator === undefined)) return false;

  for (const chunk of located)
    store.db.run(
      "INSERT OR IGNORE INTO blob_fetches (sha256, locator, event, queued) VALUES (?, ?, ?, ?)",
      [chunk.sha256, chunk.locator ?? "", event, Date.now()],
    );

  return true;
}

function byPath<T extends Node>(nodes: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const node of nodes) groups.set(node.path, [...(groups.get(node.path) ?? []), node]);
  return groups;
}

function reopen(store: Store, root: string): void {
  write(store, () => {
    const resolved = settled(store, "conflict").filter(({ path }) => isMissing(join(root, path)));
    for (const { event } of [...resolved, ...settled(store, "blocked")]) settle(store, event, null);

    for (const { event } of settled(store, null)) requeue(store, event);

    for (const nodes of byPath(settled(store, "gone")).values())
      if (requeue(store, newest(nodes).event))
        for (const { event } of nodes) settle(store, event, null);
  });
}

function newerGone(store: Store, node: Node): boolean {
  const gone = settled(store, "gone").filter((other) => other.path === node.path);
  return gone.some((other) => compareEvents(other, node) > 0);
}

function parentOf(store: Store, node: Node): Node | undefined {
  if (node.parent === null) return undefined;

  const parent = store.db
    .query(
      `SELECT ${NODE} FROM files f JOIN events e ON e.id = f.event AND e.quarantined IS NULL
       WHERE f.event = ? AND f.path = ?`,
    )
    .get(node.parent, node.path) as Node | null;

  return parent ?? undefined;
}

function ancestry(store: Store, node: Node): Set<string> {
  return ancestryOf(node, (current) => parentOf(store, current));
}

function descendsFromHere(store: Store, node: Node, disk: string): boolean {
  const here = newestFileHere(store, node.path);
  if (here === undefined || here.sha256 !== disk) return false;

  const chain = lineage(node, (current) => parentOf(store, current));
  return chain.some((link) => link.id === here.node.id);
}

type Content = { kind: "bytes"; bytes: Uint8Array } | { kind: "waiting" } | { kind: "gone" };

function contentOf(store: Store, node: Pending): Content {
  const chunks = store.db
    .query(
      `SELECT c.locator, b.bytes,
         EXISTS (SELECT 1 FROM blob_fetches q WHERE q.sha256 = c.sha256) AS queued
       FROM file_chunks c LEFT JOIN blobs b ON b.sha256 = c.sha256
       WHERE c.event = ? ORDER BY c.position`,
    )
    .all(node.id) as { locator: string; bytes: Uint8Array | null; queued: number }[];

  const parts: Uint8Array[] = [];
  for (const chunk of chunks)
    if (chunk.bytes !== null) parts.push(chunk.bytes);
    else if (chunk.queued === 0 && isDeleted(store.db, chunk.locator)) return { kind: "gone" };
    else return { kind: "waiting" };

  return { kind: "bytes", bytes: Buffer.concat(parts) };
}

function containment(root: string, path: string): string | undefined {
  const parts = path.split(sep);
  const target = resolve(root, path);
  if (isAbsolute(path) || parts.includes("..") || !target.startsWith(resolve(root) + sep))
    return "it leaves the plans directory";

  for (let depth = 1; depth <= parts.length; depth += 1) {
    const here = join(...parts.slice(0, depth));

    let stat: Stats;
    try {
      stat = lstatSync(join(root, here));
    } catch {
      return undefined;
    }

    if (stat.isSymbolicLink()) return `${here} is a symlink here`;

    const last = depth === parts.length;
    if (!last && !stat.isDirectory()) return `${here} is not a directory`;
    if (last && !stat.isFile()) return "a directory or special file stands there";
  }

  return undefined;
}

class Moved extends Error {
  override name = "Moved";
}

function modeFor(current: number | undefined, executable: boolean): number {
  const base = current ?? 0o666 & ~process.umask();
  return executable ? base | ((base & 0o444) >> 2) : base & ~0o111;
}

class Blocked extends Error {
  override name = "Blocked";
}

type Guard = () => string | undefined;

function withStaged(
  target: string,
  bytes: Uint8Array,
  mode: number,
  guard: Guard,
  place: (temporary: string) => void,
): Shape {
  const temporary = join(dirname(target), `.plans-${randomUUID()}.tmp`);
  try {
    const fd = openSync(temporary, "wx", mode);

    let staged: Shape;
    try {
      for (let written = 0; written < bytes.byteLength;)
        written += writeSync(fd, bytes, written, bytes.byteLength - written);

      fchmodSync(fd, mode);
      fsyncSync(fd);
      staged = shapeOf(fstatSync(fd));
    } finally {
      closeSync(fd);
    }

    const blocked = guard();
    if (blocked !== undefined) throw new Blocked(blocked);

    place(temporary);
    syncDirectory(dirname(target));
    return staged;
  } finally {
    rmSync(temporary, { force: true });
  }
}

function createFile(target: string, bytes: Uint8Array, mode: number, guard: Guard): Shape {
  return withStaged(target, bytes, mode, guard, (temporary) => {
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Moved();
      throw error;
    }
  });
}

function replaceFile(
  target: string,
  bytes: Uint8Array,
  mode: number,
  read: Shape,
  guard: Guard,
): Shape {
  return withStaged(target, bytes, mode, guard, (temporary) => {
    if (!sameShape(shapeOf(lstatSync(target)), read)) throw new Moved();
    renameSync(temporary, target);
  });
}

type Outcome =
  | { kind: "landed"; replaced: boolean; shape: Shape | undefined }
  | { kind: "stale" }
  | { kind: "conflict"; local: string }
  | { kind: "blocked"; reason: string };

function sameBytes(
  store: Store,
  node: Node,
  target: string,
  stat: Stats,
  executable: boolean,
): Outcome {
  const here = newestFileHere(store, node.path);
  if (here !== undefined && compareEvents(node, here.node) < 0) return { kind: "stale" };
  if (shapeOf(stat).executable === executable)
    return { kind: "landed", replaced: false, shape: undefined };

  chmodSync(target, modeFor(stat.mode & 0o777, executable));
  return { kind: "landed", replaced: false, shape: shapeOf(lstatSync(target)) };
}

function land(store: Store, root: string, node: Pending, bytes: Uint8Array): Outcome {
  const blocked = containment(root, node.path);
  if (blocked !== undefined) return { kind: "blocked", reason: blocked };

  const target = join(root, node.path);
  const executable = node.executable === 1;
  const guard = () => containment(root, node.path);

  let read: { stat: Stats; bytes: Uint8Array } | undefined;
  try {
    const stat = lstatSync(target);
    read = { stat, bytes: readFileSync(target) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (read === undefined) {
    mkdirSync(dirname(target), { recursive: true });
    const shape = createFile(target, bytes, modeFor(undefined, executable), guard);
    return { kind: "landed", replaced: false, shape };
  }

  const digest = sha256(read.bytes);
  if (digest === node.sha256) return sameBytes(store, node, target, read.stat, executable);
  if (!descendsFromHere(store, node, digest)) return { kind: "conflict", local: digest };

  const mode = modeFor(read.stat.mode & 0o777, executable);
  const shape = replaceFile(target, bytes, mode, shapeOf(read.stat), guard);
  return { kind: "landed", replaced: true, shape };
}

type Tally = { landed: Landed[]; conflicts: Conflicted[]; refused: Refused[] };

function landGroup(store: Store, root: string, nodes: readonly Pending[], tally: Tally): void {
  const conflict = (node: Pending, local: string) => {
    recordConflict(store, {
      project: node.project,
      plan: FILE_PLAN,
      path: node.path,
      sha256: node.sha256,
      event: node.id,
      local,
    });

    settle(store, node.id, "conflict");
    tally.conflicts.push({ path: node.path, project: node.project, plan: FILE_PLAN });
  };

  const chosen = newest(nodes);
  const content = contentOf(store, chosen);
  if (content.kind === "waiting") return;
  if (content.kind === "gone" || newerGone(store, chosen)) {
    for (const node of nodes) settle(store, node.id, "gone");
    return;
  }

  if (sha256(content.bytes) !== chosen.sha256 || content.bytes.byteLength !== chosen.size) {
    settle(store, chosen.id, "refused");
    tally.refused.push({ path: chosen.path, reason: "its chunks do not match its sha256" });
    return;
  }

  let outcome: Outcome;
  try {
    outcome = land(store, root, chosen, content.bytes);
  } catch (error) {
    if (error instanceof Blocked) outcome = { kind: "blocked", reason: error.message };
    else {
      if (!(error instanceof Moved))
        tally.refused.push({ path: chosen.path, reason: (error as Error).message });

      return;
    }
  }

  if (outcome.kind === "blocked") {
    settle(store, chosen.id, "blocked");
    tally.refused.push({ path: chosen.path, reason: outcome.reason });
    return;
  }

  if (outcome.kind === "stale") {
    for (const node of nodes) settle(store, node.id, "superseded");
    return;
  }

  const local = outcome.kind === "landed" ? chosen.sha256 : outcome.local;
  const ancestors = ancestry(store, chosen);
  const others = nodes.filter((node) => node !== chosen);
  const concurrent = others.filter((node) => !ancestors.has(node.sha256) && node.sha256 !== local);
  for (const node of others) if (!concurrent.includes(node)) settle(store, node.id, "superseded");

  if (outcome.kind === "landed") {
    settle(store, chosen.id, "landed");
    tally.landed.push({ path: chosen.path, author: chosen.author, replaced: outcome.replaced });
    if (outcome.shape !== undefined) remember(store, chosen.path, outcome.shape);
  } else conflict(chosen, outcome.local);

  for (const node of concurrent) conflict(node, local);
}

export function landFiles(store: Store, root: string, deadline: number): FileLandings {
  const tally: Tally = { landed: [], conflicts: [], refused: [] };
  reopen(store, root);

  for (const nodes of byPath(pending(store)).values()) {
    if (Date.now() > deadline) break;
    write(store, () => landGroup(store, root, nodes, tally));
  }

  return tally;
}
