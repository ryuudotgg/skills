import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ADOPTED, moveRefusal, type IndexRow, type LeaseHeld } from "skills-core";
import type { MoveHub, MoveIo } from "../hub/move.ts";
import type { LeaseSession } from "../hub/plan-leases.ts";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { describe, read } from "../read.ts";
import { OPERATIONS } from "../stack/restack.ts";
import { recordBase } from "../stack/skills-base.ts";
import { markStarted } from "./claim.ts";
import { openPlansStore } from "./commit.ts";
import { Refusal } from "./import.ts";
import { indexPath, plansDir } from "./index-tsv.ts";
import { enrolledDevice, heldBy } from "./leases.ts";
import { newestFacts } from "./machine.ts";
import { MAX_PACK, openPack, PackRefusal, scratchFor, UNVERIFIED, type Opened } from "./pack.ts";
import { readStore } from "./projection.ts";
import { appendEvent, projectMoves, projectRows, type Store } from "./store.ts";

const GIT_DEADLINE = 60_000;

const FETCH_DEADLINE = 120_000;

type Source = { readonly kind: "file"; readonly path: string } | { readonly kind: "hub" };

type Checked = {
  readonly checkout: string;
  readonly gitDirs: readonly string[];
  readonly row: IndexRow;
  readonly pack: Opened;
  readonly sha256: string;
  readonly adoptedBefore: number;
  readonly note: string;
  readonly previous: string;
  readonly patched: readonly string[];
  readonly baseRef: string;
};

class AdoptRefusal extends Error {
  override name = "AdoptRefusal";
}

function refuse(reason: string): never {
  throw new AdoptRefusal(reason);
}

