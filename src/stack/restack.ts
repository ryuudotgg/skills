import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Io } from "../io.ts";
import { indexIn, plansDir, readIndex } from "../plans/index-tsv.ts";
import { describe, GRACE, pipe, read as readProcess, within } from "../read.ts";
import { recordedBase } from "./skills-base.ts";

export class Refusal extends Error {}
export class UnknownOutcome extends Refusal {}

class Unverified extends Refusal {}

export type Move = { branch: string; old: string; next: string };
export type Holder = { path: string; admin: string; current: boolean };
export type Plan = { kind: "planned"; moves: Move[] } | { kind: "conflict"; reason: string };
export type Applied = { completed: Move[]; error?: string };

export type Session = Io & {
  indexes: readonly string[];
  ownRows: ReadonlySet<string>;
  sink?: string[];
};

type Run = { code: number; stdout: string; bytes: Uint8Array; stderr: string };
type GitOptions = {
  env?: Record<string, string>;
  input?: Uint8Array;
  stderr?: "pass" | "capture" | "ignore";
  stdoutToStderr?: boolean;
  write?: boolean;
};

const READ_DEADLINE = 60_000;
const OPERATIONS = ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer", "index.lock"];
const HEADERS = new Set(["tree", "parent", "author", "committer"]);

export function refuse(reason: string): never {
  throw new Refusal(reason);
}

function emit(s: Session, text: string): void {
  if (!text) return;
  if (s.sink) s.sink.push(text);
  else s.err(text);
}

export async function git(s: Session, args: readonly string[], options: GitOptions = {}): Promise<Run> {
  const mode = options.stderr ?? "pass";
  if (!options.write) {
    const result = await readProcess(["git", ...args], {
      cwd: s.cwd,
      env: { ...s.env, ...options.env },
      deadline: READ_DEADLINE,
    });

    if (!result.ok) {
      const stderr = describe(result.failure) + "\n";
      if (mode === "pass") emit(s, stderr);
      return { code: -1, stdout: "", bytes: new Uint8Array(), stderr };
    }

    if (options.stdoutToStderr) emit(s, result.stdout);
    if (mode === "pass") emit(s, result.stderr);

    return { code: result.code, stdout: options.stdoutToStderr ? "" : result.stdout, bytes: result.bytes, stderr: result.stderr };
  }

  const child = Bun.spawn(["git", ...args], {
    cwd: s.cwd,
    env: { ...s.env, ...options.env },
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: mode === "pass" && !s.sink && !s.capture ? "inherit" : "pipe",
  });

  const output = pipe(child.stdout);
  const errors = child.stderr instanceof ReadableStream ? pipe(child.stderr) : undefined;
  try {
    await child.exited;

    await within(Promise.all([output.done, errors?.done]), GRACE);
    const bytes = output.bytes();
    const stdout = new TextDecoder().decode(bytes);
    const stderr = errors ? new TextDecoder().decode(errors.bytes()) : "";

    if (options.stdoutToStderr) emit(s, stdout);
    if (mode === "pass") emit(s, stderr);

    return { code: child.exitCode ?? -1, stdout: options.stdoutToStderr ? "" : stdout, bytes, stderr };
  } finally {
    output.cancel();
    errors?.cancel();
    child.unref();
  }
}

export async function read(s: Session, args: readonly string[], reason: string, accept: readonly number[] = [0]): Promise<Run> {
  const run = await git(s, args);
  if (accept.includes(run.code)) return run;

  const subcommand = args.find((arg) => !arg.startsWith("-")) ?? "";
  return refuse(`${reason} (git ${subcommand} ${run.code < 0 ? "did not finish" : `exited ${run.code}`})`);
}

export async function ancestor(s: Session, older: string, newer: string, reason: string): Promise<boolean> {
  return (await read(s, ["merge-base", "--is-ancestor", older, newer], reason, [0, 1])).code === 0;
}

async function tip(s: Session, ref: string): Promise<string> {
  const run = await read(s, ["rev-parse", ref], `cannot read the tip of ${ref}`);
  return run.stdout.replace(/\n+$/, "");
}

