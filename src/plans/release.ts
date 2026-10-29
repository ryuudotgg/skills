import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { lines, readDeliveryConfig } from "../delivery.ts";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { checkoutIs, defaultBranch, gitOutput, gitRead } from "../project.ts";
import { describe, read } from "../read.ts";
import {
  checkoutCandidates,
  checkoutState,
  closedStatus,
  currentCheckout,
  holds,
  listWorktrees,
  physical,
  type Candidate,
  type Worktree,
} from "./checkouts.ts";
import { indexPath, missingIndex, readIndex, scratchLock, type IndexRow } from "./index-tsv.ts";
import { pushedHead, readPrs } from "./prs.ts";
import { readHistories, trailPath, type Histories } from "./trail.ts";

export const disposableKey = "PLANS_DISPOSABLE";

const BUILT_IN = [
  "node_modules",
  ".expo",
  "expo-env.d.ts",
  ".cache",
  ".turbo",
  "dist",
  ".next",
  "next-env.d.ts",
  "coverage",
  ".source",
  ".tanstack",
];

const REMOVE_DEADLINE = 120_000;
const TRASH = /^\.(.+)\.release-[0-9a-f-]{36}$/;
const MANIFEST = "entries.json";

type Hold = { reason: string; failed: boolean };
type Cwd = { pid: string; path: string };
type LiveByPath = Map<string, boolean | undefined>;
type Inspection =
  | { kind: "release"; fingerprint: string; ignored: string[] }
  | ({ kind: "kept" } & Hold);

type Reads = {
  project: string;
  rows: readonly IndexRow[];
  histories: Histories;
  current: string;
  primary: string;
  head: string | undefined;
  trunk: string;
  disposable: Set<string> | Hold;
  cwds: Cwd[] | Hold;
  io: Io;
};

function kept(reason: string, failed = false): Inspection {
  return { kind: "kept", reason, failed };
}

function isHold<Value>(value: Value | Hold): value is Hold {
  return typeof value === "object" && value !== null && "reason" in value;
}

export function readDisposable(env: NodeJS.ProcessEnv): Set<string> | Hold {
  const config = readDeliveryConfig(env);
  if (config.invalid)
    return { reason: config.notes[0] ?? `${config.path}: invalid config`, failed: true };

  const values = lines(config.content)
    .filter((line) => line.startsWith(`${disposableKey}=`))
    .map((line) => line.slice(disposableKey.length + 1));

  if (values.length > 1)
    return { reason: `${config.path}: ${disposableKey} is set more than once`, failed: true };

  return new Set([...BUILT_IN, ...(values[0] ?? "").split(" ").filter(Boolean)]);
}

export async function readCwds(io: Io): Promise<Cwd[] | Hold> {
  const lsof = Bun.which("lsof", { PATH: io.env.PATH });
  if (!lsof)
    return { reason: "lsof not found, cannot list process working directories", failed: true };

  const uid = String(process.getuid?.() ?? "");
  const result = await read([lsof, "-n", "-a", "-u", uid, "-d", "cwd", "-Fpn"], {
    env: io.env,
    deadline: 30_000,
  });

  if (!result.ok) return { reason: describe(result.failure), failed: true };
  if (result.code !== 0)
    return {
      reason: `lsof exited ${result.code}, cannot list process working directories`,
      failed: true,
    };

  const cwds: Cwd[] = [];

  let pid = "";
  for (const line of result.stdout.split("\n")) {
    if (line.startsWith("p")) pid = line.slice(1);
    if (line.startsWith("n")) cwds.push({ pid, path: line.slice(1) });
  }

  return cwds;
}

function parseFact(value: unknown): { path: string; live: boolean } | string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "not an object";

  const entry = value as Record<string, unknown>;
  if (typeof entry.path !== "string" || entry.path === "") return "path is not a path";
  if (typeof entry.live !== "boolean") return "live is not a boolean";

  return { path: entry.path, live: entry.live };
}

function parseHarnessFacts(text: string, io: Io): LiveByPath | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return `facts are not JSON: ${String(error)}`;
  }

  if (!Array.isArray(parsed)) return "facts are not a JSON array";

  const byPath: LiveByPath = new Map();
  for (const [position, value] of parsed.entries()) {
    const path = (value as { path?: unknown } | null)?.path;
    const named = typeof path === "string" && path !== "" ? path : undefined;
    const fact = named && byPath.has(named) ? "listed more than once" : parseFact(value);
    if (typeof fact === "string")
      io.err(`release: facts for ${named ?? `entry ${position + 1}`}: ${fact}\n`);

    if (named) byPath.set(named, typeof fact === "string" ? undefined : fact.live);
  }

  return byPath;
}