function parse(
  args: readonly string[],
  cwd: string,
): { project: string; id: string; source: Source } | undefined {
  const [project, id, flag, value, ...extra] = args;
  if (project === undefined || id === undefined || extra.length > 0) return undefined;
  if (!/^[\w-]+$/.test(id)) return undefined;
  if (flag === undefined) return { project, id, source: { kind: "hub" } };
  if (flag !== "--file" || value === undefined || value === "" || value.startsWith("-"))
    return undefined;

  return { project, id, source: { kind: "file", path: resolve(cwd, value) } };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function git(
  checkout: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  deadline = GIT_DEADLINE,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const result = await read(["git", ...args], { cwd: checkout, env, deadline });
  if (!result.ok) refuse(`git ${args[0]} failed: ${describe(result.failure)}`);
  return result;
}

async function must(checkout: string, args: readonly string[], env: NodeJS.ProcessEnv) {
  const result = await git(checkout, args, env);
  if (result.code !== 0)
    refuse(`git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`);

  return result.stdout;
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function recordedCheckout(store: Store, project: string): string {
  const path = newestFacts(store)?.checkouts[project]?.path;
  if (path === undefined)
    refuse(
      `no checkout of ${project} recorded on this machine, run skills machine refresh from it`,
    );

  if (!existsSync(path))
    refuse(`${path} recorded for ${project} is gone, run skills machine refresh from a checkout`);

  return path;
}

function adoptedHere(store: Store, project: string, id: string): string | undefined {
  const newest = store.db
    .query(
      `SELECT machine, payload ->> '$.branch' AS branch FROM events
       WHERE type = ? AND project = ? AND plan = ? AND quarantined IS NULL
       ORDER BY wall DESC, counter DESC LIMIT 1`,
    )
    .get(ADOPTED, project, id) as { machine: string; branch: string | null } | null;

  return newest?.machine === store.machine ? (newest.branch ?? undefined) : undefined;
}

function adoptions(store: Store, project: string, id: string, sha: string): number {
  const counted = store.db
    .query(
      `SELECT count(*) AS n FROM events
       WHERE type = ? AND project = ? AND plan = ? AND payload ->> '$.sha256' = ?
         AND machine = ? AND quarantined IS NULL`,
    )
    .get(ADOPTED, project, id, sha, store.machine) as { n: number };

  return counted.n;
}

function snapshot(path: string): Uint8Array {
  let descriptor: number;
  try {
    if (!statSync(path).isFile()) refuse(`${path} is not a file`);
    descriptor = openSync(path, "r");
  } catch (error) {
    if (error instanceof AdoptRefusal) throw error;
    refuse(`cannot read ${path}`);
  }

  try {
    if (!fstatSync(descriptor).isFile()) refuse(`${path} is not a file`);

    const buffer = Buffer.alloc(MAX_PACK + 1);

    let size = 0;
    for (let got = 1; got > 0 && size < buffer.length; size += got)
      got = readSync(descriptor, buffer, size, buffer.length - size, null);

    if (size > MAX_PACK) refuse(`the pack is over ${MAX_PACK / 1024 / 1024} MiB`);
    return new Uint8Array(buffer.subarray(0, size));
  } finally {
    closeSync(descriptor);
  }
}

async function pulledHub(store: Store, io: MoveIo): Promise<MoveHub> {
  const { hubConfigured, openMoveHub } = await import("../hub/move.ts");
  if (!hubConfigured(store, io.env)) refuse("no hub configured, pass --file <path>");

  const hub = await openMoveHub(store, io);
  await hub.pull();
  return hub;
}

async function packBytes(store: Store, hub: MoveHub, project: string, id: string) {
  const moved = projectMoves(store, project).get(id);
  const adopted = moved === undefined ? adoptedHere(store, project, id) : undefined;
  if (adopted !== undefined) refuse(`${id} is already adopted here on ${adopted}`);
  if (moved === undefined)
    refuse(`no move of ${id} recorded here, run skills hub sync or pass --file <path>`);

  if (moved.blobs.length === 0) refuse(`${id} was moved to a file, pass --file <path>`);

  const bytes = await hub.download(moved.blobs);
  if (bytes.length !== moved.size || sha256(bytes) !== moved.sha256) refuse(UNVERIFIED);

  return bytes;
}

function readRow(store: Store, project: string, id: string): IndexRow {
  const row = projectRows(store, project).find((entry) => entry.id === id);
  if (row === undefined) refuse(`no row ${id} in ${project}`);
  if (row.status !== "TODO" && row.status !== "DOING")
    refuse(`row ${id} is ${row.status}, only a TODO or DOING plan is adopted`);

  const moved = projectMoves(store, project).get(id);
  const moving = moved && moveRefusal(id, moved, enrolledDevice(store));
  if (moving) refuse(moving);

  const holder = heldBy(store, project, id);
  if (holder !== undefined) refuse(`${id} is held by ${holder}`);

  return row;
}

function matchPack(row: IndexRow, project: string, pack: Opened): void {
  const { manifest } = pack;
  if (manifest.project !== project || manifest.id !== row.id)
    refuse(`the pack holds ${manifest.project} ${manifest.id}, not ${project} ${row.id}`);

  if (row.slug !== manifest.slug)
    refuse(`row ${row.id} here is ${row.slug}, the pack holds ${manifest.slug}`);
}

function inside(root: string, path: string): boolean {
  const from = relative(root, path);
  return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

async function gitDirsOf(checkout: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const listed = await must(checkout, ["rev-parse", "--absolute-git-dir", "--git-common-dir"], env);
  return listed
    .split("\n")
    .filter(Boolean)
    .map((dir) => realpathSync(resolve(checkout, dir)));
}

async function operationInProgress(checkout: string, env: NodeJS.ProcessEnv) {
  const listed = await must(
    checkout,
    ["rev-parse", ...OPERATIONS.flatMap((name) => ["--git-path", name])],
    env,
  );

  const found = listed
    .split("\n")
    .filter(Boolean)
    .findIndex((path) => existsSync(resolve(checkout, path)));

  return OPERATIONS[found];
}

async function checkName(checkout: string, branch: string, env: NodeJS.ProcessEnv) {
  const named = await git(checkout, ["check-ref-format", "--branch", branch], env);
  if (named.code !== 0 || named.stdout.trim() !== branch || branch.startsWith("-"))
    refuse(`the pack names an invalid branch ${branch}`);
}

async function checkTree(checkout: string, branch: string, env: NodeJS.ProcessEnv) {
  await checkName(checkout, branch, env);

  const existing = await git(
    checkout,
    ["rev-parse", "--verify", "-q", `refs/heads/${branch}`],
    env,
  );

  if (existing.code === 0) refuse(`${branch} already exists in ${checkout}`);

  const status = await must(checkout, ["--no-optional-locks", "status", "--porcelain"], env);
  if (status.trim()) refuse(`${checkout} has uncommitted changes, commit or clear them first`);

  const operation = await operationInProgress(checkout, env);
  if (operation !== undefined) refuse(`${checkout} has ${operation} in progress, finish it first`);
}

async function hasCommit(checkout: string, sha: string, env: NodeJS.ProcessEnv) {
  return (await git(checkout, ["cat-file", "-e", `${sha}^{commit}`], env)).code === 0;
}

async function resolves(checkout: string, ref: string, env: NodeJS.ProcessEnv) {
  return (await git(checkout, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], env)).code === 0;
}

async function ensureBase(checkout: string, pack: Opened, env: NodeJS.ProcessEnv): Promise<string> {
  const { ref, sha } = pack.manifest.base;
  const branch = ref.startsWith("origin/") ? ref.slice("origin/".length) : ref;
  await checkName(checkout, branch, env);

  if (!(await hasCommit(checkout, sha, env))) {
    const fetch = ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", "origin"];
    const fetched = await git(checkout, [...fetch, `refs/heads/${branch}`], env, FETCH_DEADLINE);
    if (fetched.code !== 0 && !/couldn't find remote ref/i.test(fetched.stderr))
      refuse(`cannot fetch ${branch} from origin: ${fetched.stderr.trim()}`);

    if (!(await hasCommit(checkout, sha, env))) refuse(`base ${sha} is not in origin`);
  }

  if (pack.bundle !== undefined && !pack.prerequisites.includes(sha)) refuse(UNVERIFIED);
  if (await resolves(checkout, ref, env)) return ref;
  if (await resolves(checkout, `refs/remotes/origin/${branch}`, env)) return `origin/${branch}`;

  return refuse(
    `base ${ref} is not a branch in ${checkout}, run git fetch origin ${branch} and adopt again`,
  );
}

async function unbundle(checkout: string, pack: Opened, env: NodeJS.ProcessEnv) {
  if (pack.bundle === undefined) return;

  const result = await git(checkout, ["bundle", "unbundle", pack.bundle], env);
  if (result.code !== 0) refuse(`commits.bundle does not unbundle: ${result.stderr.trim()}`);
  if (!(await hasCommit(checkout, pack.manifest.head, env))) refuse(UNVERIFIED);
}

async function patchedPaths(checkout: string, patch: string, env: NodeJS.ProcessEnv) {
  if (lstatSync(patch).size === 0) return [];

  const listed = await git(checkout, ["apply", "--numstat", "-z", patch], env);
  if (listed.code !== 0) refuse(`tracked.patch is not a patch: ${listed.stderr.trim()}`);

  const fields = listed.stdout.split("\0");
  const found: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index] ?? "";
    const first = field.indexOf("\t");
    const second = first < 0 ? -1 : field.indexOf("\t", first + 1);
    if (second < 0) continue;

    const path = field.slice(second + 1);
    if (path !== "") found.push(path);
    else found.push(fields[++index] ?? "", fields[++index] ?? "");
  }

  return found.filter(Boolean);
}

function ancestorsOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, index) => parts.slice(0, index + 1).join("/"));
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