function physical(path: string): string {
  return realpathSync(path);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function hasLine(path: string, line: string): boolean {
  try {
    return readFileSync(path, "utf8").split("\n").includes(line);
  } catch {
    return false;
  }
}

export function plansIndexes(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = plansDir(env);

  let projects: string[];
  try {
    projects = readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  } catch {
    projects = [];
  }

  return projects.map((name) => indexIn(`${root}/${name}`)).filter(isFile);
}

function doingRow(index: string, branch: string): string | undefined {
  try {
    return readIndex(index).find((row) => row.status === "DOING" && row.branch === branch)?.id;
  } catch {
    return refuse(`cannot read ${index}`);
  }
}

function activeRow(s: Session, branch: string): string {
  for (const index of s.indexes) {
    try {
      const id = readIndex(index).find((row) => row.status !== "DONE" && row.status !== "DROPPED" && row.branch === branch)?.id;
      if (id) return `row ${id} of ${basename(dirname(index))}, `;
    } catch {}
  }

  return "";
}

export async function requireReplay(s: Session): Promise<void> {
  const run = await git(s, ["replay", "-h"], { stderr: "capture" });
  if (!`${run.stdout}${run.stderr}`.includes("--ref-action")) refuse("git replay lacks --ref-action");
}

export async function findHolder(s: Session, branch: string): Promise<Holder | undefined> {
  const common = physical((await read(s, ["rev-parse", "--path-format=absolute", "--git-common-dir"], `cannot read the common git directory for ${branch}`)).stdout.trimEnd());
  const current = physical((await read(s, ["rev-parse", "--absolute-git-dir"], `cannot read the git directory for ${branch}`)).stdout.trimEnd());
  const bare = (await read(s, ["config", "--bool", "core.bare"], `cannot read core.bare for ${branch}`, [0, 1])).stdout.trimEnd();
  const worktrees = join(common, "worktrees");
  const linked = isDirectory(worktrees)
    ? readdirSync(worktrees).filter((name) => !name.startsWith(".")).sort().map((name) => join(worktrees, name))
    : [];

  let holder: Holder | undefined;
  for (const admin of [common, ...linked]) {
    if (!isDirectory(admin)) continue;
    if (admin === common && bare === "true") continue;

    const claim = (await read(s, [`--git-dir=${admin}`, "symbolic-ref", "-q", "HEAD"], `cannot read HEAD of ${admin} for ${branch}`, [0, 1])).stdout.trimEnd();
    const ref = `refs/heads/${branch}`;
    const claimed =
      claim === ref ||
      ["rebase-merge/head-name", "rebase-apply/head-name", "rebase-merge/update-refs"].some((file) => hasLine(join(admin, file), ref)) ||
      hasLine(join(admin, "BISECT_START"), branch);

    if (!claimed) continue;

    let path: string;
    if (admin === common) path = dirname(common);
    else {
      let gitdir = "";
      try {
        gitdir = readFileSync(join(admin, "gitdir"), "utf8").replace(/\n+$/, "");
      } catch {}

      if (!gitdir) refuse(`${branch} has a gone holder at ${admin} (missing gitdir)`);
      if (!gitdir.startsWith("/")) gitdir = `${admin}/${gitdir}`;

      path = dirname(gitdir);
      if (!existsSync(gitdir)) refuse(`${branch} is held by ${path} and its directory is gone`);
    }

    if (isDirectory(path)) path = physical(path);
    if (holder) refuse(`${branch} is held by both ${holder.path} and ${path}`);

    const resolved = physical(admin);
    holder = { path, admin: resolved, current: resolved === current };
  }

  return holder;
}

export async function checkIdle(s: Session, branch: string): Promise<Holder | undefined> {
  const holder = await findHolder(s, branch);
  if (!holder || holder.current) return holder;
  if (!isDirectory(holder.path)) refuse(`${branch} is held by ${holder.path} and its directory is gone`);

  if (!s.ownRows.has(branch))
    for (const index of s.indexes) {
      const id = doingRow(index, branch);
      if (id) refuse(`row ${id} in ${index} is DOING on ${branch}, held by ${holder.path}`);
    }

  for (const operation of OPERATIONS)
    if (existsSync(join(holder.admin, operation)))
      refuse(`${branch} is held by ${holder.path} with ${operation} in progress`);

  const status = await git(s, [
    "--no-optional-locks",
    `--git-dir=${holder.admin}`,
    `--work-tree=${holder.path}`,
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]);

  if (status.code !== 0) refuse(`cannot read holder ${holder.path} for ${branch}`);
  if (status.stdout.replace(/\n+$/, "")) refuse(`${branch} is held by ${holder.path} with tracked changes`);

  return holder;
}

function covered(path: string, set: ReadonlySet<string>): boolean {
  const parts = path.split("/");
  return parts.some((_, index) => set.has(parts.slice(0, index + 1).join("/")));
}

export async function ignoredCollision(s: Session, holder: Pick<Holder, "admin" | "path">, old: string, next: string): Promise<boolean> {
  const listed = await git(s, [
    `--git-dir=${holder.admin}`,
    `--work-tree=${holder.path}`,
    "ls-files",
    "-z",
    "-o",
    "-i",
    "--exclude-standard",
    "--directory",
  ]);

  if (listed.code !== 0) refuse(`cannot read ignored files in ${holder.path}`);

  const diff = await read(s, ["diff", "-z", "--no-renames", "--name-only", "--diff-filter=A", old, next], `cannot read ignored files in ${holder.path}`);
  const ignored = new Set(listed.stdout.split("\0").filter(Boolean).map((path) => path.replace(/\/$/, "")));
  const added = new Set(diff.stdout.split("\0").filter(Boolean));
  return [...ignored].some((path) => covered(path, added)) || [...added].some((path) => covered(path, ignored));
}

async function checkFiles(s: Session, branch: string, holder: Holder, old: string, next: string): Promise<void> {
  if (await ignoredCollision(s, holder, old, next))
    refuse(`${branch} is held by ${holder.path} and an ignored file sits where the move adds one`);

  const logging = (await read(s, ["config", "core.logAllRefUpdates"], `cannot read core.logAllRefUpdates for ${branch}`, [0, 1])).stdout.trimEnd().toLowerCase();
  const reflog = !["false", "no", "off", "0"].includes(logging) && (await read(s, ["reflog", "exists", `refs/heads/${branch}`], `cannot read the reflog of ${branch}`, [0, 1])).code === 0;
  if (!reflog) refuse(`${branch} is held by ${holder.path} and has no reflog to check the move against`);

  const scratch = mkdtempSync(join(tmpdir(), "restack-index."));
  const index = join(scratch, "index");
  try {
    try {
      copyFileSync(join(holder.admin, "index"), index);
    } catch {
      writeFileSync(index, "");
    }

    const merged = await git(
      s,
      [`--git-dir=${holder.admin}`, `--work-tree=${holder.path}`, "read-tree", "-n", "-u", "-m", "HEAD", next],
      { env: { GIT_INDEX_FILE: index }, stdoutToStderr: true },
    );

    if (merged.code !== 0) refuse(`${branch} is held by ${holder.path} and its files block the move`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// Git replay ignores commit.gpgsign and has no signing flag.
async function sign(s: Session, branch: string, base: string, replayed: string): Promise<string> {
  if ((await read(s, ["config", "--bool", "commit.gpgsign"], `cannot read commit.gpgsign for ${branch}`, [0, 1])).stdout.trimEnd() !== "true") return replayed;

  const failed = `cannot sign the replayed commits of ${branch}`;
  if ((await read(s, ["rev-list", "--merges", `${base}..${replayed}`], failed)).stdout.trim())
    refuse(`merge commit in ${branch}, cannot sign it`);

  const commits = (await read(s, ["rev-list", "--reverse", `${base}..${replayed}`], failed)).stdout.split("\n").filter(Boolean);

  let signed = base;
  for (const commit of commits) {
    const raw = (await read(s, ["cat-file", "commit", commit], failed)).bytes;
    const split = raw.findIndex((byte, index) => byte === 10 && raw[index + 1] === 10);
    const end = split < 0 ? raw.length : split;
    const header = new TextDecoder()
      .decode(raw.subarray(0, end))
      .split("\n")
      .map((line) => line.split(" ")[0] ?? "")
      .find((name) => name && !HEADERS.has(name));

    if (header) refuse(`cannot sign ${branch}: a replayed commit carries a ${header} header`);

    const author = async (format: string, ...extra: string[]) =>
      (await read(s, ["log", "-1", ...extra, `--format=${format}`, commit], failed)).stdout.replace(/\n+$/, "");

    const env = {
      GIT_AUTHOR_NAME: await author("%an"),
      GIT_AUTHOR_EMAIL: await author("%ae"),
      GIT_AUTHOR_DATE: await author("%ad", "--date=raw"),
    };

    const message = raw.subarray(Math.min(end + 2, raw.length));
    const created = await git(s, ["commit-tree", "-S", "-p", signed, `${commit}^{tree}`], { env, input: message, write: true });
    if (created.code !== 0) refuse(failed);

    signed = created.stdout.trim();
  }

  return signed;
}

async function recovery(s: Session, lowest: string | undefined, parent: string, parentOld: string): Promise<string> {
  if (!lowest) return "";

  const base = await recordedBase(s.cwd, lowest, s);
  if (!base.ok) return `, and ${base.reason}`;

  return base.base === parent ? "" : `, then skills restack-layer --onto ${parent} ${parentOld}`;
}

export async function plan(s: Session, parent: string, parentOld: string, layers: readonly string[]): Promise<Plan> {
  const verified = await read(s, ["rev-parse", "--verify", "--quiet", `${parent}^{commit}`], `cannot read parent ${parent}`, [0, 1]);
  if (verified.code === 1) refuse(`no such parent: ${parent}`);

  let onto = verified.stdout.trimEnd();
  let currentParent = parent;
  let currentOld = parentOld;
  const lowest = layers[0];

  let where = "";
  if (lowest) {
    const holder = await findHolder(s, lowest);
    where = `${activeRow(s, lowest)}held by ${holder?.path || "no checkout"}`;
  }

  const moves: Move[] = [];
  for (const layer of layers) {
    const old = await tip(s, `refs/heads/${layer}`);
    const holder = await findHolder(s, layer);
    // Git replay is experimental and defaults to writing refs, so pin print.
    const replay = await git(
      s,
      ["replay", "--ref-action=print", "--onto", onto, `${currentOld}..refs/heads/${layer}`],
      { stderr: "capture" },
    );

    if (replay.code !== 0) {
      if (replay.code !== 1)
        refuse(`cannot replay ${layer} onto ${currentParent}: ${replay.stderr.split("\n")[0] ?? ""}`);

      const suffix = layer === lowest ? "" : `, restack ${lowest} first`;
      return { kind: "conflict", reason: `rebase conflict on ${layer} onto ${currentParent}${suffix}, ${where}${await recovery(s, lowest, parent, parentOld)}` };
    }

    const output = replay.stdout.replace(/\n+$/, "");

    let next = onto;
    if (output) {
      const lines = output.split("\n");
      const fields = lines[0]?.trim().split(/\s+/) ?? [];
      const valid = lines.length === 1 && fields.length === 4 && fields[0] === "update" && fields[1] === `refs/heads/${layer}` && fields[3] === old;
      next = valid ? fields[2] ?? "" : refuse(`invalid replay output for ${layer}`);
    }

    const verified = await read(s, ["rev-parse", "--verify", "--quiet", `${next}^{commit}`], `cannot read the replay tip for ${layer}`, [0, 1]);
    if (verified.code === 1) refuse(`invalid replay tip for ${layer}`);

    next = verified.stdout.trimEnd();
    next = await sign(s, layer, onto, next);
    if (holder) await checkFiles(s, layer, holder, old, next);

    moves.push({ branch: layer, old, next });
    currentParent = layer;
    currentOld = old;
    onto = next;
  }

  return { kind: "planned", moves };
}

export async function push(s: Session, moves: readonly Move[], leases: ReadonlyMap<string, string>): Promise<Move[] | undefined> {
  const pushed = moves.filter((move) => {
    const lease = leases.get(move.branch);
    return lease && lease !== move.next;
  });

  if (pushed.length === 0) return pushed;

  const run = await git(
    s,
    [
      "push",
      "--quiet",
      "--atomic",
      ...pushed.map((move) => `--force-with-lease=refs/heads/${move.branch}:${leases.get(move.branch)}`),
      "origin",
      ...pushed.map((move) => `${move.next}:refs/heads/${move.branch}`),
    ],
    { stdoutToStderr: true, write: true },
  );

  if (run.code === 0) return pushed;

  const refs = pushed.map((move) => ({
    branch: move.branch,
    before: leases.get(move.branch) ?? refuse(`no lease for ${move.branch}`),
    after: move.next,
  }));

  return await settled(s, refs, run.code) === "all" ? pushed : undefined;
}

export async function settled(s: Session, refs: readonly { branch: string; before: string; after: string }[], code: number): Promise<"none" | "all"> {
  let listed;
  try {
    listed = await read(s, ["ls-remote", "origin", ...refs.map(({ branch }) => `refs/heads/${branch}`)], `cannot read origin after git push exited ${code}`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    const possible = refs.map(({ branch, before, after }) => `origin/${branch} is either ${before} or ${after}`).join("; ");
    throw new UnknownOutcome(`${error.message}; ${possible}`);
  }

  const tips = new Map(listed.stdout.split("\n").filter(Boolean).map((line) => {
    const [sha = "", ref = ""] = line.trim().split(/\s+/);
    return [ref, sha];
  }));

  const at = (key: "before" | "after") => refs.filter((ref) => tips.get(`refs/heads/${ref.branch}`) === ref[key]).length;
  const landed = at("after");
  if (landed === refs.length) return "all";
  if (landed === 0 && at("before") > 0) return "none";

  const actual = refs.map(({ branch, before, after }) => `origin/${branch} is ${tips.get(`refs/heads/${branch}`) ?? "missing"} (expected ${before} or ${after})`).join("; ");
  throw new UnknownOutcome(`git push exited ${code}; ${actual}`);
}

async function rollback(s: Session, moves: readonly Move[], pushed: readonly Move[], leases: ReadonlyMap<string, string>, start: number): Promise<string | undefined> {
  const undo = moves.slice(start).filter((move) => pushed.some((entry) => entry.branch === move.branch));
  if (undo.length === 0) return;

  const run = await git(
    s,
    [
      "push",
      "--quiet",
      "--atomic",
      ...undo.map((move) => `--force-with-lease=refs/heads/${move.branch}:${move.next}`),
      "origin",
      ...undo.map((move) => `${leases.get(move.branch) ?? refuse(`no lease for ${move.branch}`)}:refs/heads/${move.branch}`),
    ],
    { stdoutToStderr: true, write: true },
  );

  if (run.code === 0) return;

  const refs = undo.map((move) => ({
    branch: move.branch,
    before: move.next,
    after: leases.get(move.branch) ?? refuse(`no lease for ${move.branch}`),
  }));

  try {
    if (await settled(s, refs, run.code) === "none") return "lease rollback rejected";
  } catch (error) {
    if (!(error instanceof UnknownOutcome)) throw error;
    return error.message;
  }
}

async function move(s: Session, { branch, old, next }: Move): Promise<void> {
  const holder = await findHolder(s, branch);
  if ((await tip(s, `refs/heads/${branch}`)) !== old) refuse(`${branch} moved since the restack was planned`);
  if (old === next) return;

  if (!holder) {
    const updated = await git(s, ["update-ref", `refs/heads/${branch}`, next, old], { write: true });
    if (updated.code !== 0) refuse(`cannot move ${branch}`);
    return;
  }

  const reset = (target: string) =>
    git(s, [`--git-dir=${holder.admin}`, `--work-tree=${holder.path}`, "reset", "--quiet", "--keep", target], {
      stdoutToStderr: true,
      write: true,
    });

  if ((await reset(next)).code !== 0) refuse(`cannot move ${branch} held by ${holder.path}`);

  let verified;
  try {
    verified = await read(s, ["rev-parse", `refs/heads/${branch}`, `refs/heads/${branch}@{1}`], `cannot read the tip and previous tip of ${branch}`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    throw new Unverified(error.message);
  }

  const [current, previous = ""] = verified.stdout.trimEnd().split("\n");
  if (current !== next) refuse(`${branch} moved in holder ${holder.path} during the restack`);
  if (previous === old) return;
  if ((await reset(previous)).code !== 0) refuse(`cannot restore raced holder ${holder.path} on ${branch}`);
  refuse(`${branch} moved in holder ${holder.path} during the restack`);
}

export async function apply(
  s: Session,
  moves: readonly Move[],
  pushed: readonly Move[],
  leases: ReadonlyMap<string, string>,
  prefix: string,
): Promise<Applied> {
  const completed: Move[] = [];
  for (const [index, entry] of moves.entries()) {
    const sink: string[] = [];
    const captured = { ...s, sink };
    try {
      const holder = await checkIdle(captured, entry.branch);
      if (holder) await checkFiles(captured, entry.branch, holder, entry.old, entry.next);
      await move(captured, entry);
      completed.push(entry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const output = `${sink.join("")}${prefix}: ${reason}`.replace(/\n+$/, "");
      const separator = output.indexOf(": ");

      let message = `cannot move ${entry.branch}: ${separator < 0 ? output : output.slice(separator + 2)}`;
      if (error instanceof Unverified) {
        completed.push(entry);
        const origin = pushed.some((move) => move.branch === entry.branch) ? `origin/${entry.branch} is left at ${entry.next}, ` : "";
        message = `${entry.branch} moved to ${entry.next} but cannot be verified (${reason}); ${origin}check git reflog ${entry.branch}`;
      }

      const rolledBack = await rollback(s, moves, pushed, leases, index + (error instanceof Unverified ? 1 : 0));
      if (rolledBack) message += `; ${rolledBack}`;

      return { completed, error: message };
    }
  }

  return { completed };
}
