import { join } from "node:path";
import {
  HEARTBEAT,
  HEARTBEAT_EVERY_MS,
  projectPolicy,
  secondStamp,
  type Heartbeat,
  type Host,
} from "skills-core";
import { newestFacts } from "../plans/machine.ts";
import { appendEvent, isBusy, openStore, projectRows, write, type Store } from "../plans/store.ts";
import { localLinks, projectPolicies, sessionKey, silencedSessions } from "../sessions/policy.ts";
import type { Outcome, Place } from "./heartbeat.ts";

const BUSY_MS = 100;

const HOSTS: readonly Host[] = ["claude", "codex", "opencode"];
function shareable(store: Store, root: string, project: string, session: string): boolean {
  const policies = projectPolicies(store);
  if (projectPolicy(policies, project) === "off") return false;

  const quiet = silencedSessions(store, policies, localLinks(root));
  return !HOSTS.some((host) => quiet.has(sessionKey(host, session)));
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

function failure(error: unknown): Outcome {
  return isBusy(error) ? "busy" : "failed";
}

export function record(
  root: string,
  place: Place,
  session: string | undefined,
  now: number,
): Outcome {
  let store: Store;
  try {
    store = openStore(join(root, "plans.db"), { busyMs: BUSY_MS, drain: false });
  } catch (error) {
    return failure(error);
  }

  const doing = () =>
    projectRows(store, place.project).filter(
      (entry) => entry.status === "DOING" && entry.branch === place.branch,
    );

  try {
    if (doing().length === 0) return "idle";

    return write(store, () => {
      const named =
        session !== undefined && shareable(store, root, place.project, session)
          ? session
          : undefined;

      const environment = newestFacts(store)?.environment ?? null;
      const pending = doing().filter(
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
  } catch (error) {
    return failure(error);
  } finally {
    store.db.close();
  }
}