async function checkTargets(
  checked: Omit<Checked, "adoptedBefore">,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const { checkout, pack, patched } = checked;
  for (const path of pack.untracked)
    if (path.split("/").some((part) => part.toLowerCase() === ".git"))
      refuse(`untracked ${path} would land inside .git`);

  const diff = ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=A"];
  const added = paths(await must(checkout, [...diff, "HEAD", pack.manifest.head], env));
  const targets = [...new Set([...pack.untracked, ...patched, ...added])];
  if (targets.length === 0) return;

  const ancestors = [...new Set(targets.flatMap(ancestorsOf))];
  const listed = ["ls-files", "-z", "--", ...targets, ...ancestors];
  const tracked = new Set(paths(await must(checkout, listed, env)));
  const holds = (path: string) =>
    tracked.has(path) || [...tracked].some((entry) => entry.startsWith(`${path}/`));

  const blocks = (path: string) => !holds(path) && present(join(checkout, path));
  const blocking =
    targets.find(blocks) ??
    ancestors.find((path) => blocks(path) && !lstatSync(join(checkout, path)).isDirectory());

  if (blocking !== undefined)
    refuse(`${blocking} already exists in ${checkout}, move it aside first`);
}

async function check(
  project: string,
  id: string,
  source: Source,
  scratch: string,
  session: LeaseSession,
  io: MoveIo,
): Promise<Checked> {
  const root = plansDir(io.env);
  const env = io.env;
  const store = await openPlansStore(root);
  try {
    const checkout = recordedCheckout(store, project);
    const hub = source.kind === "hub" ? await pulledHub(store, io) : undefined;
    const row = readRow(store, project, id);

    const file = join(scratch, "pack.tar");
    const bytes =
      source.kind === "file"
        ? snapshot(source.path)
        : await packBytes(
            store,
            hub ?? refuse("no hub configured, pass --file <path>"),
            project,
            id,
          );

    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 });

    const whole = sha256(bytes);
    const moved = projectMoves(store, project).get(id);
    if (source.kind === "file" && moved !== undefined && moved.sha256 !== whole) refuse(UNVERIFIED);

    const pack = await openPack(file, join(scratch, "pack"), env);
    matchPack(row, project, pack);

    const held = (await session.held(project, [id])).get(id);
    if (held !== undefined) refuse(`${id} ${held}`);

    await checkTree(checkout, pack.manifest.branch, env);

    const note = join(root, project, `.resume-${id}.md`);
    if (existsSync(note)) refuse(`${note} already exists, move it aside first`);

    const baseRef = await ensureBase(checkout, pack, env);
    await unbundle(checkout, pack, env);

    const symbolic = await git(checkout, ["symbolic-ref", "-q", "--short", "HEAD"], env);
    const previous =
      symbolic.code === 0
        ? symbolic.stdout.trim()
        : (await must(checkout, ["rev-parse", "HEAD"], env)).trim();

    const gitDirs = await gitDirsOf(checkout, env);
    const patched = await patchedPaths(checkout, pack.patch, env);
    const checked = {
      checkout,
      gitDirs,
      row,
      pack,
      baseRef,
      sha256: whole,
      note,
      previous,
      patched,
    };

    await checkTargets(checked, env);
    return { ...checked, adoptedBefore: adoptions(store, project, id, whole) };
  } finally {
    store.db.close();
  }
}

