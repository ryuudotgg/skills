import { existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { describe, read } from "../read.ts";
import {
  parseAdvertisement,
  pickCandidate,
  readRelease,
  trustedOrigin,
  trustedRepository,
  updateLine,
  updateLock,
  verifiedCommit,
  type Outcome,
  type Release,
} from "./release.ts";

export const updateUsage = "skills update [--check]";

type Mode = "check" | "apply";

class Refused extends Error {}

const tracking = "refs/skills-update/head";
const quiet = ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false"];

function refuse(reason: string): never {
  throw new Refused(reason);
}

async function run(
  argv: readonly string[],
  cwd: string,
  io: Io,
  deadline = 120_000,
): Promise<{ code: number; stdout: string }> {
  const env = {
    ...io.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: io.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };

  const result = await read(argv, { cwd, env, deadline });
  if (!result.ok) {
    io.err(result.stderr);
    io.err(`${describe(result.failure)}\n`);
    return { code: -1, stdout: "" };
  }

  io.err(result.stderr);
  return { code: result.code, stdout: result.stdout };
}

async function git(repo: string, args: readonly string[], io: Io): Promise<string | undefined> {
  const result = await run(["git", ...args], repo, io);
  return result.code === 0 ? result.stdout : undefined;
}

async function gh(args: readonly string[], repo: string, io: Io): Promise<string | undefined> {
  const result = await run(["gh", "api", "--hostname", "github.com", ...args], repo, io, 30_000);
  return result.code === 0 ? result.stdout : undefined;
}

async function step(argv: readonly string[], repo: string, io: Io, deadline: number) {
  const result = await run(argv, repo, io, deadline);
  io.err(result.stdout);
  return result.code === 0;
}

async function isAncestor(repo: string, ancestor: string, descendant: string, io: Io) {
  return (await git(repo, ["merge-base", "--is-ancestor", ancestor, descendant], io)) !== undefined;
}

async function inProgress(repo: string, io: Io): Promise<string | undefined> {
  const operations = [
    ["MERGE_HEAD", "merge"],
    ["rebase-merge", "rebase"],
    ["rebase-apply", "rebase"],
    ["CHERRY_PICK_HEAD", "cherry pick"],
  ] as const;

  for (const [marker, name] of operations) {
    const path = (await git(repo, ["rev-parse", "--git-path", marker], io))?.trim();
    if (path === undefined) refuse("cannot read the checkout");
    if (existsSync(isAbsolute(path) ? path : join(repo, path))) return name;
  }

  return undefined;
}

async function versionAt(repo: string, revision: string, io: Io): Promise<string | undefined> {
  const manifest = await git(repo, ["show", `${revision}:package.json`], io);
  try {
    const version: unknown = JSON.parse(manifest ?? "").version;
    return typeof version === "string" ? version : undefined;
  } catch {
    return undefined;
  }
}

async function inspect(repo: string, io: Io): Promise<{ branch: string; version: string }> {
  const operation = await inProgress(repo, io);
  if (operation) refuse(`a ${operation} is in progress`);

  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], io);
  if (status === undefined) refuse("cannot read the checkout");

  const entries = status.split("\0").filter(Boolean);
  if (entries.some((entry) => !entry.startsWith("??"))) refuse("the checkout has tracked changes");
  if (entries.length) refuse("the checkout has untracked files");

  const branch = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], io))?.trim();
  if (!branch) refuse("HEAD is detached");

  const version = await versionAt(repo, "HEAD", io);
  if (!version) refuse("cannot read the version at HEAD");

  return { branch, version };
}

async function verify(repo: string, mode: Mode, io: Io): Promise<Outcome> {
  const checkout = await inspect(repo, io);
  const listing = await git(repo, ["ls-remote", "--symref", "origin", "HEAD", "refs/tags/v*"], io);
  const advertised = listing === undefined ? undefined : parseAdvertisement(listing);
  if (!advertised) refuse("cannot read origin");

  const main = advertised.defaultBranch;
  if (checkout.branch !== main) refuse(`HEAD is on ${checkout.branch}, not ${main}`);

  const candidate = pickCandidate(advertised.tags, checkout.version);
  if (!candidate) return { kind: "current", version: checkout.version };

  const fetched = await git(
    repo,
    [
      ...quiet,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "origin",
      `+refs/heads/${main}:${tracking}`,
    ],
    io,
  );

  if (fetched === undefined) refuse("cannot fetch origin");

  const { tag, sha } = candidate;
  if (!(await isAncestor(repo, sha, tracking, io))) refuse(`${tag} is not on origin ${main}`);
  if (await isAncestor(repo, sha, "HEAD", io)) refuse(`${tag} is behind HEAD`);
  if (!(await isAncestor(repo, "HEAD", sha, io))) refuse(`HEAD has commits ${tag} does not`);
  if ((await versionAt(repo, sha, io)) !== candidate.version)
    refuse(`${tag} is not version ${candidate.version}`);

  const releaseJson = await gh([`repos/${trustedRepository}/releases/tags/${tag}`], repo, io);
  if (releaseJson === undefined) refuse(`cannot read the release of ${tag}`);

  const release = readRelease(candidate, releaseJson);
  if ("reason" in release) refuse(release.reason);

  const commitJson = await gh([`repos/${trustedRepository}/commits/${sha}`], repo, io);
  if (commitJson === undefined) refuse(`cannot read the commit of ${tag}`);
  if (!verifiedCommit(sha, commitJson)) refuse(`${tag} is not a verified commit`);
  if (mode === "check") return { kind: "available", to: release };

  return apply(repo, checkout.version, release, io);
}

