import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readDelivery } from "../delivery.ts";
import type { Io } from "../io.ts";
import { indexPath, missingIndex, readIndex } from "../plans/index-tsv.ts";
import { checkoutIs } from "../project.ts";
import { findLayers, readOrigin, remote, restackLayers, trunk } from "./layers.ts";
import { ancestor, git, ignoredCollision, read, Refusal, refuse, requireReplay, settled, UnknownOutcome, type Session } from "./restack.ts";
import { baseKey, noBase, recordedBase } from "./skills-base.ts";

type Arguments = { project: string; push: boolean; onto: string };

function argumentsFor(args: readonly string[]): Arguments | undefined {
  let project: string | undefined;
  let push = false;
  let onto: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "-P") {
      if (project !== undefined || args[index + 1] === undefined) return undefined;
      project = args[++index];
    } else if (option === "--push") {
      if (push) return undefined;
      push = true;
    } else if (option === "--onto") {
      if (onto !== undefined || args[index + 1] === undefined || args[index + 2] === undefined) return undefined;
      onto = `${args[++index]} ${args[++index]}`;
    } else return undefined;
  }

  return project ? { project, push, onto: onto ?? "" } : undefined;
}

async function config(s: Session, key: string): Promise<string> {
  return (await read(s, ["config", key], `cannot read ${key}`, [0, 1])).stdout.replace(/\n+$/, "");
}

async function writeConfig(s: Session, ...args: string[]): Promise<void> {
  if ((await git(s, ["config", ...args], { write: true })).code !== 0) refuse("cannot write git config");
}

async function outcome(s: Session, branch: string, lease: string, next: string, code: number): Promise<"none" | "all"> {
  try {
    return await settled(s, [{ branch, before: lease, after: next }], code);
  } catch (error) {
    if (!(error instanceof UnknownOutcome)) throw error;
    return refuse(`${error.message}; a rerun of skills restack-layer --push finishes once origin is reachable`);
  }
}