function nearestReal(path: string): string {
  for (let at = path; ; at = dirname(at))
    try {
      return join(realpathSync(at), relative(at, path));
    } catch {
      if (dirname(at) === at) return path;
    }
}

function same(path: string, from: string, mode: number): boolean {
  const placed = lstatSync(path);
  if (lstatSync(from).isSymbolicLink())
    return placed.isSymbolicLink() && readlinkSync(path) === readlinkSync(from);

  return (
    placed.isFile() &&
    (placed.mode & 0o7777) === mode &&
    readFileSync(path).equals(readFileSync(from))
  );
}

function placer(checkout: string) {
  const files: { path: string; from: string; mode: number }[] = [];
  const dirs = new Set<string>();

  return {
    claim(path: string): void {
      for (let at = dirname(path); at !== checkout && inside(checkout, at); at = dirname(at))
        if (present(at)) break;
        else dirs.add(at);
    },
    wrote(path: string, from: string): void {
      files.push({ path, from, mode: lstatSync(path).mode & 0o7777 });
    },
    undo(): void {
      const left = files.filter(({ path }) => present(path));
      const changed = left.find(({ path, from, mode }) => !same(path, from, mode));
      if (changed !== undefined)
        refuse(`${relative(checkout, changed.path)} changed since the adopt wrote it`);

      for (const { path } of left.toReversed()) rmSync(path, { force: true });

      for (const dir of [...dirs].sort((left, right) => right.length - left.length))
        try {
          rmdirSync(dir);
        } catch {}
    },
  };
}

