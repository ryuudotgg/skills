import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, read as readProcess } from "../read.ts";

export class Refusal extends Error {}

export type Move = { branch: string; old: string; next: string };
export type Holder = { path: string; admin: string; current: boolean };
export type Plan = { kind: "planned"; moves: Move[] } | { kind: "conflict"; reason: string };
export type Applied = { completed: Move[]; error?: string };

export type Session = {
  cwd: string;
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
  else process.stderr.write(text);
}

export async function git(s: Session, args: readonly string[], options: GitOptions = {}): Promise<Run> {
  const mode = options.stderr ?? "pass";
  if (!options.write) {
    const result = await readProcess(["git", ...args], {
      cwd: s.cwd,
      env: { ...process.env, ...options.env },
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
    env: { ...process.env, ...options.env },
    stdin: options.input ?? "ignore",
    stdout: "pipe",
    stderr: mode === "pass" && !s.sink ? "inherit" : "pipe",
  });

  const [bytes, stderr] = await Promise.all([
    new Response(child.stdout).bytes(),
    child.stderr instanceof ReadableStream ? new Response(child.stderr).text() : Promise.resolve(""),
  ]);

  await child.exited;
  const stdout = new TextDecoder().decode(bytes);
  if (options.stdoutToStderr) emit(s, stdout);
  if (mode === "pass") emit(s, stderr);

  return { code: child.exitCode ?? -1, stdout: options.stdoutToStderr ? "" : stdout, bytes, stderr };
}

async function value(s: Session, args: readonly string[]): Promise<string | undefined> {
  const run = await git(s, args);
  return run.code === 0 ? run.stdout.replace(/\n+$/, "") : undefined;
}

async function read(s: Session, args: readonly string[], reason: string): Promise<Run> {
  const run = await git(s, args);
  return run.code === 0 ? run : refuse(reason);
}

async function tip(s: Session, ref: string): Promise<string> {
  const run = await git(s, ["rev-parse", ref]);
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

function rows(index: string): string[][] {
  try {
    return readFileSync(index, "utf8").split("\n").slice(1).map((line) => line.split("\t"));
  } catch {
    return [];
  }
}

export function plansIndexes(env: NodeJS.ProcessEnv = process.env): string[] {
  const root = env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;

  let projects: string[];
  try {
    projects = readdirSync(root).filter((name) => !name.startsWith(".")).sort();
  } catch {
    projects = [];
  }

  return projects.map((name) => `${root}/${name}/index.tsv`).filter(isFile);
}

function doingRow(index: string, branch: string): string | undefined {
  return rows(index).find((fields) => fields[2] === "DOING" && fields[7] === branch)?.[0];
}

function activeRow(s: Session, branch: string): string {
  for (const index of s.indexes) {
    const id = rows(index).find((fields) => fields[2] !== "DONE" && fields[2] !== "DROPPED" && fields[7] === branch)?.[0];
    if (id) return `row ${id} of ${basename(dirname(index))}, `;
  }

  return "";
}

export async function requireReplay(s: Session): Promise<void> {
  const run = await git(s, ["replay", "-h"], { stderr: "capture" });
  if (!`${run.stdout}${run.stderr}`.includes("--ref-action")) refuse("git replay lacks --ref-action");
}

export async function findHolder(s: Session, branch: string): Promise<Holder | undefined> {
  const common = physical((await value(s, ["rev-parse", "--path-format=absolute", "--git-common-dir"])) ?? "");
  const current = physical((await value(s, ["rev-parse", "--absolute-git-dir"])) ?? "");
  const bare = await value(s, ["config", "--bool", "core.bare"]);
  const worktrees = join(common, "worktrees");
  const linked = isDirectory(worktrees)
    ? readdirSync(worktrees).filter((name) => !name.startsWith(".")).sort().map((name) => join(worktrees, name))
    : [];

  let holder: Holder | undefined;
  for (const admin of [common, ...linked]) {
    if (!isDirectory(admin)) continue;
    if (admin === common && bare === "true") continue;

    const claim = await value(s, [`--git-dir=${admin}`, "symbolic-ref", "-q", "HEAD"]);
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

  const logging = await value(s, ["config", "--bool", "core.logAllRefUpdates"]);
  const reflog = logging !== "false" && (await git(s, ["reflog", "exists", `refs/heads/${branch}`])).code === 0;
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
  if ((await value(s, ["config", "--bool", "commit.gpgsign"])) !== "true") return replayed;

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

export async function plan(s: Session, parent: string, parentOld: string, layers: readonly string[]): Promise<Plan> {
  let onto = (await value(s, ["rev-parse", "--verify", `${parent}^{commit}`])) ?? refuse(`no such parent: ${parent}`);
  let currentParent = parent;
  let currentOld = parentOld;
  const lowest = layers[0];

  let where = "";
  let recovery = "";
  if (lowest) {
    const holder = await findHolder(s, lowest);
    where = `${activeRow(s, lowest)}held by ${holder?.path || "no checkout"}`;

    if ((await value(s, ["config", `branch.${lowest}.skills-base`])) !== parent)
      recovery = `, then skills restack-layer --onto ${parent} ${parentOld}`;
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
      return { kind: "conflict", reason: `rebase conflict on ${layer} onto ${currentParent}${suffix}, ${where}${recovery}` };
    }

    const output = replay.stdout.replace(/\n+$/, "");

    let next = onto;
    if (output) {
      const lines = output.split("\n");
      const fields = lines[0]?.trim().split(/\s+/) ?? [];
      const valid = lines.length === 1 && fields.length === 4 && fields[0] === "update" && fields[1] === `refs/heads/${layer}` && fields[3] === old;
      next = valid ? fields[2] ?? "" : refuse(`invalid replay output for ${layer}`);
    }

    next = (await value(s, ["rev-parse", "--verify", `${next}^{commit}`])) ?? refuse(`invalid replay tip for ${layer}`);
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

  return run.code === 0 ? pushed : undefined;
}

async function rollback(s: Session, moves: readonly Move[], pushed: readonly Move[], leases: ReadonlyMap<string, string>, failed: string): Promise<boolean> {
  const start = moves.findIndex((move) => move.branch === failed);
  const undo = moves.slice(start).filter((move) => pushed.some((entry) => entry.branch === move.branch));
  if (undo.length === 0) return true;

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

  return run.code === 0;
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
  if ((await tip(s, `refs/heads/${branch}`)) !== next) refuse(`${branch} moved in holder ${holder.path} during the restack`);

  const previous = (await value(s, ["rev-parse", `refs/heads/${branch}@{1}`])) ?? refuse(`cannot read the previous tip of ${branch}`);
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
  for (const entry of moves) {
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
      if (!(await rollback(s, moves, pushed, leases, entry.branch))) message += "; lease rollback rejected";

      return { completed, error: message };
    }
  }

  return { completed };
}
