import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { HEARTBEAT_EVERY_MS } from "skills-core/pulse";
import { plansDir } from "../plans/paths.ts";
import { checkoutOf, projectsNamed } from "../project.ts";
import { readSync } from "../read.ts";
import { scrubGitEnv, sessionOf } from "./sweep.ts";

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

function stamp(path: string, now: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ at: now }));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function placeOf(cwd: string, root: string, env: NodeJS.ProcessEnv): Place | undefined {
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
    { cwd, env: scrubGitEnv(env), deadline: 2000 },
  );

  if (!result.ok || result.code !== 0) return undefined;

  const [top, common, head] = result.stdout.split("\n");
  if (!head?.startsWith("refs/heads/") || !common) return undefined;

  const branch = head.slice("refs/heads/".length);
  if (defaultBranches(common).includes(branch)) return undefined;

  const [project] = projectsNamed(checkoutOf(top, common, cwd).candidates, root);
  return project === undefined ? undefined : { project, branch };
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

    stamp(throttle, now);

    const root = resolve(plansDir(env));
    const place = existsSync(join(root, "plans.db")) ? placeOf(cwd, root, env) : undefined;
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