function harnessHold(facts: LiveByPath, path: string): Hold | undefined {
  const live = facts.get(path);
  if (live === false) return undefined;
  return { reason: live ? "harness reports a live turn" : "no harness facts", failed: false };
}

function envInside(path: string, entry: string): string | undefined {
  const directory = entry.replace(/\/$/, "");
  if (directory.split("/").at(-1) === "node_modules") return undefined;

  const found = readdirSync(join(path, directory), { recursive: true, encoding: "utf8" }).find(
    (name) => basename(name).startsWith(".env"),
  );

  return found === undefined ? undefined : `${directory}/${found}`;
}

function lineSet(text: string | undefined): Set<string> {
  return new Set((text ?? "").split(/\r?\n/).filter((line) => line.trim()));
}

async function copiedEnv(path: string, entry: string, primary: string, io: Io): Promise<boolean> {
  if (entry.endsWith("/") || !basename(entry).startsWith(".env")) return false;

  const same = join(primary, entry);
  const template = join(dirname(entry), ".env.example");
  const known = new Set([
    ...lineSet(existsSync(same) ? readFileSync(same, "utf8") : undefined),
    ...lineSet(await gitOutput(path, ["show", `HEAD:${template}`], { quiet: true }, io)),
  ]);

  return [...lineSet(readFileSync(join(path, entry), "utf8"))].every((line) => known.has(line));
}

function disposable(entry: string, names: Set<string>): boolean {
  const name = entry.replace(/\/$/, "").split("/").at(-1) ?? "";
  return !name.startsWith(".env") && names.has(name);
}

async function inspectOnce({ id, worktree }: Candidate, reads: Reads): Promise<Inspection> {
  const { path, branch } = worktree;
  const { io, disposable: names, cwds } = reads;
  if (isHold(names)) return { kind: "kept", ...names };
  if (isHold(cwds)) return { kind: "kept", ...cwds };
  if (!existsSync(path)) return kept("missing on disk");

  const real = physical(path);
  if (real !== path) return kept(`resolves to ${real}, not the path git lists`);

  const parked = readdirSync(dirname(path)).find(
    (name) => TRASH.exec(name)?.[1] === basename(path),
  );

  if (parked) return kept(`an interrupted release left ${join(dirname(path), parked)}`, true);

  const owners = reads.rows.filter((entry) => entry.branch === branch && closedStatus(entry));
  for (const row of owners) {
    const live = holds(reads.project, row, reads.histories);
    if (live) return kept(live);
  }

  const state = await checkoutState(worktree, reads.current, reads.head, reads.trunk, io);
  if (state.state !== "clean")
    return kept(state.reason, state.state === "unreadable" || state.failed === true);

  const flags = await gitOutput(path, ["ls-files", "-v", "-z"], { quiet: true }, io);
  if (flags === undefined) return kept("git ls-files -v failed", true);

  const hidden = flags.split("\0").find((entry) => /^([a-z]|S) /.test(entry));
  if (hidden) return kept(`${hidden.slice(2)} is marked skip-worktree or assume-unchanged`);

  const listed = await gitOutput(
    path,
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
    { timeout: 10_000, quiet: true },
    io,
  );

  if (listed === undefined) return kept("git ls-files --ignored failed", true);

  const ignored = listed.split("\0").filter(Boolean);
  for (const entry of ignored.filter((name) => !disposable(name, names)))
    if (!(await copiedEnv(path, entry, reads.primary, io)))
      return kept(`ignored ${entry} is not disposable`);

  for (const entry of ignored.filter((name) => name.endsWith("/"))) {
    const nested = envInside(path, entry);
    if (nested) return kept(`ignored ${nested} is not disposable`);
  }

  const head = (await gitOutput(path, ["rev-parse", "HEAD"], { quiet: true }, io))?.trim();
  if (!head) return kept("git rev-parse HEAD failed", true);

  const worker = cwds.find((cwd) => cwd.path === path || cwd.path.startsWith(`${path}/`));
  if (worker) return kept(`process ${worker.pid} works in it`);

  const fingerprint = [
    id,
    head,
    reads.head ?? "",
    ...owners.map((row) => `${row.id} ${row.status}`),
    ...[...names].sort(),
    ...ignored,
  ];

  return { kind: "release", fingerprint: fingerprint.join("\0"), ignored };
}

