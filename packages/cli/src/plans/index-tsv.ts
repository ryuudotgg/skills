import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { COLUMNS, flatten, type IndexRow } from "skills-core";
import { plansDir } from "./paths.ts";

export { plansDir } from "./paths.ts";

export type Table<Row> = { kind: "absent" } | { kind: "failed" } | { kind: "rows"; rows: Row[] };

export const NOTE_CAP = 100;

export function projectDir(project: string, env: NodeJS.ProcessEnv = process.env): string {
  if (project === "." || project === ".." || /[/\\]/.test(project))
    throw new Error(`invalid project: ${project}`);

  return `${plansDir(env)}/${project}`;
}

export function scratchLock(env: NodeJS.ProcessEnv = process.env): string {
  return join(plansDir(env), ".scratch.lock");
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
    return { kind: "rows", rows: parseTableText(decodeUtf8(readFileSync(path)), parse) };
  } catch {
    return { kind: "failed" };
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function parseTableText<Row>(text: string, parse: (line: string) => Row): Row[] {
  return splitTsvLines(text, true).slice(1).map(parse);
}

export function parseIndexText(text: string): IndexRow[] {
  return parseTableText(text, parseRow);
}

export function readIndexTolerant(path: string): Table<IndexRow> {
  return readTableTolerant(path, parseRow);
}

export function readIndex(path: string, includeHeader = false): IndexRow[] {
  const lines = splitTsvLines(readFileSync(path, "utf8"));
  return lines.slice(includeHeader ? 0 : 1).map(parseRow);
}

export function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurably(path: string, text: string | Uint8Array, mode: number): void {
  const descriptor = openSync(path, "wx", mode);
  try {
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function createDurably(path: string, text: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeDurably(temporary, text, 0o644);
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  syncDirectory(dirname(path));
}

export function replaceDurably(path: string, text: string | Uint8Array): void {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeDurably(temporary, text, existsSync(path) ? statSync(path).mode & 0o777 : 0o644);
    renameSync(temporary, path);
    syncDirectory(dirname(path));
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
