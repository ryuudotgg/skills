import type { Io } from "../io.ts";
import { LOCK_POLL, tryLock } from "../lock.ts";
import { checkoutIs } from "../project.ts";
import { within } from "../read.ts";
import { ADAPTERS, cutOff, type Adapter, type Bound, type Tools } from "./artifact-kinds.ts";
import {
  failure,
  judge,
  readWorld,
  type Artifact,
  type Base,
  type Hold,
  type Kind,
} from "./artifacts.ts";
import { deviceLock, type Platform } from "./device.ts";
import { missingIndex, projectDir, scratchRoot, STEP_BOUND, withScratchLock } from "./index-tsv.ts";
import { readBase, readOwnCheckout, stillMine, type Checkout } from "./owner.ts";
import { readProject } from "./projection.ts";

export type ReapOptions = { scratch?: string; grace?: number; bound?: number };

const WAITERS_TURN = 2 * LOCK_POLL;
const PLATFORMS: Partial<Record<Kind, Platform>> = { simulator: "ios", avd: "android" };

type Outcome = { kind: "reaped" } | { kind: "kept"; hold: Hold } | { kind: "silent" };

function kept(said: string | Hold): Outcome {
  return { kind: "kept", hold: typeof said === "string" ? { reason: said, failed: true } : said };
}

async function reapOne(
  adapter: Adapter,
  artifact: Artifact,
  base: Base,
  branch: string,
  tools: Tools,
  limit: number,
): Promise<Outcome> {
  const { io } = tools;
  const locked = async (step: Adapter["stop"], stopped: boolean) => {
    const outcome = await withScratchLock(io.env, async (): Promise<Outcome | undefined> => {
      const bound: Bound = { limit, until: Date.now() + limit };
      const reading = readWorld(base, io);
      const read = await within(reading, bound.until - Date.now());
      const world = read ?? cutOff(bound, "reading its holds");
      if (typeof world === "string") return kept(world);

      const again = judge(artifact, stillMine(base, branch, world), world);
      if (again.kind === "kept") return again;
      if (again.kind === "silent")
        return stopped
          ? kept({ reason: "stopped, then its owner held it again", failed: false })
          : again;

      const said = await step(artifact, { ...tools, bound });
      const reason = bound.cut ?? said;
      return reason ? kept(reason) : undefined;
    });

    await Bun.sleep(WAITERS_TURN);
    return outcome;
  };

  const steps = async (): Promise<Outcome> => {
    const stopped = await locked(adapter.stop, false);
    if (stopped) return stopped;

    const settled = await adapter.settle(artifact, tools);
    if (settled) return kept(settled);

    return (await locked(adapter.remove, true)) ?? { kind: "reaped" };
  };

  try {
    const platform = PLATFORMS[adapter.kind];
    if (!platform) return await steps();

    const device = await tryLock(deviceLock(platform, artifact.name, io.env), steps);
    return device.held
      ? kept({ reason: "a skills device call is using it", failed: false })
      : device.value;
  } catch (error) {
    return { kind: "kept", hold: failure(error) };
  }
}

async function readNamed(project: string, scratch: string, io: Io): Promise<Checkout | string> {
  try {
    projectDir(project, io.env);
  } catch (error) {
    return failure(error).reason;
  }

  const read = await readProject(project, io.env);
  if (read.kind === "failed") return read.reason;
  if (read.kind === "absent") return missingIndex(project);

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return elsewhere;

  const base = await readBase(project, scratch, io);
  if (typeof base === "string") return base;

  const world = await readWorld(base, io);
  return typeof world === "string" ? world : { base, world, branch: "" };
}

export async function reapVerb(
  args: readonly string[],
  usage: string,
  io: Io,
  { scratch = scratchRoot(io.env), grace = 10_000, bound = STEP_BOUND }: ReapOptions = {},
): Promise<number> {
  const dryRun = args.includes("--dry-run");
  const mine = args.includes("--mine");
  const rest = args.filter((arg) => arg !== "--dry-run" && arg !== "--mine");
  const [named = ""] = rest;
  if (mine ? rest.length !== 0 : rest.length !== 1 || named.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const read = mine
    ? await readOwnCheckout(io, scratch, !dryRun)
    : await readNamed(named, scratch, io);

  if (typeof read === "string") {
    io.err(`reap: ${read}\n`);
    return 1;
  }

  const { base, world, branch } = read;
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
            : await reapOne(adapter, artifact, base, branch, tools, bound);

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
