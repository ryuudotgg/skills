import { readDelivery } from "../delivery.ts";
import { ok, trunk } from "./layers.ts";
import { apply, checkIdle, git, plan, plansIndexes, push, Refusal, refuse, requireReplay, type Session } from "./restack.ts";

const PREFIX = "lease-rebase";

async function leaseRebase(args: readonly string[], root: string): Promise<number> {
  const [parent = "", old = "", ...branches] = args;
  const s: Session = {
    cwd: process.cwd(),
    indexes: plansIndexes(),
    ownRows: new Set((process.env.SKILLS_OWN_ROWS ?? "").split(" ").filter(Boolean)),
  };

  if (readDelivery(root, process.env).mode !== "prs") refuse("delivery mode is not prs");

  const inside = await git(s, ["rev-parse", "--is-inside-work-tree"], { stderr: "ignore" });
  if (inside.stdout.trim() !== "true") refuse("not inside a work tree");
  if (!(await ok(s, ["symbolic-ref", "--quiet", "--short", "HEAD"]))) refuse("detached HEAD");
  if ((await git(s, ["status", "--porcelain"])).stdout.trim()) refuse("dirty tree");

  const defaultBranch = await trunk(s);
  if (!defaultBranch) refuse("cannot read the default branch of origin");
  if (!(await ok(s, ["rev-parse", "--verify", "--end-of-options", `${old}^{commit}`]))) refuse(`no such commit: ${old}`);
  if (!(await ok(s, ["rev-parse", "--verify", "--end-of-options", `${parent}^{commit}`]))) refuse(`no such parent: ${parent}`);

  await requireReplay(s);

  const leases = new Map<string, string>();
  for (const branch of branches) {
    if (branch === defaultBranch) refuse(`cannot rebase the default branch ${defaultBranch}`);
    if (leases.has(branch)) refuse(`branch listed twice: ${branch}`);
    if (!(await ok(s, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]))) refuse(`no local branch ${branch}`);

    const remote = await git(s, ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]);
    if (remote.code === 2) refuse(`${branch} is not on origin`);
    if (remote.code !== 0) refuse(`cannot read origin/${branch}`);

    await checkIdle(s, branch);

    const fetched = await git(s, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], {
      stdoutToStderr: true,
    });

    if (fetched.code !== 0) refuse(`cannot read origin/${branch}`);

    const expected = (await git(s, ["rev-parse", `refs/remotes/origin/${branch}`])).stdout.trim();
    if ((await git(s, ["merge-base", "--is-ancestor", expected, `refs/heads/${branch}`])).code !== 0)
      refuse(`origin/${branch} has commits ${branch} lacks`);

    leases.set(branch, expected);
  }

  const planned = await plan(s, parent, old, branches);
  if (planned.kind === "conflict") refuse(planned.reason);

  const pushed = await push(s, planned.moves, leases);
  if (!pushed) refuse("lease push rejected, no layer moved");

  const applied = await apply(s, planned.moves, pushed, leases, PREFIX);
  process.stdout.write(applied.completed.map((move) => `${move.branch} ${move.old} ${move.next}\n`).join(""));
  if (applied.error) refuse(applied.error);

  return 0;
}

export async function leaseRebaseVerb(args: readonly string[], usage: string, root: string): Promise<number> {
  if (args.length < 3) {
    process.stderr.write(`usage: ${usage}\n`);
    return 2;
  }

  try {
    return await leaseRebase(args, root);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stderr.write(`${PREFIX}: ${error.message}\n`);
    return 1;
  }
}
