import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { HEARTBEAT, leasePlan, MOVED, projectPolicy, type IndexRow, type Moved } from "skills-core";
import type { MoveHub, MoveIo, Party } from "../hub/move.ts";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { checkoutIs, gitOutput } from "../project.ts";
import { projectPolicies } from "../sessions/policy.ts";
import { recordedBase } from "../stack/skills-base.ts";
import { openPlansStore } from "./commit.ts";
import { plansDir } from "./index-tsv.ts";
import { enrolledDevice, heldBy, leasesIn, recordReleased } from "./leases.ts";
import { newestFacts } from "./machine.ts";
import { buildPack, PackRefusal, type Pack } from "./pack.ts";
import { appendEvent, projectMoves, projectRows, write, type Store } from "./store.ts";

type Destination =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "hub"; readonly to: string | undefined };

type Route =
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "hub"; readonly hub: MoveHub; readonly target: Party | undefined };

type Plan = {
  readonly row: IndexRow;
  readonly threads: string[] | undefined;
  readonly sessions: string[] | undefined;
  readonly moving: Moved | undefined;
  readonly heldBy: string | undefined;
};

class MoveRefusal extends Error {
  override name = "MoveRefusal";
}

function refuse(reason: string): never {
  throw new MoveRefusal(reason);
}

function parse(
  args: readonly string[],
  cwd: string,
): { project: string; id: string; to: Destination } | undefined {
  const [project, id, flag, value, ...extra] = args;
  if (project === undefined || id === undefined || extra.length > 0) return undefined;

  const to = destination(cwd, flag, value);
  return to && { project, id, to };
}

function destination(cwd: string, flag?: string, value?: string): Destination | undefined {
  if (flag === undefined) return { kind: "hub", to: undefined };
  if (value === undefined || value === "" || value.startsWith("-")) return undefined;
  if (flag === "--file") return { kind: "file", path: resolve(cwd, value) };
  return flag === "--to" ? { kind: "hub", to: value } : undefined;
}

function column(store: Store, sql: string, ...params: string[]): string[] {
  const rows = store.db.query(sql).all(...params) as { value: string | null }[];
  return [...new Set(rows.flatMap((row) => (row.value ? [row.value] : [])))].sort();
}

function readPlan(store: Store, project: string, id: string): Plan {
  const row = projectRows(store, project).find((entry) => entry.id === id);
  if (row === undefined) refuse(`no row ${id} in ${project}`);
  if (row.status !== "DOING") refuse(`row ${id} is ${row.status}, only a DOING plan moves`);

  const off = projectPolicy(projectPolicies(store), project) === "off";
  return {
    row,
    threads: off
      ? undefined
      : column(
          store,
          `SELECT payload ->> '$.detail' AS value FROM events
           WHERE project = ? AND plan = ? AND type = 'thread' AND quarantined IS NULL`,
          project,
          id,
        ),
    sessions: off
      ? undefined
      : column(
          store,
          `SELECT payload ->> '$.session' AS value FROM events
           WHERE project = ? AND plan = ? AND type = ? AND quarantined IS NULL`,
          project,
          id,
          HEARTBEAT,
        ),
    moving: projectMoves(store, project).get(id),
    heldBy: heldBy(store, project, id),
  };
}

function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(checkout: string, path: string): boolean {
  const from = relative(real(checkout), join(real(dirname(path)), basename(path)));
  return from === "" || (from !== ".." && !from.startsWith(`..${sep}`) && !isAbsolute(from));
}

async function holdingCheckout(cwd: string, branch: string, io: Io): Promise<string> {
  const listed = await gitOutput(cwd, ["worktree", "list", "--porcelain", "-z"], {}, io);
  if (listed === undefined) refuse("cannot list the checkouts of this repository");

  let path: string | undefined;
  for (const field of listed.split("\0"))
    if (field.startsWith("worktree ")) path = field.slice("worktree ".length);
    else if (path !== undefined && field === `branch refs/heads/${branch}`) return path;

  return refuse(`no checkout holds ${branch}, check it out first`);
}

async function baseOf(
  checkout: string,
  branch: string,
  io: Io,
): Promise<{ ref: string; sha: string }> {
  const recorded = await recordedBase(checkout, branch, io);
  if (!recorded.ok) refuse(recorded.reason);
  if (recorded.base === undefined) refuse(`${branch} has no recorded skills-base`);

  const sha = await gitOutput(checkout, ["merge-base", recorded.base, branch], {}, io);
  if (!sha?.trim()) refuse(`${branch} shares no commit with its base ${recorded.base}`);

  return { ref: recorded.base, sha: sha.trim() };
}

const NO_LINKS = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "EXDEV", "EMLINK"]);

function codeOf(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

function placeDirect(path: string, bytes: Uint8Array): boolean {
  try {
    writeFileSync(path, bytes, { flag: "wx" });
    return true;
  } catch (error) {
    if (codeOf(error) !== "EEXIST") rmSync(path, { force: true });
    return false;
  }
}

async function writeExclusive(
  path: string,
  bytes: Uint8Array,
  commit: () => Promise<void>,
): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, bytes, { flag: "wx" });
  } catch (error) {
    refuse(`cannot write ${path}: ${codeOf(error)}`);
  }

  try {
    await commit();
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }

  try {
    linkSync(temporary, path);
  } catch (error) {
    const code = codeOf(error);
    if (!NO_LINKS.has(code) || !placeDirect(path, bytes))
      refuse(
        `the move is recorded but ${path} could not be written (${code}), the pack is at ${temporary}`,
      );
  }

  rmSync(temporary, { force: true });
}