function copyUntracked(checked: Checked, placed: ReturnType<typeof placer>): void {
  const real = realpathSync(checked.checkout);
  for (const path of checked.pack.untracked) {
    const from = join(checked.pack.root, "untracked", path);
    const to = join(checked.checkout, path);
    const parent = nearestReal(dirname(to));
    if (!inside(real, parent) || checked.gitDirs.some((dir) => inside(dir, parent)))
      refuse(`untracked ${path} would land outside the working tree of ${checked.checkout}`);

    if (present(to)) refuse(`untracked ${path} already exists in ${checked.checkout}`);

    placed.claim(to);
    mkdirSync(dirname(to), { recursive: true });

    try {
      if (lstatSync(from).isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else copyFileSync(from, to, constants.COPYFILE_EXCL);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") rmSync(to, { force: true });
      throw error;
    }

    placed.wrote(to, from);

    const now = new Date();
    lutimesSync(to, now, now);
  }
}

const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

type Step = { readonly label: string; readonly undo: () => unknown; readonly tree: boolean };

function journal(io: Io) {
  const steps: Step[] = [];
  let signal: string | undefined;
  const caught = (name: NodeJS.Signals) => {
    signal = name;
  };

  for (const name of SIGNALS) process.on(name, caught);

  return {
    done(label: string, undo: () => unknown, tree = false): void {
      steps.push({ label, undo, tree });
      this.check();
    },
    check(): void {
      if (signal !== undefined) refuse(`interrupted by ${signal}, the adopt is undone`);
    },
    async rollback(): Promise<void> {
      let stuck: string | undefined;
      for (const step of steps.toReversed())
        try {
          if (step.tree && stuck !== undefined) refuse(`the undo of ${stuck} failed`);
          await step.undo();
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          io.err(`adopt: could not undo ${step.label}: ${reason}\n`);
          if (step.tree) stuck ??= step.label;
        }
    },
    close(): void {
      for (const name of SIGNALS) process.off(name, caught);
    },
  };
}

type Held =
  | { readonly kind: "absent" }
  | { readonly kind: "dir" }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "file"; readonly copy: string; readonly mode: number };

function hold(path: string, copy: string): Held {
  if (!present(path)) return { kind: "absent" };

  const stat = lstatSync(path);
  if (stat.isDirectory()) return { kind: "dir" };
  if (stat.isSymbolicLink()) return { kind: "link", target: readlinkSync(path) };

  mkdirSync(dirname(copy), { recursive: true });
  copyFileSync(path, copy);
  return { kind: "file", copy, mode: stat.mode & 0o7777 };
}

