import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { withLock } from "../lock.ts";
import { cutCodePoints, flatten, parseTsvRow, plansDir, readTableTolerant, splitTsvLines, type Table } from "./index-tsv.ts";

export const TRAIL_COLUMNS = ["ts", "project", "id", "event", "detail"] as const;
export type TrailEntry = Record<(typeof TRAIL_COLUMNS)[number], string> & { line: string };

const LOG_HEADER = "ts\tproject\tid\tevent\tdetail\n";

export function trailIn(directory: string): string {
  return `${directory}/log.tsv`;
}

export function trailPath(env: NodeJS.ProcessEnv = process.env): string {
  return trailIn(plansDir(env));
}

function parseEntry(line: string): TrailEntry {
  return { ...parseTsvRow(TRAIL_COLUMNS, line), line };
}

export function readTrail(path: string): TrailEntry[] {
  return splitTsvLines(readFileSync(path, "utf8"), false, true).slice(1).map(parseEntry);
}

export function readTrailTolerant(path: string): Table<TrailEntry> {
  return readTableTolerant(path, parseEntry);
}

export function logDetail(detail: string): string {
  return cutCodePoints(flatten(detail), 140);
}

function createLog(log: string): void {
  if (existsSync(log)) return;

  const temporary = `${log}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, LOG_HEADER, { flag: "wx" });
    renameSync(temporary, log);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export async function appendLog(project: string, id: string, event: string, detail: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const log = trailPath(env);
  mkdirSync(dirname(log), { recursive: true });

  if (!existsSync(log)) await withLock(join(dirname(log), ".log.tsv.lock"), "log", () => createLog(log));

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const fields = [stamp, project, id, event, logDetail(detail)].map(flatten);
  appendFileSync(log, `${fields.join("\t")}\n`);
}

export function lastEvent(project: string, id: string, env: NodeJS.ProcessEnv = process.env): { event: string; detail: string } | undefined {
  const log = trailPath(env);
  try {
    if (!statSync(log).isFile()) return undefined;
  } catch {
    return undefined;
  }

  const entry = readTrail(log).findLast((entry) => entry.project === project && entry.id === id);
  return entry ? { event: entry.event, detail: entry.detail } : undefined;
}
