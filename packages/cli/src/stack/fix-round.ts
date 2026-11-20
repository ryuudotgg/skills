import { readDelivery } from "../delivery.ts";
import type { Io } from "../io.ts";
import { argumentsFor } from "../run.ts";
import { commitStaged, messageProblem, selectedIndex, stageSelected } from "../publish/commit.ts";
import {
  findLayers,
  owned,
  projectIndexes,
  readOrigin,
  remote,
  requireIndex,
  requireStacked,
  restackLayers,
  trunk,
} from "./layers.ts";
import {
  ancestor,
  fetchRemoteTip,
  git,
  read,
  Refusal,
  refuse,
  requireReplay,
  settled,
  type Session,
} from "./restack.ts";

async function requireSubjects(s: Session, range: string): Promise<void> {
  const subjects = await read(
    s,
    ["log", "--no-show-signature", "--format=%s", range],
    `cannot read the commits in ${range}`,
  );

  for (const subject of subjects.stdout.split("\n").slice(0, -1)) {
    const problem = messageProblem(subject);
    if (problem) refuse(`unpushed commit "${subject}": ${problem}, reword it first`);
  }
}

async function fixRound(
  project: string | undefined,
  message: string,
  files: readonly string[],
  root: string,
  io: Io,
): Promise<number> {
  const problem = messageProblem(message);
  if (problem) refuse(problem);

  const cwd = io.cwd;
  const { indexes, owners } = await projectIndexes(project, io);
  if (readDelivery(root, io.env).mode !== "prs") refuse("delivery mode is not prs");

  const s: Session = { ...io, indexes, ownRows: new Set(), owners };
  const inside = await read(
    s,
    ["rev-parse", "--is-inside-work-tree"],
    "cannot read whether this is a work tree",
  );

  if (inside.stdout.trimEnd() !== "true") refuse("not inside a work tree");

  const current = await read(
    s,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "cannot read HEAD",
    [0, 1],
  );

  if (current.code === 1) refuse("detached HEAD");

  const branch = current.stdout.trimEnd();

  const defaultBranch = await trunk(s);
  if (!defaultBranch) refuse("cannot read the default branch of origin");
  if (branch === defaultBranch) refuse(`cannot publish the default branch ${defaultBranch}`);
  requireIndex(project, indexes);
  if (!(await owned(s, branch))) refuse(`${branch} is not an owned branch`);

  const layers = await findLayers(s, branch, defaultBranch);
  if (layers.length) await requireReplay(s);

  const localTip = (
    await read(s, ["rev-parse", `refs/heads/${branch}`], `cannot read the tip of ${branch}`)
  ).stdout.trimEnd();

  if (!(await remote(s, branch))) refuse(`origin has no ${branch}, publish it first`);

  const remoteTip = await fetchRemoteTip(s, branch);
  if (
    !(await ancestor(
      s,
      remoteTip,
      localTip,
      `cannot read whether origin/${branch} is an ancestor of ${branch}`,
    ))
  )
    refuse(`origin/${branch} has commits ${branch} lacks`);

  const { leases, resumed, recorded, replan } = await readOrigin(s, branch, layers, "fix-round");
  const selection = await selectedIndex(cwd, files, io);
  if ("reason" in selection) refuse(selection.reason);

  const unpushed = `${remoteTip}..${localTip}`;
  const touched = async (range: string, path: string) =>
    (
      await read(
        s,
        ["log", "--format=", "--name-only", "-z", range, "--", path],
        `cannot read the commits in ${range}`,
      )
    ).stdout.length > 0;

  const staging = await stageSelected(
    cwd,
    files,
    async (path) =>
      (await touched(unpushed, path)) ||
      (recorded !== undefined && (await touched(`${recorded}..${localTip}`, path))),
    selection,
    io,
  );

  if (staging) refuse(staging);

  const committed = await commitStaged(cwd, message, io);
  if (typeof committed === "string") refuse(committed);

  if (!committed) {
    if (localTip === remoteTip) {
      if (replan) return restackLayers(s, branch, replan, layers, leases, "fix-round", []);
      if (!resumed.length) refuse("nothing to commit for this round");
      await requireStacked(s, branch, layers);
      return 0;
    }

    await requireSubjects(s, unpushed);
  }

  const head = (
    await read(s, ["rev-parse", "HEAD"], `committed on ${branch} but cannot read its HEAD`)
  ).stdout.trimEnd();

  const preRound = committed
    ? localTip
    : (
        await read(s, ["rev-parse", `${head}^`], `cannot read the commit below ${branch}`)
      ).stdout.trimEnd();

  const short = (
    await read(
      s,
      ["rev-parse", "--short", head],
      `committed on ${branch} but cannot read its short HEAD`,
    )
  ).stdout.trimEnd();

  const pushed = await git(s, ["push", "--quiet", "origin", `${head}:refs/heads/${branch}`], {
    stdoutToStderr: true,
    write: true,
  });

  if (
    pushed.code !== 0 &&
    (await settled(s, [{ branch, before: remoteTip, after: head }], pushed.code)) === "none"
  )
    refuse("git push failed");

  return restackLayers(s, branch, replan ?? preRound, layers, leases, "fix-round", [
    `committed ${short} on ${branch}`,
    `pushed ${branch}`,
  ]);
}

export async function fixRoundVerb(
  args: readonly string[],
  usage: string,
  root: string,
  io: Io,
): Promise<number> {
  const parsed = argumentsFor(args, "Pm");
  const project = parsed?.options.get("P");
  const message = parsed?.options.get("m");
  if (!parsed || message === undefined || parsed.files.length === 0) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    return await fixRound(project, message, parsed.files, root, io);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`fix-round: ${error.message}\n`);
    return 1;
  }
}
