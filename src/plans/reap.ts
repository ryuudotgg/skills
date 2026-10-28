import { statSync } from "node:fs";
import type { Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { checkoutIs, defaultBranch, readCheckout } from "../project.ts";
import { describe } from "../read.ts";
import { ADAPTERS, type Adapter, type Tools } from "./artifact-kinds.ts";
import { judge, readWorld, type Artifact, type Base, type Hold } from "./artifacts.ts";
import { indexPath, missingIndex, scratchLock } from "./index-tsv.ts";
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

export async function reapVerb(
  args: readonly string[],
  usage: string,
  io: Io,
  { scratch = "/tmp", grace = 10_000 }: ReapOptions = {},
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const rest = args.filter((arg) => arg !== "--dry-run");
  const [project = ""] = rest;
  if (rest.length !== 1 || project.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`reap: ${reason}\n`);
    return 1;
  };

  let index: string;
  try {
    index = indexPath(project, io.env);
  } catch (error) {
    return refuse(failure(error).reason);
  }

  if (!statSync(index, { throwIfNoEntry: false })?.isFile()) return refuse(missingIndex(project));

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return refuse(elsewhere);

  const trunk = await defaultBranch(io.cwd, io);
  if (!trunk.ok) {
    if (trunk.failure) io.err(`${describe(trunk.failure)}\n`);
    return refuse("cannot read the default branch of origin");
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
