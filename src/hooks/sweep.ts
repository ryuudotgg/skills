import { describe, readSync } from "../read.ts";
import { baseFrom, baseKey } from "../stack/skills-base.ts";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { clip, commentLines, RULE, skipPath, specFor } from "./comment-scan.ts";
import { object } from "./payload.ts";
import { codePointOrder, textMode } from "./text.ts";

const SHOWN = 8;
const SESSION = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
const INHERITED_GIT = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_DIFF_OPTS",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
];

class TreeReadFailure extends Error {}

function scrubGitEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const gitEnv = { ...process.env, ...env };
  for (const name of INHERITED_GIT) delete gitEnv[name];
  return gitEnv;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const result = readSync(["git", ...args], { cwd, env: scrubGitEnv(env), deadline: 5000 });
  if (!result.ok) throw new TreeReadFailure(describe(result.failure));
  return result.code === 0 ? result.stdout : undefined;
}

type SweepBase = { commit: string; name: string };

const HEAD_BASE: SweepBase = { commit: "HEAD", name: "HEAD" };
function forkBase(branch: string, cwd: string, env: NodeJS.ProcessEnv): SweepBase | undefined {
  const remotes = (run(["remote"], cwd, env) ?? "").split("\n").filter(Boolean);
  const walk = run(
    [
      "rev-list",
      "--boundary",
      "HEAD",
      "--not",
      `--exclude=${branch}`,
      "--branches",
      ...remotes.map((remote) => `--exclude=${remote}/${branch}`),
      "--remotes",
    ],
    cwd,
    env,
  );

  if (walk === undefined) return undefined;
  if (!walk.trim()) return HEAD_BASE;

  const boundary = walk
    .split("\n")
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1));

  if (boundary.length === 0) return undefined;

  const independent =
    boundary.length === 1
      ? boundary
      : (run(["merge-base", "--independent", ...boundary], cwd, env) ?? "")
          .split("\n")
          .filter(Boolean);

  const commit = independent.length === 1 ? independent[0]! : undefined;
  return commit ? { commit, name: commit.slice(0, 7) } : undefined;
}

function sweepBase(cwd: string, env: NodeJS.ProcessEnv): SweepBase {
  const branch = (run(["symbolic-ref", "--short", "-q", "HEAD"], cwd, env) ?? "").trim();
  if (!branch) return HEAD_BASE;

  const defaultBranch = (
    run(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], cwd, env) ?? ""
  ).trim();

  if (defaultBranch && branch === defaultBranch.slice(defaultBranch.indexOf("/") + 1))
    return HEAD_BASE;

  const result = readSync(["git", "config", "--get", baseKey(branch)], {
    cwd,
    env: scrubGitEnv(env),
    deadline: 5000,
  });

  const configured = baseFrom(branch, result);
  if (!configured.ok) throw new TreeReadFailure(configured.reason);

  if (configured.base) {
    const recorded = run(["merge-base", configured.base, "HEAD"], cwd, env);
    if (recorded) return { commit: recorded.trim(), name: configured.base };
  }

  // Without origin/HEAD the default branch is unknown, and walking it like a feature
  // branch would report comments from its own squash merges.
  if (!defaultBranch) return HEAD_BASE;

  const forked = forkBase(branch, cwd, env);
  if (forked) return forked;

  const fallback = run(["merge-base", defaultBranch, "HEAD"], cwd, env);
  return fallback ? { commit: fallback.trim(), name: defaultBranch } : HEAD_BASE;
}

function addedLines(
  cwd: string,
  base: string,
  env: NodeJS.ProcessEnv,
): Map<string, Set<number> | undefined> {
  const diff = [
    "diff",
    "-z",
    "--raw",
    "--patch",
    "--unified=0",
    "--inter-hunk-context=0",
    "--find-renames",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--ignore-submodules",
    "--diff-filter=AMR",
  ];

  const fields = (run([...diff, base], cwd, env) ?? run(diff, cwd, env) ?? "").split("\0");

  const paths: string[] = [];

  let field = 0;
  while (fields[field]?.startsWith(":")) {
    const renamed = /[RC]\d*$/.test(fields[field]!);
    field += renamed ? 2 : 1;
    paths.push(fields[field++]!);
  }

  const patch = fields
    .slice(field + 1)
    .join("\0")
    .split("\n");

  const sections = patch.filter((line) => line.startsWith("diff --git ")).length;
  if (sections !== paths.length)
    throw new TreeReadFailure(
      `git diff: ${sections} patch sections for ${paths.length} changed file${paths.length === 1 ? "" : "s"}, so added lines cannot be matched to files and the tree was not swept`,
    );

  const files = new Map<string, Set<number> | undefined>();

  let section = 0;
  let lines: Set<number> | undefined;
  for (const line of patch)
    if (line.startsWith("diff --git ")) {
      lines = new Set();
      files.set(join(cwd, paths[section++]!), lines);
    } else if (line.startsWith("@@") && lines) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!match) continue;

      const start = Number(match[1]);
      const count = Number(match[2] ?? 1);
      for (let number = start; number < start + count; number++) lines.add(number);
    }

  const untracked = run(["ls-files", "-z", "--others", "--exclude-standard"], cwd, env) ?? "";
  for (const path of untracked.split("\0")) if (path) files.set(join(cwd, path), undefined);

  return files;
}