function sameMove(left: Moved | undefined, right: Moved): boolean {
  return (
    left !== undefined &&
    left.sha256 === right.sha256 &&
    left.toDevice === right.toDevice &&
    left.blobs.length === right.blobs.length &&
    left.blobs.every((locator, index) => locator === right.blobs[index])
  );
}

function newestMoved(store: Store, project: string, id: string): string | undefined {
  const row = store.db
    .query(
      `SELECT id FROM events WHERE project = ? AND plan = ? AND type = ? AND quarantined IS NULL
       ORDER BY wall DESC, counter DESC, machine DESC, id DESC LIMIT 1`,
    )
    .get(project, id, MOVED) as { id: string } | null;

  return row?.id;
}

function record(store: Store, project: string, id: string, moved: Moved): string {
  return write(store, () => {
    const now = Date.now();
    const plan = readPlan(store, project, id);
    if (plan.heldBy !== undefined) refuse(`${id} is held by ${plan.heldBy}`);

    const kept = sameMove(plan.moving, moved) ? newestMoved(store, project, id) : undefined;
    const event =
      kept ??
      appendEvent(store, {
        kind: "stored",
        type: MOVED,
        at: now,
        project,
        plan: id,
        payload: moved,
      });

    const self = enrolledDevice(store);
    const claim = self && leasesIn(store, project).get(leasePlan(project, id))?.claims.get(self);
    if (self && claim)
      recordReleased(store, now, project, id, {
        device: self,
        acquired: claim.acquired,
        by: self,
        mode: "release",
        moving: moved.toDevice ?? "any",
      });

    return event;
  });
}

async function hubRoute(
  store: Store,
  project: string,
  id: string,
  wanted: string | undefined,
  io: MoveIo,
): Promise<Route> {
  const { openMoveHub } = await import("../hub/move.ts");
  const hub = await openMoveHub(store, io);

  const picked = wanted === undefined ? undefined : hub.target(wanted);
  if (picked !== undefined && "refusal" in picked) refuse(picked.refusal);

  const holder = await hub.holder(project, id);
  if (holder !== undefined) refuse(`${id} is held by ${holder.label}`);

  return { kind: "hub", hub, target: picked };
}

function summary(project: string, id: string, shown: string, pack: Pack): string {
  return `moved ${project} ${id} to ${shown}, ${pack.commits} commits, ${pack.changed} changed files, ${pack.untracked} untracked`;
}

async function move(project: string, id: string, to: Destination, io: MoveIo): Promise<string> {
  const root = plansDir(io.env);
  const store = await openPlansStore(root);
  try {
    const plan = readPlan(store, project, id);
    const elsewhere = await checkoutIs(io.cwd, project, io);
    if (elsewhere) refuse(elsewhere);

    const { hubConfigured } = await import("../hub/move.ts");
    if (to.kind === "file" && present(to.path)) refuse(`${to.path} already exists`);
    if (to.kind === "hub" && !hubConfigured(store, io.env))
      refuse(
        to.to === undefined
          ? "no hub configured, pass --file <path>"
          : "--to needs an enrolled hub, pass --file <path>",
      );

    const { branch, slug } = plan.row;
    const checkout = await holdingCheckout(io.cwd, branch, io);
    if (to.kind === "file" && inside(checkout, to.path))
      refuse(`${to.path} is inside the checkout being moved, write it elsewhere`);

    const base = await baseOf(checkout, branch, io);

    const resume = join(root, project, `.resume-${id}.md`);
    if (plan.heldBy !== undefined) refuse(`${id} is held by ${plan.heldBy}`);
    if (!existsSync(resume)) refuse(`${resume} is missing, write the resume note first`);

    const route = to.kind === "file" ? to : await hubRoute(store, project, id, to.to, io);
    const target = route.kind === "hub" ? route.target : undefined;

    const facts = newestFacts(store);
    const source =
      route.kind === "hub"
        ? route.hub.self
        : { device: store.machine, label: facts?.label ?? hostname() };

    const pack = await buildPack(
      {
        project,
        id,
        slug,
        branch,
        checkout,
        base,
        source,
        to: target?.label ?? null,
        threads: plan.threads,
        sessions: plan.sessions,
        resume,
      },
      io.env,
    );

    const shown = route.kind === "file" ? route.path : (target?.label ?? "any");
    const key = { project, plan: id, sha256: pack.sha256 };
    const blobs = route.kind === "hub" ? await route.hub.upload(key, pack.bytes) : [];
    const moved: Moved = {
      sha256: pack.sha256,
      size: pack.bytes.length,
      source: source.device,
      to: target?.label ?? null,
      toDevice: target?.device ?? null,
      head: pack.head,
      base: base.sha,
      blobs,
    };

    const commit = () => record(store, project, id, moved);
    const lock = join(root, "hub.lock");
    const locked = async () => {
      if (enrolledDevice(store) !== undefined) await withLock(lock, "hub sync", commit);
      else commit();
    };

    if (route.kind === "file") await writeExclusive(route.path, pack.bytes, locked);
    else if (!(await route.hub.publish(project, id, commit)))
      io.err("move: the move waits to reach the hub, run skills hub sync\n");

    return `${summary(project, id, shown, pack)}\n/plans do ${id}\n`;
  } finally {
    store.db.close();
  }
}

export async function moveVerb(
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
    io.out(await move(parsed.project, parsed.id, parsed.to, io));
    return 0;
  } catch (error) {
    if (!(error instanceof MoveRefusal) && !(error instanceof PackRefusal)) {
      const { refusalOf } = await import("../hub/leases.ts");
      io.err(`move: ${refusalOf(error)}\n`);
      return 1;
    }

    io.err(`move: ${error.message}\n`);
    return 1;
  }
}
