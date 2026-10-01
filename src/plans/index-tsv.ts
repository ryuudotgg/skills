import { closeSync, fsyncSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { dlopen, FFIType } from "bun:ffi";

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

export const NOTE_CAP = 100;
const LOCK_WAIT = 10_000;
const LOCK_EX = 2;
const LOCK_NB = 4;

export function plansDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_DIR || `${env.HOME ?? ""}/Plans`;
}

export function projectDir(project: string, env: NodeJS.ProcessEnv = process.env): string {
  if (project === "." || project === ".." || /[/\\]/.test(project)) throw new Error(`invalid project: ${project}`);
  return `${plansDir(env)}/${project}`;
}

export function indexPath(project: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${projectDir(project, env)}/index.tsv`;
}

export function flatten(value: string): string {
  return value.replace(/[\t\r\n]/g, " ");
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function cleanNote(note: string): string {
  return flatten(note).slice(0, NOTE_CAP);
}

export function today(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function parseRow(line: string): IndexRow {
  const fields = line.split("\t");
  return Object.fromEntries(COLUMNS.map((column, index) => [column, fields[index] ?? ""])) as IndexRow;
}

export function formatRow(row: IndexRow): string {
  return COLUMNS.map((column) => flatten(row[column])).join("\t");
}

export function readIndex(path: string, includeHeader = false): IndexRow[] {
  const lines = readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(includeHeader ? 0 : 1).map(parseRow);
}

let libc: { flock(descriptor: number, operation: number): number } | undefined;

function flock(descriptor: number, operation: number): boolean {
  libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
    flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
  }).symbols;

  return libc.flock(descriptor, operation) === 0;
}

async function acquire(lock: string): Promise<number> {
  const descriptor = openSync(lock, "a");
  const deadline = Date.now() + LOCK_WAIT;
  while (!flock(descriptor, LOCK_EX | LOCK_NB)) {
    if (Date.now() > deadline) {
      closeSync(descriptor);
      throw new Error(`index stayed locked for ${LOCK_WAIT / 1000} s: ${lock}`);
    }

    await Bun.sleep(5 + Math.random() * 15);
  }

  return descriptor;
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

export async function updateIndex<T>(path: string, edit: (rows: IndexRow[]) => T): Promise<T> {
  const descriptor = await acquire(join(dirname(path), `.${basename(path)}.lock`));
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines.at(-1) === "") lines.pop();

    const [header = "", ...raw] = lines;
    const rows = raw.map(parseRow);
    const original = new Map(rows.map((row, index) => [row, { line: raw[index] ?? "", fields: formatRow(row) }]));
    const result = edit(rows);

    const text = [header, ...rows.map((row) => {
      const before = original.get(row);
      return before && before.fields === formatRow(row) ? before.line : formatRow(row);
    })].map((line) => `${line}\n`).join("");

    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeDurably(temporary, text, statSync(path).mode & 0o777);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }

    return result;
  } finally {
    closeSync(descriptor);
  }
}
