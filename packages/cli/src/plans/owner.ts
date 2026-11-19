import { mkdirSync } from "node:fs";
import type { Io } from "../io.ts";
import { defaultBranch, detectProject, detectProjects, gitRead, readCheckout } from "../project.ts";
import { describe } from "../read.ts";
import { branchOwners, readWorld, type Base, type Owner, type World } from "./artifacts.ts";
import { closedStatus } from "./checkouts.ts";
import { plansDir } from "./index-tsv.ts";

export type Checkout = { base: Base; world: World; branch: string };

export async function trailProject(io: Io): Promise<string> {
  return (
    (await detectProject(io.cwd, plansDir(io.env), true)) ??
    (await readCheckout(io.cwd, true, io)).candidates.at(-1)!
  );
}

function mineOf(branch: string, base: Base, world: World): Owner[] {
  const owners = branchOwners(branch, base, world);
  const open = (world.projects.get(base.project) ?? []).some(
    (row) => row.branch === branch && !closedStatus(row),
  );

  return open || owners[0]?.kind !== "plan"
    ? owners
    : [...owners, { kind: "adhoc", repo: base.trail, branch }];
}

export async function readBase(project: string, scratch: string, io: Io): Promise<Base | string> {
  const trunk = await defaultBranch(io.cwd, io);
  if (!trunk.ok) {
    if (trunk.failure) io.err(`${describe(trunk.failure)}\n`);
    return "cannot read the default branch of origin";
  }

  const trail = await trailProject(io);
  const { candidates } = await readCheckout(io.cwd, true, io);
  return { project, trail, repos: [trail, ...candidates], trunk: trunk.branch, scratch };
}

export async function readOwnCheckout(
  io: Io,
  scratch: string,
  create: boolean,
): Promise<Checkout | string> {
  const detected = await detectProjects(io.cwd, plansDir(io.env), true);
  if (detected.length > 1)
    return `the checkout's names match two projects: ${detected.join(" and ")}`;

  const base = await readBase(detected[0] ?? "", scratch, io);
  if (typeof base === "string") return base;

  const head = await gitRead(io.cwd, ["symbolic-ref", "--quiet", "HEAD"], {}, io);
  if (!head.ok) return `cannot read HEAD (${describe(head.failure)})`;
  if (head.code === 1) return "the checkout has no owner: HEAD is detached";

  const branch = head.stdout.trim().replace(/^refs\/heads\//, "");
  if (head.code !== 0 || !branch) return `cannot read HEAD (git exited ${head.code})`;
  if (branch === base.trunk) return `the checkout has no owner: ${branch} is the default branch`;
  if (create) mkdirSync(plansDir(io.env), { recursive: true });

  const world = await readWorld(base, io);
  if (typeof world === "string") return world;

  base.mine = mineOf(branch, base, world);
  return { base, world, branch };
}
