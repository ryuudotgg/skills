import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { withLock } from "../lock.ts";

export const COLUMNS = [
  "id",
  "slug",
  "status",
  "pri",
  "effort",
  "blocked_by",
  "ctx",
  "branch",
  "updated",
  "note",
] as const;

export const STATUSES = ["TODO", "DOING", "DONE", "DROPPED", "BLOCKED", "REVIEW"] as const;

export type Status = (typeof STATUSES)[number];
export type IndexRow = Record<(typeof COLUMNS)[number], string>;
export type Table<Row> = { kind: "absent" } | { kind: "failed" } | { kind: "rows"; rows: Row[] };

export const NOTE_CAP = 100;

export function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;
}

export function projectDir(project: string, env: NodeJS.ProcessEnv = process.env): string {
  if (project === "." || project === ".." || /[/\\]/.test(project))
    throw new Error(`invalid project: ${project}`);

  return `${plansDir(env)}/${project}`;
}

export function indexPath(project: string, env: NodeJS.ProcessEnv = process.env): string {
  return indexIn(projectDir(project, env));
}

export function indexIn(directory: string): string {
  return `${directory}/index.tsv`;
}

export function missingIndex(project: string): string {
  return `no index.tsv for ${project}`;
}

export function flatten(value: string): string {
  return value.replace(/[\t\r\n]/g, " ");
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function cleanNote(note: string): string {
  return cutCodePoints(flatten(note), NOTE_CAP);
}

export function cutCodePoints(value: string, cap: number): string {
  return Array.from(value).slice(0, cap).join("");
}

export function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function parseTsvRow<Column extends string>(
  columns: readonly Column[],
  line: string,
): Record<Column, string> {
  const fields = line.split("\t");
  return Object.fromEntries(
    columns.map((column, index) => [column, fields[index] ?? ""]),
  ) as Record<Column, string>;
}

function parseRow(line: string): IndexRow {
  return parseTsvRow(COLUMNS, line);
}

export function splitTsvLines(text: string, tolerant = false, keepTrailing = false): string[] {
  if (tolerant) return text.split(/\r\n|\r|\n/).filter((line) => line !== "");

  const lines = text.split("\n");
  if (!keepTrailing && lines.at(-1) === "") lines.pop();

  return lines;
}

export function readTableTolerant<Row>(path: string, parse: (line: string) => Row): Table<Row> {
  try {
    if (!statSync(path).isFile()) return { kind: "absent" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { kind: code === "ENOENT" || code === "ENOTDIR" ? "absent" : "failed" };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      readFileSync(path),
    );

    return { kind: "rows", rows: splitTsvLines(text, true).slice(1).map(parse) };
  } catch {
    return { kind: "failed" };
  }
}

export function readIndexTolerant(path: string): Table<IndexRow> {
  return readTableTolerant(path, parseRow);
}

export function formatRow(row: IndexRow): string {
  return COLUMNS.map((column) => flatten(row[column])).join("\t");
}

export function readIndex(path: string, includeHeader = false): IndexRow[] {
  const lines = splitTsvLines(readFileSync(path, "utf8"));
  return lines.slice(includeHeader ? 0 : 1).map(parseRow);
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurably(path: string, text: string, mode: number): void {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export async function updateIndex<T>(
  path: string,
  edit: (rows: IndexRow[]) => T,
  committed?: (result: T) => void | Promise<void>,
): Promise<T> {
  return withLock(join(dirname(path), `.${basename(path)}.lock`), "index", async () => {
    const lines = splitTsvLines(readFileSync(path, "utf8"));

    const [header = "", ...raw] = lines;
    const rows = raw.map(parseRow);
    const original = new Map(
      rows.map((row, index) => [row, { line: raw[index] ?? "", fields: formatRow(row) }]),
    );

    const result = edit(rows);

    const text = [
      header,
      ...rows.map((row) => {
        const before = original.get(row);
        return before && before.fields === formatRow(row) ? before.line : formatRow(row);
      }),
    ]
      .map((line) => `${line}\n`)
      .join("");

    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeDurably(temporary, text, statSync(path).mode & 0o777);
      renameSync(temporary, path);
      syncDirectory(dirname(path));
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }

    await committed?.(result);
    return result;
  });
}
