import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HOC_ID,
  type ISSUE_CLOSED,
  type ISSUE_FILED,
  type ISSUE_LINK,
  type StoreDraft,
  type StorePayloads,
  type StoreType,
} from "skills-core";
import { detectProject, gitOutput } from "../project.ts";
import { importRoot } from "./import.ts";
import { plansDir } from "./index-tsv.ts";
import { appendEvent, openStore, projectRows, write, type Store } from "./store.ts";

const VERB_BUSY_MS = 5000;

const CLOSED = new Set(["DONE", "DROPPED"]);

type Placed = { project: string; plan: string } | { project: string; branch: string | undefined };

export type Place = Placed | { cwd: string; branch?: string };

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export async function placed(root: string, place: Place): Promise<Placed> {
  if ("project" in place) return place;

  const [project, head] = await Promise.all([
    detectProject(place.cwd, root, true),
    place.branch === undefined
      ? gitOutput(place.cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { quiet: true })
      : Promise.resolve(place.branch),
  ]);

  return { project: project ?? AD_HOC_ID, branch: head?.trim() || undefined };
}

export function plansOn(store: Store, project: string, branch: string | undefined): string[] {
  if (project === AD_HOC_ID || !branch) return [AD_HOC_ID];

  const ids = projectRows(store, project)
    .filter((row) => row.branch === branch && !CLOSED.has(row.status))
    .map((row) => row.id);

  return ids.length ? ids : [AD_HOC_ID];
}

type Recorded = Exclude<
  StoreType,
  typeof ISSUE_FILED | typeof ISSUE_CLOSED | typeof ISSUE_LINK | "revision"
>;

type Dedupe<T extends Recorded> = {
  against: "latest" | "any";
  same: (seen: StorePayloads[T], next: StorePayloads[T]) => boolean;
};

type Policy = {
  [T in Recorded]: {
    everyPlan: boolean;
    dedupe?: Dedupe<T>;
    link?: (payload: StorePayloads[T], plans: string[]) => StorePayloads[T];
  };
};

const sameOutcomes = (left: Record<string, string>, right: Record<string, string>) =>
  JSON.stringify(Object.entries(left).sort()) === JSON.stringify(Object.entries(right).sort());

const POLICY: Policy = {
  "hook-block": { everyPlan: false },
  eval: { everyPlan: false },
  machine: { everyPlan: false },
  session: {
    everyPlan: false,
    link: (payload, plans) => ({ ...payload, plans: plans.filter((id) => id !== AD_HOC_ID) }),
  },
  "session-stats": { everyPlan: false },
  pr: {
    everyPlan: true,
    dedupe: {
      against: "latest",
      same: (seen, next) =>
        seen.state === next.state && seen.head === next.head && seen.verdict === next.verdict,
    },
  },
  round: {
    everyPlan: true,
    dedupe: {
      against: "any",
      same: (seen, next) =>
        next.head !== "" && seen.head === next.head && sameOutcomes(seen.outcomes, next.outcomes),
    },
  },
};

function repeats<T extends Recorded>(
  store: Store,
  type: T,
  project: string,
  plan: string,
  payload: StorePayloads[T],
): boolean {
  const dedupe = POLICY[type].dedupe as Dedupe<T> | undefined;
  if (!dedupe) return false;

  const seen = store.db
    .query(
      `SELECT payload FROM events
       WHERE type = ? AND project = ? AND plan = ? AND json_extract(payload, '$.pr') = ?
       ORDER BY wall DESC, counter DESC, machine DESC ${dedupe.against === "latest" ? "LIMIT 1" : ""}`,
    )
    .all(type, project, plan, (payload as { pr: number }).pr) as { payload: string }[];

  return seen.some((row) => dedupe.same(JSON.parse(row.payload), payload));
}

export async function recordEvent<T extends Recorded>(
  type: T,
  payload: StorePayloads[T],
  place: Place,
  env: NodeJS.ProcessEnv,
  busyMs = VERB_BUSY_MS,
): Promise<void> {
  try {
    const root = plansDir(env);
    if (!isDirectory(root)) return;

    const where = await placed(root, place);
    if (!existsSync(join(root, "plans.db"))) await importRoot(root, true, busyMs);

    const store = openStore(join(root, "plans.db"), { busyMs, drain: false });
    try {
      const linked =
        "plan" in where
          ? [where.plan]
          : store.db.transaction(() => plansOn(store, where.project, where.branch)).deferred();

      const plans = POLICY[type].everyPlan ? linked : linked.slice(0, 1);
      const link = POLICY[type].link as Policy[T]["link"];
      const body = link ? link(payload, linked) : payload;
      const at = Date.now();

      write(store, () => {
        for (const plan of plans) {
          if (repeats(store, type, where.project, plan, body)) continue;

          appendEvent(store, {
            kind: "stored",
            type,
            at,
            project: where.project,
            plan,
            payload: body,
          } as StoreDraft);
        }
      });
    } finally {
      store.db.close();
    }
  } catch {}
}
