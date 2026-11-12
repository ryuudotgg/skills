import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import {
  HEARTBEAT,
  HEARTBEAT_EVERY_MS,
  projectPolicy,
  secondStamp,
  type Heartbeat,
  type Host,
} from "skills-core";
import { parseIndexText, plansDir } from "../plans/index-tsv.ts";
import { newestFacts } from "../plans/machine.ts";
import { appendEvent, openStore, projectRows, sha256, write, type Store } from "../plans/store.ts";
import { checkoutOf, projectsNamed } from "../project.ts";
import { readSync } from "../read.ts";
import { localLinks, projectPolicies, sessionKey, silencedSessions } from "../sessions/policy.ts";
import { scrubGitEnv, sessionOf } from "./sweep.ts";

const BUSY_MS = 100;

type Place = { project: string; branch: string };

type Outcome = "written" | "idle" | "busy";

const HOSTS: readonly Host[] = ["claude", "codex", "opencode"];

function throttlePath(
  data: Record<string, unknown>,
  session: string | undefined,
  cwd: string,
): string {
  const directory =
    typeof data.scratchpad_dir === "string" && data.scratchpad_dir ? data.scratchpad_dir : "/tmp";

  const name = session ?? `anon-${sha256(resolve(cwd)).slice(0, 16)}`;
  return join(directory, `heartbeat-${name}.json`);
}

function shareable(store: Store, root: string, project: string, session: string): boolean {
  const policies = projectPolicies(store);
  if (projectPolicy(policies, project) === "off") return false;

  const quiet = silencedSessions(store, policies, localLinks(root));
  return !HOSTS.some((host) => quiet.has(sessionKey(host, session)));
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

function beatSince(
  store: Store,
  place: Place,
  plan: string,
  session: string | undefined,
  since: number,
): boolean {
  const found = store.db
    .query(
      `SELECT 1 FROM events
       WHERE type = ? AND project = ? AND plan = ? AND machine = ? AND ts >= ?
         AND coalesce(json_extract(payload, '$.session'), '') = ?
       LIMIT 1`,
    )
    .get(HEARTBEAT, place.project, plan, store.machine, secondStamp(since), session ?? "");

  return found !== null;
}

function doingIn(view: string, branch: string): boolean {
  try {
    return parseIndexText(readFileSync(view, "utf8")).some(
      (row) => row.status === "DOING" && row.branch === branch,
    );
  } catch {
    return false;
  }
}

function record(root: string, place: Place, session: string | undefined, now: number): Outcome {
  let store;
  try {
    store = openStore(join(root, "plans.db"), { busyMs: BUSY_MS, drain: false });
  } catch {
    return "busy";
  }

  try {
    return write(store, () => {
      const rows = projectRows(store, place.project).filter(
        (entry) => entry.status === "DOING" && entry.branch === place.branch,
      );

      const named =
        session !== undefined && shareable(store, root, place.project, session)
          ? session
          : undefined;

      const environment = newestFacts(store)?.environment ?? null;
      const pending = rows.filter(
        (row) => !beatSince(store, place, row.id, named, now - HEARTBEAT_EVERY_MS),
      );

      for (const row of pending) {
        const payload: Heartbeat = {
          branch: place.branch,
          environment,
          ...(named === undefined ? {} : { session: named }),
        };

        appendEvent(store, {
          kind: "stored",
          type: HEARTBEAT,
          at: now,
          project: place.project,
          plan: row.id,
          payload,
        });
      }

      return pending.length > 0 ? "written" : "idle";
    });
  } catch {
    return "busy";
  } finally {
    store.db.close();
  }
}

export function beat(data: Record<string, unknown>, env: NodeJS.ProcessEnv): Outcome | undefined {
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
      place !== undefined && doingIn(join(root, place.project, "index.tsv"), place.branch)
        ? record(root, place, session, now)
        : "idle";

    if (outcome === "busy") rmSync(throttle, { force: true });
    return outcome;
  } catch {
    return undefined;
  }
}
