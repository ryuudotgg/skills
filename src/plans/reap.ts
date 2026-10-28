import { statSync } from "node:fs";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { checkoutIs, defaultBranch, detectProjects, gitRead, readCheckout } from "../project.ts";
import { describe } from "../read.ts";
import { ADAPTERS, type Adapter, type Tools } from "./artifact-kinds.ts";
import {
  branchOwners,
  judge,
  readWorld,
  type Artifact,
  type Base,
  type Hold,
  type Owner,
  type World,
} from "./artifacts.ts";
import { closedStatus } from "./checkouts.ts";
import { indexPath, missingIndex, plansDir, scratchLock } from "./index-tsv.ts";
import { trailProject } from "./threads.ts";

export type ReapOptions = { scratch?: string; grace?: number };

type Outcome = { kind: "reaped" } | { kind: "kept"; hold: Hold } | { kind: "silent" };

function failure(error: unknown): Hold {
  return { reason: error instanceof Error ? error.message : String(error), failed: true };
}

async function reapOne(
  adapter: Adapter,
  artifact: Artifact,
  base: Base,
  tools: Tools,
): Promise<Outcome> {
  const { io } = tools;
  const locked = (step: Adapter["stop"], stopped: boolean) =>
    withLock(scratchLock(io.env), "scratch", async (): Promise<Outcome | undefined> => {
      const world = await readWorld(base, io);
      if (typeof world === "string") return { kind: "kept", hold: { reason: world, failed: true } };

      const again = judge(artifact, base, world);
      if (again.kind === "kept") return again;
      if (again.kind === "silent")
        return stopped
          ? {
              kind: "kept",
              hold: { reason: "stopped, then its owner held it again", failed: false },
            }
          : again;

      const reason = await step(artifact, tools);
      return reason ? { kind: "kept", hold: { reason, failed: true } } : undefined;
    });

  try {
    const stopped = await locked(adapter.stop, false);
    if (stopped) return stopped;

    const settled = await adapter.settle(artifact, tools);
    if (settled) return { kind: "kept", hold: { reason: settled, failed: true } };

    return (await locked(adapter.remove, true)) ?? { kind: "reaped" };
  } catch (error) {
    return { kind: "kept", hold: failure(error) };
  }
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

export async function reapVerb(
  args: readonly string[],
  usage: string,
  io: Io,
  { scratch = "/tmp", grace = 10_000 }: ReapOptions = {},
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const mine = args.includes("--mine");
  const rest = args.filter((arg) => arg !== "--dry-run" && arg !== "--mine");
  const [named = ""] = rest;
  if (mine ? rest.length !== 0 : rest.length !== 1 || named.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`reap: ${reason}\n`);
    return 1;
  };

  const detected = mine ? await detectProjects(io.cwd, plansDir(io.env), true) : [];
  if (detected.length > 1)
    return refuse(`the checkout's names match two projects: ${detected.join(" and ")}`);

  const project = mine ? (detected[0] ?? "") : named;
  if (!mine) {
    let index: string;
    try {
      index = indexPath(project, io.env);
    } catch (error) {
      return refuse(failure(error).reason);
    }

    if (!statSync(index, { throwIfNoEntry: false })?.isFile()) return refuse(missingIndex(project));

    const elsewhere = await checkoutIs(io.cwd, project, io);
    if (elsewhere) return refuse(elsewhere);
  }

  const trunk = await defaultBranch(io.cwd, io);
  if (!trunk.ok) {
    if (trunk.failure) io.err(`${describe(trunk.failure)}\n`);
    return refuse("cannot read the default branch of origin");
  }

  let branch: string | undefined;
  if (mine) {
    const head = await gitRead(io.cwd, ["symbolic-ref", "--quiet", "HEAD"], {}, io);
    if (!head.ok) return refuse(`cannot read HEAD (${describe(head.failure)})`);
    if (head.code === 1) return refuse("the checkout has no owner: HEAD is detached");

    branch = head.stdout.trim().replace(/^refs\/heads\//, "");
    if (head.code !== 0 || !branch) return refuse(`cannot read HEAD (git exited ${head.code})`);
    if (branch === trunk.branch)
      return refuse(`the checkout has no owner: ${branch} is the default branch`);
  }

  const trail = await trailProject(io);
  const { candidates } = await readCheckout(io.cwd, true, io);
  const base: Base = {
    project,
    trail,
    repos: [trail, ...candidates],
    trunk: trunk.branch,
    scratch,
  };

  const world = await readWorld(base, io);
  if (typeof world === "string") return refuse(world);
  if (branch !== undefined) base.mine = mineOf(branch, base, world);

  const tools: Tools = { io, grace, self: process.pid };
  const verb = dryRun ? "would reap" : "reaped";

  let failed = false;
  let reaped = 0;
  let counted = 0;
  for (const adapter of ADAPTERS) {
    const listing = await adapter.list(tools);
    if (listing.kind === "skipped") {
      io.out(`skipped ${adapter.kind}: ${listing.reason}\n`);
      continue;
    }

    if (listing.kind === "failed") {
      failed = true;
      io.err(`reap: ${adapter.kind}: ${listing.reason}\n`);
      continue;
    }

    for (const artifact of listing.artifacts) {
      const verdict = judge(artifact, base, world);
      if (verdict.kind === "silent") continue;

      const outcome: Outcome =
        verdict.kind === "kept"
          ? verdict
          : dryRun
            ? { kind: "reaped" }
            : await reapOne(adapter, artifact, base, tools);

      if (outcome.kind === "silent") continue;

      counted += 1;
      const label = `${artifact.kind} ${artifact.name} ${verdict.token}`;
      if (outcome.kind === "reaped") {
        reaped += 1;
        io.out(`${verb} ${label}\n`);
        continue;
      }

      if (outcome.hold.failed) failed = true;
      io.out(`kept ${label}: ${outcome.hold.reason}\n`);
    }
  }

  io.out(`${verb} ${reaped} of ${counted}\n`);
  return failed ? 1 : 0;
}