function holds(path: string, held: Held): boolean {
  if (!present(path)) return held.kind === "absent";

  const stat = lstatSync(path);
  switch (held.kind) {
    case "absent":
      return false;

    case "dir":
      return stat.isDirectory();

    case "link":
      return stat.isSymbolicLink() && readlinkSync(path) === held.target;

    case "file":
      return (
        stat.isFile() &&
        (stat.mode & 0o7777) === held.mode &&
        readFileSync(path).equals(readFileSync(held.copy))
      );
  }
}

function put(path: string, held: Held): void {
  const stat = present(path) ? lstatSync(path) : undefined;
  if (held.kind === "absent" || (held.kind === "dir" && stat?.isDirectory())) return;

  mkdirSync(dirname(path), { recursive: true });

  if (held.kind === "dir") {
    if (stat !== undefined) rmSync(path);
    mkdirSync(path);
    return;
  }

  const staged = join(dirname(path), `.adopt-${randomUUID()}`);
  try {
    if (held.kind === "link") symlinkSync(held.target, staged);
    else copyFileSync(held.copy, staged);

    if (held.kind === "file") chmodSync(staged, held.mode);
    if (stat?.isDirectory()) rmSync(path, { recursive: true });

    renameSync(staged, path);
  } catch (error) {
    rmSync(staged, { force: true });
    throw error;
  }
}

function prune(checkout: string, path: string): void {
  for (let at = dirname(path); at !== checkout && inside(checkout, at); at = dirname(at))
    try {
      rmdirSync(at);
    } catch {
      break;
    }
}

async function unpatch(checkout: string, patch: string, scratch: string, env: NodeJS.ProcessEnv) {
  const full = (path: string) => join(checkout, path);
  const at = { ...env, GIT_INDEX_FILE: join(scratch, "patch.index"), GIT_LITERAL_PATHSPECS: "1" };
  const apply = ["apply", "--cached", "--whitespace=nowarn", patch];
  await must(checkout, ["read-tree", "HEAD"], at);
  await must(checkout, apply, at);

  const diff = ["diff-index", "--cached", "--name-only", "-z", "--no-renames", "HEAD"];
  const touched = paths(await must(checkout, diff, at));
  const before = new Map(
    touched.map((path, index) => [path, hold(full(path), join(scratch, "before", `${index}`))]),
  );

  await must(checkout, ["read-tree", "HEAD"], at);

  const entries: string[] = [];
  const removed: string[] = [];
  for (const [index, path] of touched.entries()) {
    const held = before.get(path);
    if (held?.kind === "absent") removed.push(path);
    if (held?.kind !== "file" && held?.kind !== "link") continue;

    const source = held.kind === "file" ? held.copy : join(scratch, "before", `${index}.link`);
    if (held.kind === "link") writeFileSync(source, held.target);

    const filters = held.kind === "file" ? `--path=${path}` : "--no-filters";
    const sha = (await must(checkout, ["hash-object", "-w", filters, source], at)).trim();
    const mode = held.kind === "link" ? "120000" : held.mode & 0o111 ? "100755" : "100644";
    entries.push("--cacheinfo", `${mode},${sha},${path}`);
  }

  if (entries.length > 0)
    await must(checkout, ["update-index", "--add", "--replace", ...entries], at);

  if (removed.length > 0)
    await must(checkout, ["update-index", "--force-remove", "--", ...removed], at);

  await must(checkout, apply, at);

  const held = new Set(paths(await must(checkout, ["ls-files", "-z", "--", ...touched], at)));
  const prefix = `${join(scratch, "expect")}${sep}`;
  const written = touched.filter((path) => held.has(path));
  if (written.length > 0)
    await must(checkout, ["checkout-index", `--prefix=${prefix}`, "--", ...written], at);

  const expect = (path: string, index: number): Held => {
    if (held.has(path)) return hold(join(prefix, path), join(scratch, "after", `${index}`));
    if ([...held].some((entry) => entry.startsWith(`${path}/`))) return { kind: "dir" };
    return { kind: "absent" };
  };

  const after = new Map(touched.map((path, index) => [path, expect(path, index)]));
  let finished = false;

  return {
    finish(): void {
      finished = true;
    },
    undo(): void {
      const was = (path: string) => before.get(path) ?? { kind: "absent" };
      const back = touched.filter((path) => !holds(full(path), was(path)));
      const wrote = (path: string) =>
        holds(full(path), after.get(path) ?? was(path)) || (!finished && !present(full(path)));

      const changed = back.find((path) => !wrote(path));
      if (changed !== undefined) refuse(`${changed} changed since the adopt wrote it`);

      const gone = new Set(back.filter((path) => was(path).kind === "absent"));
      const keeps = (path: string) =>
        readdirSync(full(path), { recursive: true, withFileTypes: true }).some(
          (entry) =>
            !entry.isDirectory() &&
            !gone.has(relative(checkout, join(entry.parentPath, entry.name))),
        );

      const blocked = back.find(
        (path) =>
          was(path).kind !== "dir" &&
          present(full(path)) &&
          lstatSync(full(path)).isDirectory() &&
          keeps(path),
      );

      if (blocked !== undefined) refuse(`${blocked} holds files the adopt did not write`);

      for (const path of [...gone].sort((left, right) => right.length - left.length)) {
        rmSync(full(path), { recursive: true, force: true });
        prune(checkout, full(path));
      }

      for (const path of back
        .filter((entry) => !gone.has(entry))
        .sort((left, right) => left.length - right.length))
        put(full(path), was(path));
    },
  };
}

