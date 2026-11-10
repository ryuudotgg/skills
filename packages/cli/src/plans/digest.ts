import { statSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HOC_ID,
  DIGEST_EVENT,
  digestOf,
  isoWeekSpan,
  parseTime,
  type WeekSpan,
} from "skills-core";
import type { Io } from "../io.ts";
import { openPlansStore } from "./commit.ts";
import { Refusal } from "./import.ts";
import { plansDir } from "./index-tsv.ts";
import { landedLine } from "./lint.ts";
import { lastSync } from "./outbox.ts";
import { allEvents, appendEvent, revisionText, write, type Store } from "./store.ts";
import { syncMeta } from "./sync.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function instantOf(args: readonly string[]): number | undefined {
  if (args.length === 0) return Date.now();
  if (args.length !== 2 || args[0] !== "--week" || !DATE.test(args[1]!)) return undefined;
  return parseTime(args[1]!);
}

function settled(store: Store, span: WeekSpan, now: number): boolean {
  const stamps = store.db
    .query(
      `SELECT ts FROM events WHERE type = ? AND quarantined IS NULL
       AND json_extract(payload, '$.week') = ? AND json_type(payload, '$.markdown') = 'text'`,
    )
    .all(DIGEST_EVENT, span.week) as { ts: string }[];

  const final = stamps.some(({ ts }) => Date.parse(ts) >= span.end);
  return stamps.length > 0 && (now < span.end || final);
}

async function pulled(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const { hubSetting } = await import("../hub/network.ts");
  if (hubSetting(env, "HUB_URL") === undefined) return undefined;

  const since = new Date().toISOString();

  try {
    const { shortSyncWithin } = await import("../hub/sync.ts");
    await shortSyncWithin(env);
  } catch {}

  return since;
}

function unsynced(store: Store, since: string | undefined): boolean {
  if (since === undefined || syncMeta(store).checkpoint === undefined) return false;
  return (lastSync(store) ?? "") < since;
}

function landedOf(store: Store, revision: string): string | undefined {
  const bytes = revisionText(store, revision);
  return bytes && landedLine(Buffer.from(bytes).toString("utf8"))?.line.trim();
}

function refuse(io: Io, reason: string): number {
  io.err(`digest: ${reason}\n`);
  return 1;
}

export async function digestVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const at = instantOf(args);
  if (at === undefined) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const root = plansDir(io.env);
  if (!isDirectory(root)) return refuse(io, `no plans directory at ${root}`);

  const span = isoWeekSpan(at);
  const since = await pulled(io.env);

  let written: boolean;
  try {
    const store = await openPlansStore(root);
    try {
      const now = Date.now();
      written = write(store, () => {
        if (settled(store, span, now)) return false;
        if (now >= span.end && unsynced(store, since))
          throw new Refusal(
            `no hub sync finished since ${since}, so a final ${span.week} digest could miss another machine's events; rerun once the hub answers`,
          );

        const digest = digestOf(allEvents(store), at, (revision) => landedOf(store, revision));
        appendEvent(store, {
          kind: "stored",
          type: DIGEST_EVENT,
          at: now,
          project: AD_HOC_ID,
          plan: AD_HOC_ID,
          payload: digest,
        });

        return true;
      });
    } finally {
      store.db.close();
    }
  } catch (error) {
    if (error instanceof Refusal) return refuse(io, error.message);
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(io, `cannot write ${join(root, "plans.db")}: ${reason}`);
  }

  io.out(`digest ${span.week} ${written ? "written" : "exists"}\n`);
  return 0;
}
