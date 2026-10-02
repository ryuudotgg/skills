import { statSync } from "node:fs";
import { readDelivery } from "../delivery.ts";
import type { Io } from "../io.ts";
import { checkoutIs } from "../project.ts";
import { argumentsFor, commitStaged, messageProblem, selectedIndex, stageSelected } from "../publish/commit.ts";
import { findLayers, indexRows, ok, readOrigin, remote, restackLayers, trunk } from "./layers.ts";
import { git, Refusal, refuse, requireReplay, type Session } from "./restack.ts";

async function fixRound(project: string, message: string, files: readonly string[], root: string, io: Io): Promise<number> {
  const problem = messageProblem(message);
  if (problem) refuse(problem);

  const cwd = io.cwd;
  const checkout = await checkoutIs(cwd, project, io);
  if (checkout) refuse(checkout);
  if (readDelivery(root, io.env).mode !== "prs") refuse("delivery mode is not prs");

  const index = `${io.env.PLANS_DIR || `${io.env.HOME ?? ""}/Plans`}/${project}/index.tsv`;
  const s: Session = { ...io, indexes: [index], ownRows: new Set() };
  const inside = await git(s, ["rev-parse", "--is-inside-work-tree"], { stderr: "ignore" });
  if (inside.stdout.trimEnd() !== "true") refuse("not inside a work tree");

  const current = await git(s, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (current.code !== 0) refuse("detached HEAD");

  const branch = current.stdout.trimEnd();

  const defaultBranch = await trunk(s);
  if (!defaultBranch) refuse("cannot read the default branch of origin");
  if (branch === defaultBranch) refuse(`cannot publish the default branch ${defaultBranch}`);
  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) refuse(`no index.tsv for ${project}`);
  if (!indexRows(index).some((fields) => fields[7] === branch)) refuse(`${branch} is not an owned branch`);

  const layers = await findLayers(s, branch, index);
  await requireReplay(s);

  const localTip = (await git(s, ["rev-parse", `refs/heads/${branch}`])).stdout.trimEnd();
  if (!await remote(s, branch)) refuse(`origin has no ${branch}, publish it first`);

  const fetched = await git(s, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { stdoutToStderr: true });
  if (fetched.code !== 0) refuse(`cannot fetch origin/${branch}`);

  const remoteTip = (await git(s, ["rev-parse", `refs/remotes/origin/${branch}`])).stdout.trimEnd();
  if (!await ok(s, ["merge-base", "--is-ancestor", remoteTip, localTip])) refuse(`origin/${branch} has commits ${branch} lacks`);

  const leases = await readOrigin(s, layers);
  const selection = await selectedIndex(cwd, files, io);
  if ("reason" in selection) refuse(selection.reason);

  const staging = await stageSelected(cwd, files, undefined, selection, io);
  if (staging) refuse(staging);

  const committed = await commitStaged(cwd, message, io);
  if (typeof committed === "string") refuse(committed);
  if (!committed) refuse("nothing to commit for this round");

  const short = (await git(s, ["rev-parse", "--short", "HEAD"])).stdout.trimEnd();
  const pushed = await git(s, ["push", "--quiet", "origin", `refs/heads/${branch}:refs/heads/${branch}`], { stdoutToStderr: true, write: true });
  if (pushed.code !== 0) refuse("git push failed");

  return restackLayers(s, branch, localTip, layers, leases, "fix-round", [`committed ${short} on ${branch}`, `pushed ${branch}`]);
}

export async function fixRoundVerb(args: readonly string[], usage: string, root: string, io: Io): Promise<number> {
  const parsed = argumentsFor(args, "Pm");
  const project = parsed?.options.get("P");
  const message = parsed?.options.get("m");
  if (!parsed || project === undefined || message === undefined || parsed.files.length === 0) {
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