async function onBranch(checkout: string, branch: string, env: NodeJS.ProcessEnv) {
  const head = await git(checkout, ["symbolic-ref", "-q", "HEAD"], env);
  return head.code === 0 && head.stdout.trim() === `refs/heads/${branch}`;
}

async function committed(project: string, id: string, checked: Checked, io: Io) {
  const counted = await readStore(plansDir(io.env), (store) =>
    adoptions(store, project, id, checked.sha256),
  );

  return counted.kind === "read" && counted.value > checked.adoptedBefore;
}

async function apply(
  checked: Checked,
  project: string,
  id: string,
  session: LeaseSession,
  scratch: string,
  io: Io,
): Promise<void> {
  const { checkout, pack, previous, row } = checked;
  const { branch, head } = pack.manifest;
  const env = io.env;

  const changes = journal(io);
  try {
    const lease = await session.start(project, id);
    if (lease.kind === "refused") refuse(`${id} ${lease.reason}`);
    if (lease.kind === "provisional")
      io.err(`lease provisional, ${lease.offline ? "hub offline" : "hub refused"}\n`);

    const leases = new Map<string, LeaseHeld>();
    if (lease.kind === "taken" || lease.kind === "provisional") leases.set(id, lease.held);
    changes.done("the lease", () => session.abandon());

    await must(checkout, ["branch", "--no-track", branch, head], env);
    changes.done(`branch ${branch}`, async () => {
      if (await onBranch(checkout, branch, env)) refuse(`the checkout is still on ${branch}`);
      await must(checkout, ["update-ref", "-d", `refs/heads/${branch}`, head], env);
      await git(checkout, ["config", "--remove-section", `branch.${branch}`], env);
    });

    const switching = ["git", "switch", "--quiet", "--no-overwrite-ignore", branch];
    const switched = await read(switching, { cwd: checkout, env, deadline: GIT_DEADLINE });

    if (await onBranch(checkout, branch, env))
      changes.done(
        "the checkout",
        () => must(checkout, ["checkout", "--quiet", "--no-overwrite-ignore", previous, "--"], env),
        true,
      );

    if (!switched.ok) refuse(`git switch failed: ${describe(switched.failure)}`);
    if (switched.code !== 0)
      refuse(`git switch failed: ${switched.stderr.trim() || `exit ${switched.code}`}`);

    if (!(await recordBase(checkout, branch, checked.baseRef, io)))
      refuse(`cannot record the base of ${branch}`);

    if (checked.patched.length > 0) {
      const apply = ["apply", "--whitespace=nowarn", pack.patch];
      const fits = await git(checkout, [...apply, "--check"], env);
      if (fits.code !== 0) refuse(`tracked.patch does not apply: ${fits.stderr.trim()}`);

      const patch = await unpatch(checkout, pack.patch, scratch, env);
      changes.done("the patch", () => patch.undo(), true);

      const applied = await git(checkout, apply, env);
      if (applied.code !== 0) refuse(`tracked.patch does not apply: ${applied.stderr.trim()}`);

      patch.finish();
    }

    const copied = placer(checkout);
    changes.done("the untracked files", () => copied.undo(), true);
    copyUntracked(checked, copied);

    const note = openSync(checked.note, "wx");
    changes.done(checked.note, () => rmSync(checked.note, { force: true }));

    try {
      writeSync(note, readFileSync(pack.resume));
    } finally {
      closeSync(note);
    }

    const payload = { sha256: checked.sha256, checkout, branch };
    const claimed = await markStarted(
      indexPath(project, env),
      project,
      branch,
      [row],
      env,
      leases,
      (tx) => {
        changes.check();
        appendEvent(tx.store, {
          kind: "stored",
          type: ADOPTED,
          at: tx.at,
          project,
          plan: id,
          payload,
        });
      },
    );

    if (claimed === undefined) refuse(`row ${id} left ${project}`);
    if ("refusal" in claimed) refuse(`row ${id} changed since its checks (${claimed.refusal})`);
  } catch (error) {
    if (await committed(project, id, checked, io)) {
      const reason = error instanceof Error ? error.message : String(error);
      io.err(`adopt: recorded, but ${reason}\n`);
      return;
    }

    await changes.rollback();
    throw error;
  } finally {
    changes.close();
  }
}

