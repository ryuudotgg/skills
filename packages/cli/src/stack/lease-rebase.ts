import { readDelivery } from "../delivery.ts";
import type { Io } from "../io.ts";
import { refuseDoing, requireStacked, resume, trunk } from "./layers.ts";
import {
  ancestor,
  apply,
  checkIdle,
  fetchRemoteTip,
  git,
  plan,
  push,
  read,
  readPlans,
  Refusal,
  refuse,
  requireReplay,
  type Move,
  type Session,
} from "./restack.ts";

const PREFIX = "lease-rebase";
async function leaseRebase(args: readonly string[], root: string, io: Io): Promise<number> {
  const [parent = "", old = "", ...branches] = args;
  const s: Session = {
    ...io,
    indexes: await readPlans(io.env),
    ownRows: new Set((io.env.SKILLS_OWN_ROWS ?? "").split(" ").filter(Boolean)),
    facts: new Map(),
  };

  if (readDelivery(root, io.env).mode !== "prs") refuse("delivery mode is not prs");

  const inside = await read(
    s,
    ["rev-parse", "--is-inside-work-tree"],
    "cannot read whether this is a work tree",
  );

  if (inside.stdout.trim() !== "true") refuse("not inside a work tree");

  const current = await read(
    s,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "cannot read HEAD",
    [0, 1],
  );

  if (current.code === 1) refuse("detached HEAD");
  if (
    (
      await read(s, ["status", "--porcelain"], `cannot read changes in ${current.stdout.trimEnd()}`)
    ).stdout.trim()
  )
    refuse("dirty tree");

  const defaultBranch = await trunk(s);
  if (!defaultBranch) refuse("cannot read the default branch of origin");

  const cutoff = await read(
    s,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${old}^{commit}`],
    `cannot read commit ${old} for ${branches.join(" ")}`,
    [0, 1],
  );

  if (cutoff.code === 1) refuse(`no such commit: ${old}`);

  const verified = await read(
    s,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${parent}^{commit}`],
    `cannot read parent ${parent} for ${branches.join(" ")}`,
    [0, 1],
  );

  if (verified.code === 1) refuse(`no such parent: ${parent}`);

  await requireReplay(s);

  const leases = new Map<string, string>();
  for (const branch of branches) {
    if (branch === defaultBranch) refuse(`cannot rebase the default branch ${defaultBranch}`);
    if (leases.has(branch)) refuse(`branch listed twice: ${branch}`);

    const local = await read(
      s,
      ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
      `cannot read local branch ${branch}`,
      [0, 1],
    );

    if (local.code === 1) refuse(`no local branch ${branch}`);

    const remote = await git(s, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
    if (remote.code === 2) refuse(`${branch} is not on origin`);
    if (remote.code !== 0) refuse(`cannot read origin/${branch}`);

    await checkIdle(s, branch);
    refuseDoing(s, branch);
    leases.set(branch, "");
  }

  const lines = (moves: readonly Move[]) =>
    moves.map((move) => `${move.branch} ${move.old} ${move.next}\n`).join("");

  const resumed = await resume(s, branches, parent, PREFIX);
  if (resumed) io.out(lines(resumed.completed));
  if (resumed && !resumed.replan) {
    if (resumed.error) refuse(resumed.error);
    await requireStacked(s, parent, branches);
    return 0;
  }

  const target = resumed?.replan ?? { parent, cutoff: cutoff.stdout.trimEnd(), layers: branches };
  for (const branch of target.layers) {
    const expected = await fetchRemoteTip(s, branch, `cannot read origin/${branch}`);
    if (
      !(await ancestor(
        s,
        expected,
        `refs/heads/${branch}`,
        `cannot read whether origin/${branch} is an ancestor of ${branch}`,
      ))
    )
      refuse(`origin/${branch} has commits ${branch} lacks`);

    leases.set(branch, expected);
  }

  const planned = await plan(s, target.parent, target.cutoff, target.layers);
  if (planned.kind === "conflict") refuse(planned.reason);

  const pushed = await push(s, target.cutoff, planned.moves, leases);
  if (!pushed) refuse("lease push rejected, no layer moved");

  const applied = await apply(s, planned.moves, pushed, leases, PREFIX);
  io.out(lines(applied.completed));
  if (applied.error) refuse(applied.error);

  return 0;
}

export async function leaseRebaseVerb(
  args: readonly string[],
  usage: string,
  root: string,
  io: Io,
): Promise<number> {
  if (args.length < 3) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    return await leaseRebase(args, root, io);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`${PREFIX}: ${error.message}\n`);
    return 1;
  }
}
