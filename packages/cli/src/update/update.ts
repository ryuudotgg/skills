import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { describe, read } from "../read.ts";
import { installDashboard } from "./dashboard.ts";
import {
  parseAdvertisement,
  pickCandidate,
  readRelease,
  releaseUrl,
  trustedOrigin,
  trustedRepository,
  updateLine,
  updateLock,
  verifiedCommit,
  type Outcome,
  type Release,
  type Tag,
} from "./release.ts";

type Mode = "check" | "apply";

type Checkout = { branch: string; tip: string; version: string };

type UpdateRecord = { branch: string; start: string; from: string; release: Release };

type Journal = {
  locks: readonly number[];
  read(): UpdateRecord | undefined;
  write(record: UpdateRecord): void;
  forget(): void;
};

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
  inherit: readonly number[] = [],
): Promise<{ code: number; stdout: string }> {
  const env = {
    ...io.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: io.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
  };

  const result = await read(argv, { cwd, env, deadline, inherit });
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

async function inspect(repo: string, io: Io): Promise<Checkout> {
  const operation = await inProgress(repo, io);
  if (operation) refuse(`a ${operation} is in progress`);

  const status = await git(repo, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], io);
  if (status === undefined) refuse("cannot read the checkout");

  const entries = status.split("\0").filter(Boolean);
  if (entries.some((entry) => !entry.startsWith("??"))) refuse("the checkout has tracked changes");
  if (entries.length) refuse("the checkout has untracked files");

  const branch = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], io))?.trim();
  if (!branch) refuse("HEAD is detached");

  const tip = (await git(repo, ["rev-parse", "--verify", "--quiet", "HEAD"], io))?.trim();
  const version = tip ? await versionAt(repo, tip, io) : undefined;
  if (!tip || !version) refuse("cannot read the version at HEAD");

  return { branch, tip, version };
}

function onDefaultBranch(checkout: Checkout, main: string) {
  if (checkout.branch !== main) refuse(`HEAD is on ${checkout.branch}, not ${main}`);
}

async function forwardable(repo: string, candidate: Tag, tip: string, io: Io) {
  const { tag, sha } = candidate;
  if (await isAncestor(repo, sha, tip, io)) refuse(`${tag} is behind HEAD`);
  if (!(await isAncestor(repo, tip, sha, io))) refuse(`HEAD has commits ${tag} does not`);
}

async function move(repo: string, branch: string, to: string, from: string, io: Io) {
  const ref = `refs/heads/${branch}`;
  const update = (next: string, expected: string) =>
    git(repo, [...quiet, "update-ref", "-m", "skills update", ref, next, expected], io);

  if ((await update(to, from)) === undefined) return false;
  if ((await git(repo, ["symbolic-ref", "--quiet", "HEAD"], io))?.trim() === ref) return true;

  await update(from, to);
  return false;
}

const stopped = (reason: string) =>
  ({ kind: "refused", reason: `${reason}, rollback stopped because the checkout moved` }) as const;

async function position(repo: string, io: Io) {
  const branch = (await git(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"], io))?.trim();
  const head = (await git(repo, ["rev-parse", "HEAD"], io))?.trim();
  return { branch, head };
}

async function unmoved(
  repo: string,
  verified: Checkout,
  failed: string,
  reason: string,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  const ref = `refs/heads/${verified.branch}`;
  const tip = (await git(repo, ["rev-parse", "--verify", "--quiet", ref], io))?.trim();
  if (tip !== undefined && tip !== failed) journal.forget();

  const { branch, head } = await position(repo, io);
  const stayed = branch === verified.branch && head === verified.tip;
  return stayed ? { kind: "refused", reason } : stopped(reason);
}

function parseRecord(text: string): UpdateRecord | undefined {
  const commit = (value: unknown) => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value);
  try {
    const { branch, start, from, release } = JSON.parse(text);
    const { tag, version, sha, url } = release;
    const valid =
      typeof branch === "string" &&
      branch !== "" &&
      commit(start) &&
      typeof from === "string" &&
      typeof version === "string" &&
      tag === `v${version}` &&
      commit(sha) &&
      url === releaseUrl(tag);

    return valid ? { branch, start, from, release: { tag, version, sha, url } } : undefined;
  } catch {
    return undefined;
  }
}

function journal(gitDir: string, locks: readonly number[], io: Io): Journal {
  const path = join(gitDir, "skills-update-record.json");
  const unreadable = () => {
    io.err(`update: cannot read the update record ${path}\n`);
    return refuse("cannot read the checkout");
  };

  return {
    locks,
    read() {
      if (!existsSync(path)) return undefined;

      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        return unreadable();
      }

      return parseRecord(text) ?? unreadable();
    },
    write(record) {
      const temporary = `${path}.tmp`;
      try {
        const descriptor = openSync(temporary, "w");
        try {
          writeSync(descriptor, `${JSON.stringify(record)}\n`);
          fsyncSync(descriptor);
        } finally {
          closeSync(descriptor);
        }

        renameSync(temporary, path);
      } catch (error) {
        rmSync(temporary, { force: true });
        throw error;
      }
    },
    forget() {
      try {
        rmSync(path, { force: true });
      } catch (error) {
        io.err(
          `update: cannot remove ${path}: ${error instanceof Error ? error.message : error}\n`,
        );
      }
    },
  };
}