async function sessionDigests(project: string, id: string, io: Io): Promise<string> {
  const root = plansDir(io.env);
  const [{ sessionLines }, { localLinks }, { planDigests }] = await Promise.all([
    import("../sessions/ledger.ts"),
    import("../sessions/policy.ts"),
    import("../sessions/show.ts"),
  ]);

  const read = await readStore(root, (store) =>
    planDigests(store, sessionLines(store, localLinks(root)), project, id),
  );

  if (read.kind === "failed")
    io.err(`adopt: adopted, but session digests unread: ${read.reason}\n`);

  return read.kind === "read" ? read.value : "";
}

async function adopt(project: string, id: string, source: Source, io: MoveIo): Promise<string> {
  const scratch = scratchFor(id, "adopt-");
  const { leaseSession } = await import("../hub/plan-leases.ts");
  const session = await leaseSession(io.env);
  try {
    const checked = await withLock(join(plansDir(io.env), "adopt.lock"), "adopt", async () => {
      const found = await check(project, id, source, scratch, session, io);
      await apply(found, project, id, session, scratch, io);
      return found;
    });

    const { branch } = checked.pack.manifest;
    const digests = await sessionDigests(project, id, io);
    return `adopted ${project} ${id} into ${checked.checkout} on ${branch}\n/plans do ${id}\n${digests}`;
  } finally {
    session.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function adoptVerb(
  args: readonly string[],
  usage: string,
  io: MoveIo,
): Promise<number> {
  const parsed = parse(args, io.cwd);
  if (parsed === undefined) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    io.out(await adopt(parsed.project, parsed.id, parsed.source, io));
    return 0;
  } catch (error) {
    if (error instanceof AdoptRefusal || error instanceof PackRefusal || error instanceof Refusal) {
      io.err(`adopt: ${error.message}\n`);
      return 1;
    }

    const { refusalOf } = await import("../hub/leases.ts");
    io.err(`adopt: ${refusalOf(error)}\n`);
    return 1;
  }
}