function dependencies(repo: string, io: Io): Promise<boolean> {
  return step(
    [process.execPath, "install", "--frozen-lockfile", "--ignore-scripts"],
    repo,
    io,
    600_000,
  );
}

function installer(repo: string, io: Io, failed?: string): Promise<boolean> {
  const env = failed ? { ...io.env, SKILLS_INSTALL_SHIPPED_TO: failed } : io.env;
  return step([join(repo, "install.sh")], repo, { ...io, env }, 600_000);
}

async function apply(repo: string, from: string, release: Release, io: Io): Promise<Outcome> {
  const start = (await git(repo, ["rev-parse", "HEAD"], io))?.trim();
  if (!start) refuse("cannot read the checkout");

  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stay = () => io.err("update: finishing or rolling back before exit\n");
  for (const signal of signals) process.on(signal, stay);

  try {
    const merged = await step(
      ["git", "-c", "core.hooksPath=/dev/null", "merge", "--quiet", "--ff-only", release.sha],
      repo,
      io,
      120_000,
    );

    if (!merged) return await restore(repo, start, release.sha, "fast forward failed", io);
    if (!(await dependencies(repo, io)))
      return await restore(repo, start, release.sha, "dependencies failed", io);

    if (!(await installer(repo, io)))
      return await restore(repo, start, release.sha, "install failed", io);

    return { kind: "updated", from, to: release };
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return await restore(repo, start, release.sha, "update failed", io);
  } finally {
    for (const signal of signals) process.off(signal, stay);
  }
}

async function restore(
  repo: string,
  start: string,
  failed: string,
  reason: string,
  io: Io,
): Promise<Outcome> {
  if ((await git(repo, ["rev-parse", "HEAD"], io))?.trim() === start)
    return { kind: "refused", reason };

  const reset = await step(
    ["git", "-c", "core.hooksPath=/dev/null", "reset", "--quiet", "--hard", start],
    repo,
    io,
    120_000,
  );

  const stuck = {
    kind: "refused",
    reason: `${reason}, rollback failed at ${start.slice(0, 12)}`,
  } as const;

  if (!reset) return stuck;

  const restoredDependencies = await dependencies(repo, io);
  const restoredInstall = await installer(repo, io, failed);
  return restoredDependencies && restoredInstall ? { kind: "refused", reason } : stuck;
}

export async function update(mode: Mode, repo: string, io: Io): Promise<Outcome> {
  try {
    if (io.env.CI !== undefined) refuse("CI is set");
    if (io.env.SKILLS_AUTO_UPDATE === "0") refuse("SKILLS_AUTO_UPDATE=0");
    if (!io.env.AGENTS_DIR && !io.env.HOME) refuse("HOME is not set");

    const origins = (await git(repo, ["config", "--get-all", "remote.origin.url"], io))
      ?.split("\n")
      .filter(Boolean);

    if (origins?.length !== 1 || !trustedOrigin(origins[0]!))
      refuse(`origin is not ${trustedRepository}`);

    const lock = updateLock(io.env);
    mkdirSync(dirname(lock), { recursive: true });

    const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"], io))?.trim();
    if (!gitDir) refuse("cannot read the checkout");

    const locked = await tryLock(lock, () =>
      tryLock(join(gitDir, "skills-update.lock"), async () => {
        try {
          return await verify(repo, mode, io);
        } finally {
          await git(repo, ["update-ref", "-d", tracking], io);
        }
      }),
    );

    if (locked.held || locked.value.held) return { kind: "refused", reason: "update lock is held" };

    return locked.value.value;
  } catch (error) {
    if (error instanceof Refused) return { kind: "refused", reason: error.message };

    const message = error instanceof Error ? error.message : String(error);
    io.err(`${message}\n`);
    return { kind: "refused", reason: `update failed: ${message.split("\n", 1)[0]}` };
  }
}

export async function runUpdate(
  args: readonly string[],
  repo: string,
  io: Io = processIo(),
): Promise<number> {
  const mode =
    args.length === 0 ? "apply" : args.length === 1 && args[0] === "--check" ? "check" : undefined;

  if (!mode) {
    io.err(`usage: ${updateUsage}\n`);
    return 2;
  }

  const outcome = await update(mode, repo, io);
  io.out(`${updateLine(outcome)}\n`);

  return outcome.kind === "refused" ? 1 : 0;
}
