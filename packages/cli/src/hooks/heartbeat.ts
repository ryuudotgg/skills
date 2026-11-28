import { existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { HEARTBEAT_EVERY_MS } from "skills-core/pulse";
import { writeJsonAtomic } from "../io.ts";
import { plansDir } from "../plans/paths.ts";
import { answersFor, checkoutOf, pinRead } from "../project.ts";
import { readSync } from "../read.ts";
import { scrubGitEnv } from "./git-env.ts";
import { sessionOf } from "./payload.ts";

export type Place = { project: string; branch: string };

export type Outcome = "written" | "idle" | "busy" | "failed";

function throttlePath(
  data: Record<string, unknown>,
  session: string | undefined,
  cwd: string,
): string {
  const directory =
    typeof data.scratchpad_dir === "string" && data.scratchpad_dir ? data.scratchpad_dir : "/tmp";

  const name =
    session ??
    `anon-${new Bun.CryptoHasher("sha256").update(resolve(cwd)).digest("hex").slice(0, 16)}`;

  return join(directory, `heartbeat-${name}.json`);
}

function due(path: string, now: number): boolean {
  try {
    const { at } = JSON.parse(readFileSync(path, "utf8")) as { at?: unknown };
    return !(typeof at === "number" && at <= now && now - at < HEARTBEAT_EVERY_MS);
  } catch {
    return true;
  }
}

async function placeOf(
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Place | undefined> {
  const options = { cwd, env: scrubGitEnv(env), deadline: 2000 };
  const result = readSync(
    [
      "git",
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--symbolic-full-name",
      "HEAD",
    ],
    options,
  );

  if (!result.ok || result.code !== 0) return undefined;

  const [top, common, head] = result.stdout.split("\n");
  if (!head?.startsWith("refs/heads/") || !common) return undefined;

  const branch = head.slice("refs/heads/".length);
  if (defaultBranches(common).includes(branch)) return undefined;

  const pin = readSync(["git", ...pinRead], options);
  const checkout = checkoutOf(top, common, cwd, pin.ok && pin.code === 0 ? pin.stdout : undefined);
  const [answer] = await answersFor(checkout, root, async (args) => {
    const read = readSync(["git", ...args], options);
    return read.ok && read.code === 0 ? read.stdout : undefined;
  });

  return answer && { project: answer.project, branch };
}

function defaultBranches(common: string): readonly string[] {
  try {
    const ref = readFileSync(join(common, "refs/remotes/origin/HEAD"), "utf8").trim();
    if (ref.startsWith("ref: refs/remotes/origin/"))
      return [ref.slice("ref: refs/remotes/origin/".length)];
  } catch {}

  return ["main", "master"];
}

export async function beat(
  data: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): Promise<Outcome | undefined> {
  try {
    const now = Date.now();
    const session = sessionOf(data);
    const cwd = typeof data.cwd === "string" && data.cwd ? data.cwd : process.cwd();
    const throttle = throttlePath(data, session, cwd);
    if (!due(throttle, now)) return undefined;

    writeJsonAtomic(throttle, { at: now });

    const root = resolve(plansDir(env));
    const place = existsSync(join(root, "plans.db")) ? await placeOf(cwd, root, env) : undefined;
    const outcome =
      place === undefined
        ? "idle"
        : (await import("./heartbeat-store.ts")).record(root, place, session, now);

    if (outcome === "busy") rmSync(throttle, { force: true });
    return outcome;
  } catch {
    return undefined;
  }
}