async function holding<T>(io: Io, run: () => Promise<T>): Promise<T> {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  const stay = () => io.err("update: finishing or rolling back before exit\n");
  for (const signal of signals) process.on(signal, stay);

  try {
    return await run();
  } finally {
    for (const signal of signals) process.off(signal, stay);
  }
}

async function withDashboard(outcome: Outcome, io: Io, releaseJson?: string): Promise<Outcome> {
  if (outcome.kind !== "updated") return outcome;

  const { version } = outcome.to;
  const dashboard = await installDashboard(version, io.env, releaseJson);
  if (dashboard.kind === "refused")
    io.err(`update: no dashboard build for ${version}: ${dashboard.reason}\n`);

  return outcome;
}

function standing(record: UpdateRecord, checkout: Checkout): "release" | "start" | "stale" {
  if (checkout.branch !== record.branch)
    refuse(`HEAD is on ${checkout.branch}, not ${record.branch}`);

  if (checkout.tip === record.release.sha) return "release";
  return checkout.tip === record.start ? "start" : "stale";
}

async function settle(
  repo: string,
  mode: Mode,
  checkout: Checkout,
  journal: Journal,
  io: Io,
): Promise<Outcome | undefined> {
  const record = journal.read();
  if (record === undefined) return undefined;

  const at = standing(record, checkout);
  const { branch, start, release } = record;
  if (at === "stale") {
    if (mode === "check") return undefined;

    journal.forget();
    io.err(
      `update: dropped a stale update record, ${branch} is at neither ${start.slice(0, 12)} nor ${release.sha.slice(0, 12)}\n`,
    );

    return undefined;
  }

  if (mode === "check") refuse("an update was interrupted, run skills update");

  const verified = { branch, tip: start, version: record.from };
  const settled = await holding(io, () =>
    at === "release"
      ? finish(repo, verified, release, journal, io)
      : reinstall(repo, start, release.sha, "the interrupted update was rolled back", journal, io),
  );

  return await withDashboard(settled, io);
}

async function verify(repo: string, mode: Mode, journal: Journal, io: Io): Promise<Outcome> {
  const checkout = await inspect(repo, io);
  const settled = await settle(repo, mode, checkout, journal, io);
  try {
    return settled ?? (await advance(repo, mode, checkout, journal, io));
  } finally {
    await git(repo, ["update-ref", "-d", tracking], io);
  }
}

async function advance(
  repo: string,
  mode: Mode,
  checkout: Checkout,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  const listing = await git(repo, ["ls-remote", "--symref", "origin", "HEAD", "refs/tags/v*"], io);
  const advertised = listing === undefined ? undefined : parseAdvertisement(listing);
  if (!advertised) refuse("cannot read origin");

  const main = advertised.defaultBranch;
  onDefaultBranch(checkout, main);

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
  await forwardable(repo, candidate, checkout.tip, io);

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

  const now = await inspect(repo, io);
  onDefaultBranch(now, main);
  await forwardable(repo, candidate, now.tip, io);
  if (now.tip !== checkout.tip) refuse(`HEAD moved while ${tag} was verified`);

  return await withDashboard(await apply(repo, checkout, release, journal, io), io, releaseJson);
}