async function inspect(candidate: Candidate, reads: Reads): Promise<Inspection> {
  try {
    return await inspectOnce(candidate, reads);
  } catch (error) {
    return { kind: "kept", ...failure(error) };
  }
}

async function prHead(branch: string, trunk: string, io: Io): Promise<string | Hold | undefined> {
  const prs = await readPrs(branch, io);
  return typeof prs === "string"
    ? { reason: `cannot read PRs for ${branch}: ${prs}`, failed: true }
    : pushedHead(prs, trunk);
}

function failure(error: unknown): Hold {
  return { reason: error instanceof Error ? error.message : String(error), failed: true };
}

function present(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
}

function restore(path: string, trash: string, moved: readonly string[]): Hold | undefined {
  try {
    for (const [position, entry] of moved.entries()) {
      const parked = join(trash, String(position));
      const target = join(path, entry.replace(/\/$/, ""));
      if (!present(parked)) continue;
      if (present(target))
        return { reason: `${target} exists, ${parked} is left in place`, failed: true };

      renameSync(parked, target);
    }

    rmSync(trash, { recursive: true, force: true });
    return undefined;
  } catch (error) {
    return failure(error);
  }
}

async function remove(
  path: string,
  ignored: readonly string[],
  main: string,
  io: Io,
): Promise<Hold | { trash: string }> {
  const trash = join(dirname(path), `.${basename(path)}.release-${randomUUID()}`);
  const moved: string[] = [];
  try {
    mkdirSync(trash);
    writeFileSync(join(trash, MANIFEST), JSON.stringify(ignored));

    for (const entry of ignored) {
      renameSync(join(path, entry.replace(/\/$/, "")), join(trash, String(moved.length)));
      moved.push(entry);
    }
  } catch (error) {
    return restore(path, trash, moved) ?? failure(error);
  }

  const result = await gitRead(
    main,
    ["worktree", "remove", path],
    { timeout: REMOVE_DEADLINE },
    io,
  );

  if (result.ok && result.code === 0) return { trash };

  const reason = result.ok
    ? (result.stderr.split("\n").find((line) => line.trim()) ?? `git exited ${result.code}`).trim()
    : describe(result.failure);

  return restore(path, trash, moved) ?? { reason, failed: true };
}

function settleTrash(parent: string, name: string): Hold | undefined {
  const trash = join(parent, name);
  const checkout = join(parent, TRASH.exec(name)?.[1] ?? "");
  try {
    const stat = lstatSync(trash);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.()) return undefined;
    if (!existsSync(checkout)) {
      rmSync(trash, { recursive: true, force: true });
      return undefined;
    }

    const manifest = join(trash, MANIFEST);
    const entries: unknown = existsSync(manifest) ? JSON.parse(readFileSync(manifest, "utf8")) : [];
    const moved = Array.isArray(entries)
      ? entries.filter((entry) => typeof entry === "string")
      : [];

    return restore(checkout, trash, moved);
  } catch (error) {
    return failure(error);
  }
}

function settleAllTrash(worktrees: readonly Worktree[], io: Io): boolean {
  let failed = false;
  for (const parent of new Set(worktrees.map((worktree) => dirname(worktree.path)))) {
    let names: string[];
    try {
      names = readdirSync(parent).filter((entry) => TRASH.test(entry));
    } catch {
      continue;
    }

    for (const name of names) {
      const hold = settleTrash(parent, name);
      if (!hold) continue;

      failed = true;
      io.err(`release: cannot settle ${join(parent, name)}: ${hold.reason}\n`);
    }
  }

  return failed;
}