type TreeFindings = { since: string; hits: [string, string][] };

function seenKey(path: string, content: string): string {
  return `${path}\t${content}`;
}

export function treeFindings(cwd: string, seen: Set<string>, env: NodeJS.ProcessEnv): TreeFindings {
  const hits: [string, string][] = [];
  try {
    if (!cwd || !statSync(cwd, { throwIfNoEntry: false })?.isDirectory())
      return { since: "", hits };

    const root = (run(["rev-parse", "--show-toplevel"], cwd, env) ?? "").trim();
    if (!root) return { since: "", hits };

    const base = sweepBase(root, env);
    for (const [path, lines] of addedLines(root, base.commit, env)) {
      const spec = specFor(path);
      if (!spec || skipPath(path, env)) continue;

      let text: string;
      try {
        if (!statSync(path).isFile()) continue;
        text = textMode(readFileSync(path));
      } catch {
        continue;
      }

      for (const [number, content] of commentLines(text, spec)) {
        if (lines && !lines.has(number)) continue;
        const key = seenKey(path, content);
        if (!seen.has(key)) hits.push([key, `${relative(root, path)}:${number}  ${clip(content)}`]);
      }
    }

    return { since: base.name, hits };
  } catch (error) {
    if (!(error instanceof TreeReadFailure)) throw error;
    process.stderr.write(error.message + "\n");
    return { since: "", hits: [] };
  }
}

export function readState(path: string): { seen: Set<string>; rewrites: number } {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );

    const state = object(parsed);
    if (
      !state ||
      !Array.isArray(state.seen) ||
      !state.seen.every((value) => typeof value === "string") ||
      typeof state.rewrites !== "number" ||
      !Number.isSafeInteger(state.rewrites) ||
      state.rewrites < 0
    )
      return { seen: new Set(), rewrites: 0 };

    return { seen: new Set(state.seen), rewrites: state.rewrites };
  } catch {
    return { seen: new Set(), rewrites: 0 };
  }
}

export function writeState(path: string, seen: Set<string>, rewrites: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ seen: [...seen].sort(codePointOrder), rewrites }));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function sessionOf(data: Record<string, unknown>): string | undefined {
  return typeof data.session_id === "string" && SESSION.test(data.session_id)
    ? data.session_id
    : undefined;
}

export function statePath(data: Record<string, unknown>, session: string): string {
  return join(
    typeof data.scratchpad_dir === "string" && data.scratchpad_dir ? data.scratchpad_dir : "/tmp",
    `reply-guard-${session}.json`,
  );
}

export function list(since: string, hits: [string, string][], seen: Set<string>): string {
  const shown = hits.slice(0, SHOWN);
  for (const [key] of shown) seen.add(key);

  const lines = shown.map(([, hit]) => "  " + hit).join("\n");
  const more = hits.length > SHOWN ? `\n  ... and ${hits.length - SHOWN} more` : "";
  return `Comment lines added in this tree since ${since}:\n${lines}${more}\n${RULE}`;
}

export function commitSweep(
  data: Record<string, unknown>,
  directory: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const session = sessionOf(data);
  if (env.AGENT_HOOKS === "0" || !session) return undefined;

  const path = statePath(data, session);
  const state = readState(path);
  const { since, hits } = treeFindings(directory, state.seen, env);
  if (!hits.length) return undefined;

  const listed = list(since, hits, state.seen);

  try {
    writeState(path, state.seen, state.rewrites);
  } catch {
    return undefined;
  }

  return `${listed}\nThen run the command again. Lines listed here do not block it twice.`;
}

export function remember(data: Record<string, unknown>, added: [string, string][]): void {
  const session = sessionOf(data);
  if (!session || !added.length) return;

  const path = statePath(data, session);
  const state = readState(path);
  for (const [file, content] of added) {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {}

    state.seen.add(seenKey(real, content));
  }

  try {
    writeState(path, state.seen, state.rewrites);
  } catch {}
}