async function installer(
  repo: string,
  journal: Journal,
  io: Io,
  failed?: string,
): Promise<boolean> {
  const env = failed
    ? { ...io.env, SKILLS_INSTALL_SHIPPED_TO: failed }
    : { ...io.env, SKILLS_UPDATE_FETCHES_DASHBOARD: "1" };

  const argv = [join(repo, "install.sh")];
  const result = await run(argv, repo, { ...io, env }, 600_000, journal.locks);
  io.err(result.stdout);
  return result.code === 0;
}

async function reinstall(
  repo: string,
  start: string,
  failed: string,
  reason: string,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  if (!(await installer(repo, journal, io, failed)))
    return { kind: "refused", reason: `${reason}, rollback failed at ${start.slice(0, 12)}` };

  journal.forget();
  return { kind: "refused", reason };
}

async function apply(
  repo: string,
  verified: Checkout,
  release: Release,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  return holding(io, async () => {
    let forwarded = false;
    try {
      await git(repo, ["update-index", "-q", "--refresh"], io);
      journal.write({
        branch: verified.branch,
        start: verified.tip,
        from: verified.version,
        release,
      });

      forwarded = await move(repo, verified.branch, release.sha, verified.tip, io);
      if (!forwarded)
        return await unmoved(repo, verified, release.sha, "fast forward failed", journal, io);

      const switched = await step(
        ["git", "read-tree", "-m", "-u", verified.tip, release.sha],
        repo,
        io,
        120_000,
      );

      if (!switched) {
        if (!(await move(repo, verified.branch, verified.tip, release.sha, io)))
          return stopped("fast forward failed");

        journal.forget();
        return { kind: "refused", reason: "fast forward failed" };
      }

      return await finish(repo, verified, release, journal, io);
    } catch (error) {
      io.err(`${error instanceof Error ? error.message : String(error)}\n`);
      return forwarded
        ? await restore(repo, verified, release.sha, "update failed", journal, io)
        : await unmoved(repo, verified, release.sha, "update failed", journal, io);
    }
  });
}

async function finish(
  repo: string,
  verified: Checkout,
  release: Release,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  if (!(await installer(repo, journal, io)))
    return await restore(repo, verified, release.sha, "install failed", journal, io);

  journal.forget();
  return { kind: "updated", from: verified.version, to: release };
}

async function restore(
  repo: string,
  verified: Checkout,
  failed: string,
  reason: string,
  journal: Journal,
  io: Io,
): Promise<Outcome> {
  const start = verified.tip;
  const { branch, head } = await position(repo, io);
  if (branch !== verified.branch || head !== failed) return stopped(reason);

  const snapshot = await git(
    repo,
    ["-c", "user.name=skills update", "-c", "user.email=skills@localhost", "stash", "create"],
    io,
  );

  if (snapshot === undefined)
    return { kind: "refused", reason: `${reason}, rollback stopped to keep edits` };

  const edits = snapshot.trim();
  const saved = edits ? `refs/skills-update/edits/${edits.slice(0, 12)}` : undefined;
  if (saved && (await git(repo, ["update-ref", saved, edits, ""], io)) === undefined)
    return { kind: "refused", reason: `${reason}, rollback stopped to keep edits` };

  if (!(await move(repo, verified.branch, start, failed, io))) return stopped(reason);
  if (saved) reason = `${reason}, edits saved in ${saved}`;

  const reset = await step(
    ["git", "-c", "core.hooksPath=/dev/null", "reset", "--quiet", "--hard"],
    repo,
    io,
    120_000,
  );

  if (!reset)
    return { kind: "refused", reason: `${reason}, rollback failed at ${start.slice(0, 12)}` };

  return await reinstall(repo, start, failed, reason, journal, io);
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

    const locked = await tryLock(lock, (store) =>
      tryLock(join(gitDir, "skills-update.lock"), (checkout) =>
        verify(repo, mode, journal(gitDir, [store, checkout], io), io),
      ),
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
  usage: string,
  repo: string,
  io: Io = processIo(),
): Promise<number> {
  const mode =
    args.length === 0 ? "apply" : args.length === 1 && args[0] === "--check" ? "check" : undefined;

  if (!mode) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const outcome = await update(mode, repo, io);
  io.out(`${updateLine(outcome)}\n`);

  return outcome.kind === "refused" ? 1 : 0;
}
