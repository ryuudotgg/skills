import { basename, isAbsolute, join, relative, sep } from "node:path";
import type { EventRecord } from "skills-core";

export const PLAN_FILE = /^\d{3}-.*\.md$/;
export const CTX_FILE = /^ctx-.*\.md$/;

export const EVENT_COLUMNS = "id, machine, wall, counter, ts, project, plan, type, legacy, payload";

export const NEWEST_FIRST = "wall DESC, counter DESC, machine DESC, id DESC";

export type EventRow = Omit<EventRecord, "legacy" | "payload"> & {
  id: string;
  legacy: number;
  payload: string;
};

export function eventRecord<Row extends EventRow>(
  row: Row,
): Omit<Row, "legacy" | "payload"> & EventRecord {
  return { ...row, legacy: row.legacy === 1, payload: JSON.parse(row.payload) };
}

export function isCopyKey(stored: string): boolean {
  const parts = stored.split(sep);
  const [project = "", folder = "", name = ""] = parts;
  if (!project || project.startsWith(".") || isAbsolute(stored)) return false;
  if (parts.length === 2) return PLAN_FILE.test(folder) || CTX_FILE.test(folder);

  return parts.length === 3 && folder === "done" && PLAN_FILE.test(name);
}

export function workingCopyKey(root: string, path: string): string | undefined {
  const stored = relative(root, path);
  return isCopyKey(stored) ? stored : undefined;
}

export function planOfCopy(path: string): string {
  const name = basename(path, ".md");
  return CTX_FILE.test(basename(path)) ? name : name.slice(0, 3);
}

export function counterparts(path: string): string[] {
  const parts = path.split(sep);
  if (parts.length === 3 && parts[1] === "done") return [path, join(parts[0]!, parts[2]!)];
  if (parts.length === 2) return [path, join(parts[0]!, "done", parts[1]!)];
  return [path];
}