export async function releaseVerb(
  args: readonly string[],
  usage: string,
  io: Io,
  readFacts: () => Promise<string> = () => Bun.stdin.text(),
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((arg) => arg !== "--dry-run" && arg !== "--facts");
  const [project = ""] = rest;
  if (rest.length !== 1 || project.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const facts = args.includes("--facts") ? parseHarnessFacts(await readFacts(), io) : undefined;
  if (typeof facts === "string") {
    io.err(`release: ${facts}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`release: ${reason}\n`);
    return 1;
  };

  let index: string;
  try {
    index = indexPath(project, io.env);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) return refuse(missingIndex(project));

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return refuse(elsewhere);
  if (!Bun.which("gh", { PATH: io.env.PATH })) return refuse("gh not found, cannot read PRs");

  const trunk = await defaultBranch(io.cwd, io);
  if (!trunk.ok) {
    if (trunk.failure) io.err(`${describe(trunk.failure)}\n`);
    return refuse("cannot read the default branch of origin");
  }

  const rows = readIndex(index);
  const histories = readHistories(io.env);
  if (!histories) return refuse(`cannot read ${trailPath(io.env)}`);

  const worktrees = await listWorktrees(io);
  if (!worktrees) return refuse("git worktree list failed");

  let failed = false;
  if (!dryRun)
    try {
      failed = await withLock(scratchLock(io.env), "scratch", () => settleAllTrash(worktrees, io));
    } catch (error) {
      failed = true;
      io.err(`release: ${failure(error).reason}\n`);
    }

  const main = worktrees.find((worktree) => worktree.primary)?.path ?? io.cwd;
  const current = await currentCheckout(io);
  const found = checkoutCandidates(rows, project, histories, trunk.branch, worktrees);
  const disposableNames = readDisposable(io.env);
  const cwds = await readCwds(io);

  const globalHold = [disposableNames, cwds].find(isHold);
  if (globalHold) {
    failed = true;
    if (found.length === 0) io.err(`release: ${globalHold.reason}\n`);
  }

  let released = 0;
  const report = (candidate: Candidate, hold: Hold) => {
    if (hold.failed) failed = true;
    io.out(`kept ${candidate.id} ${candidate.worktree.path}: ${hold.reason}\n`);
  };

  for (const candidate of found) {
    const { id, worktree } = candidate;
    const harness = facts && (globalHold ?? harnessHold(facts, worktree.path));
    if (harness) {
      report(candidate, harness);
      continue;
    }

    const head = await prHead(worktree.branch, trunk.branch, io);
    if (isHold(head)) {
      report(candidate, head);
      continue;
    }

    const base = { project, current, primary: main, head, trunk: trunk.branch, io };
    const first = await inspect(candidate, {
      ...base,
      rows,
      histories,
      disposable: disposableNames,
      cwds,
    });

    if (first.kind === "kept") {
      report(candidate, first);
      continue;
    }

    if (dryRun) {
      released += 1;
      io.out(`would release ${id} ${worktree.path}\n`);
      continue;
    }

    let outcome: Hold | { trash: string };
    try {
      outcome = await withLock(scratchLock(io.env), "scratch", async () => {
        const nowRows = readIndex(index);
        const nowHistories = readHistories(io.env);
        if (!nowHistories) return { reason: `cannot read ${trailPath(io.env)}`, failed: true };

        const nowWorktrees = await listWorktrees(io);
        if (!nowWorktrees) return { reason: "git worktree list failed", failed: true };

        const again = checkoutCandidates(
          nowRows,
          project,
          nowHistories,
          trunk.branch,
          nowWorktrees,
        ).find((entry) => entry.id === id && entry.worktree.path === worktree.path);

        if (!again) return { reason: "no longer a candidate", failed: false };

        const second = await inspect(again, {
          ...base,
          rows: nowRows,
          histories: nowHistories,
          disposable: readDisposable(io.env),
          cwds: await readCwds(io),
        });

        if (second.kind === "kept") return second;
        if (second.fingerprint !== first.fingerprint)
          return { reason: "changed since the first read", failed: false };

        return remove(worktree.path, second.ignored, main, io);
      });
    } catch (error) {
      outcome = failure(error);
    }

    if (isHold(outcome)) {
      report(candidate, outcome);
      continue;
    }

    try {
      rmSync(outcome.trash, { recursive: true, force: true });
    } catch (error) {
      failed = true;
      io.err(`release: cannot remove ${outcome.trash}: ${failure(error).reason}\n`);
    }

    released += 1;
    io.out(`released ${id} ${worktree.path}\n`);
  }

  io.out(`${dryRun ? "would release" : "released"} ${released} of ${found.length}\n`);
  return failed ? 1 : 0;
}