async function restackLayer({ project, push, onto }: Arguments, root: string, io: Io): Promise<number> {
  const cwd = io.cwd;
  const checkout = await checkoutIs(cwd, project, io);
  if (checkout) refuse(checkout);
  if (readDelivery(root, io.env).mode !== "prs") refuse("delivery mode is not prs");

  let index: string;
  try {
    index = indexPath(project, io.env);
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }

  const s: Session = { ...io, indexes: [index], ownRows: new Set() };
  const inside = await read(s, ["rev-parse", "--is-inside-work-tree"], "cannot read whether this is a work tree");
  if (inside.stdout.trimEnd() !== "true") refuse("not inside a work tree");

  const admin = (await read(s, ["rev-parse", "--absolute-git-dir"], "cannot read the git directory of this checkout")).stdout.trimEnd();
  const mergeHead = join(admin, "rebase-merge/head-name");
  const applyHead = join(admin, "rebase-apply/head-name");

  let branch: string;
  let rebasing = false;
  if (statSync(mergeHead, { throwIfNoEntry: false })?.isFile()) {
    branch = readFileSync(mergeHead, "utf8").replace(/\n+$/, "").replace(/^refs\/heads\//, "");
    rebasing = true;
  } else if (statSync(applyHead, { throwIfNoEntry: false })?.isFile()) {
    branch = readFileSync(applyHead, "utf8").replace(/\n+$/, "").replace(/^refs\/heads\//, "");
    rebasing = true;
  } else if (statSync(join(admin, "rebase-apply"), { throwIfNoEntry: false })?.isDirectory()) refuse("git am in progress");
  else if (statSync(join(admin, "rebase-merge"), { throwIfNoEntry: false })?.isDirectory()) refuse("rebase in progress with no branch");
  else {
    const current = await read(s, ["symbolic-ref", "--quiet", "--short", "HEAD"], "cannot read HEAD", [0, 1]);
    if (current.code === 1) refuse("detached HEAD");
    branch = current.stdout.trimEnd();
  }

  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) refuse(missingIndex(project));
  if (!readIndex(index).some((row) => row.branch === branch)) refuse(`${branch} is not an owned branch`);

  const defaultBranch = await trunk(s);
  if (!defaultBranch) refuse("cannot read the default branch of origin");
  if (branch === defaultBranch) refuse(`cannot rebase the default branch ${defaultBranch}`);

  const recorded = await recordedBase(cwd, branch, s);
  if (!recorded.ok) refuse(recorded.reason);

  let base = recorded.base;
  if (!base) refuse(noBase(branch));

  let lease = await config(s, `branch.${branch}.skills-restack-lease`);
  const savedOnto = await config(s, `branch.${branch}.skills-restack-onto`);
  if (savedOnto) {
    if (onto && onto !== savedOnto) refuse("--onto conflicts with the recorded restack");
    onto = savedOnto;
  } else if (lease && onto) refuse("--onto conflicts with the recorded restack");

  let forkPoint = "";
  if (onto) {
    const separator = onto.indexOf(" ");
    base = separator < 0 ? onto : onto.slice(0, separator);
    const cutoff = separator < 0 ? onto : onto.slice(separator + 1);
    const verified = await read(s, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${cutoff}^{commit}`], `cannot read commit ${cutoff} for ${branch}`, [0, 1]);
    if (verified.code === 1) refuse(`no such commit: ${cutoff}`);

    forkPoint = verified.stdout.trimEnd();
    if (!lease && !await ancestor(s, forkPoint, branch, `cannot read whether ${cutoff} is an ancestor of ${branch}`)) refuse(`${cutoff} is not an ancestor of ${branch}`);
  }

  if (base.startsWith("origin/")) {
    const fetched = await git(s, ["fetch", "--quiet", "origin", `+refs/heads/${base.slice(7)}:refs/remotes/${base}`], { stdoutToStderr: true });
    if (fetched.code !== 0) refuse(`cannot fetch ${base}`);
  }

  const verified = await read(s, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`], `cannot read base ${base} for ${branch}`, [0, 1]);
  if (verified.code === 1) refuse(`no such base: ${base}`);

  const baseTip = verified.stdout.trimEnd();

  if (rebasing) {
    const listed = await read(s, ["ls-files", "-u"], `cannot read unmerged paths in ${branch}`);
    const unmerged = [...new Set(listed.stdout.split("\n").filter(Boolean).map((line) => line.split("\t")[1] ?? ""))].sort().join(" ");
    if (unmerged) refuse(`unmerged paths in ${branch}: ${unmerged}, resolve them, git add, then GIT_EDITOR=true git rebase --continue`);

    refuse(`rebase of ${branch} still in progress, finish it with GIT_EDITOR=true git rebase --continue`);
  }

  for (const operation of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer"])
    if (existsSync(join(admin, operation))) refuse(`${operation} in progress on ${branch}`);

  const stale = !await ancestor(s, baseTip, branch, `cannot read whether ${base} is an ancestor of ${branch}`);
  if (!lease && !stale) {
    io.out(`${branch} already sits on ${base}\n`);
    return 0;
  }

  if ((await read(s, ["status", "--porcelain", "--untracked-files=no"], `cannot read tracked changes in ${branch}`)).stdout.trimEnd()) refuse("tracked changes");

  const layers = await findLayers(s, branch, index);
  await requireReplay(s);

  if (!await remote(s, branch)) refuse(`origin has no ${branch}, publish it first`);

  const fetched = await git(s, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { stdoutToStderr: true });
  if (fetched.code !== 0) refuse(`cannot fetch origin/${branch}`);

  const originTip = (await read(s, ["rev-parse", `refs/remotes/origin/${branch}`], `cannot read the tip of origin/${branch}`)).stdout.trimEnd();
  const localTip = (await read(s, ["rev-parse", `refs/heads/${branch}`], `cannot read the tip of ${branch}`)).stdout.trimEnd();
  const synced = lease !== "" && originTip !== lease && originTip === localTip;
  const landed = synced && !stale;

  if (synced && stale && !await ancestor(s, lease, originTip, `cannot read whether the lease of ${branch} is an ancestor of origin/${branch}`))
    refuse(`${branch} and origin/${branch} are at ${localTip}, not the lease ${lease}, and ${branch} is stale on ${base}: an earlier --push landed before ${base} moved, or origin was replaced; check which, then drop the restack with git config --unset branch.${branch}.skills-restack-lease`);

  const leases = await readOrigin(s, layers);
  const movedOrigin = `origin/${branch} moved since the rebase began, nothing pushed; sync ${branch} with origin, or drop the restack with git config --unset branch.${branch}.skills-restack-lease`;
  if (stale && !landed) {
    if (push) refuse(`${branch} is still stale on ${base}, run skills restack-layer without --push`);

    if (lease) {
      if (originTip !== lease && originTip !== localTip) refuse(movedOrigin);
    } else if (originTip !== localTip) refuse(`origin/${branch} differs from ${branch}, sync it first`);

    if (!forkPoint) {
      forkPoint = (await read(s, ["merge-base", "--fork-point", base, branch], `cannot read the fork point of ${branch} from ${base}`, [0, 1])).stdout.trimEnd();
      if (!forkPoint && base.startsWith("origin/")) forkPoint = (await read(s, ["merge-base", base, branch], `cannot read the merge base of ${base} and ${branch}`, [0, 1])).stdout.trimEnd();
    }

    if (!forkPoint) refuse(`cannot find where ${branch} forked from ${base}, pass --onto <parent> <old parent tip>`);

    const path = (await read(s, ["rev-parse", "--show-toplevel"], `cannot read the checkout path for ${branch}`)).stdout.trimEnd();
    if (await ignoredCollision({ ...s, cwd: path }, { admin, path }, branch, baseTip)) refuse("an ignored file in this checkout sits where the rebase adds one");

    const recordedLease = lease !== originTip;
    if (recordedLease) {
      lease = originTip;
      await writeConfig(s, `branch.${branch}.skills-restack-lease`, lease);
      if (onto) await writeConfig(s, `branch.${branch}.skills-restack-onto`, onto);
    }

    const rebased = await git(s, ["rebase", "--no-update-refs", "--onto", baseTip, forkPoint, branch], {
      env: { GIT_EDITOR: "true" }, stdoutToStderr: true, stderr: "capture", write: true,
    });

    if (rebased.code !== 0) {
      if (["rebase-merge", "rebase-apply"].some((name) => statSync(join(admin, name), { throwIfNoEntry: false })?.isDirectory()))
        refuse(`conflict rebasing ${branch} onto ${base}, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then skills restack-layer --push`);

      if (recordedLease) {
        await writeConfig(s, "--unset", `branch.${branch}.skills-restack-lease`);
        if (onto) await writeConfig(s, "--unset", `branch.${branch}.skills-restack-onto`);
      }

      refuse(`cannot rebase ${branch} onto ${base}: ${rebased.stderr.split("\n")[0] ?? ""}`);
    }

    io.out(`rebased ${branch} onto ${base}, run the standing checks, then skills restack-layer --push\n`);
    return 0;
  }

  if (!push) {
    io.out(landed
      ? `${branch} is pushed, run skills restack-layer --push to finish the layers above\n`
      : `${branch} is rebased, run the standing checks, then skills restack-layer --push\n`);

    return 0;
  }

  if ((await read(s, ["rev-list", "--merges", `${baseTip}..${branch}`], `cannot read merge commits in ${branch}`)).stdout.trimEnd()) refuse(`merge commit in ${branch}, rebase it linear`);

  const diff = await read(s, ["diff", "--text", "--no-color", "--no-renames", "--unified=0", baseTip, branch], `cannot read the diff of ${branch} from ${base}`);

  let marker = "";
  for (const line of diff.stdout.split("\n")) {
    if (line.startsWith("+++ b/")) marker = line.slice(6);
    if (/^\+(<<<<<<<|>>>>>>>)( |$)/.test(line)) {
      if (marker) refuse(`conflict marker left in ${marker}`);
      break;
    }
  }

  if (!landed && originTip !== lease) refuse(movedOrigin);

  if (!landed) {
    const pushed = await git(s, ["push", "--quiet", `--force-with-lease=refs/heads/${branch}:${lease}`, "origin", `${localTip}:refs/heads/${branch}`], { stdoutToStderr: true, write: true });
    if (pushed.code !== 0 && await outcome(s, branch, lease, localTip, pushed.code) === "none") refuse("lease push rejected, nothing pushed");
  }

  try {
    if (onto) {
      await writeConfig(s, baseKey(branch), base);
      await writeConfig(s, "--unset", `branch.${branch}.skills-restack-onto`);
    }

    await writeConfig(s, "--unset", `branch.${branch}.skills-restack-lease`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    refuse(`${branch} is pushed, ${error.message}; rerun skills restack-layer --push to finish`);
  }

  return restackLayers(s, branch, lease, layers, leases, "restack-layer", [`pushed ${branch}`]);
}

export async function restackLayerVerb(args: readonly string[], usage: string, root: string, io: Io): Promise<number> {
  const parsed = argumentsFor(args);
  if (!parsed) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    return await restackLayer(parsed, root, io);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`restack-layer: ${error.message}\n`);
    return 1;
  }
}
