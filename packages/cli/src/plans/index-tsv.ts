import {
  closeSync,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join } from "node:path";
import { COLUMNS, flatten, type IndexRow } from "skills-core";
import { LOCK_WAIT, withLock } from "../lock.ts";
import { plansDir } from "./paths.ts";
import { stagingName } from "./staging.ts";

export { plansDir } from "./paths.ts";

export const NOTE_CAP = 100;
export const STEP_BOUND = 60_000;
export const SCRATCH_WAIT = STEP_BOUND + LOCK_WAIT;

export function projectDir(project: string, env: NodeJS.ProcessEnv = process.env): string {
  if (project === "." || project === ".." || /[/\\]/.test(project))
    throw new Error(`invalid project: ${project}`);

  return `${plansDir(env)}/${project}`;
}

export function scratchRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.PLANS_SCRATCH || "/tmp";
}

export function scratchLock(env: NodeJS.ProcessEnv = process.env): string {
  return join(plansDir(env), ".scratch.lock");
}

export function withScratchLock<T>(env: NodeJS.ProcessEnv, run: () => T | Promise<T>): Promise<T> {
  const path = scratchLock(env);
  return withLock(path, "scratch", run, SCRATCH_WAIT);
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

export function readIfPresent(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}

export function parseTableText<Row>(text: string, parse: (line: string) => Row): Row[] {
  return text
    .split(/\r\n|\r|\n/)
    .filter((line) => line !== "")
    .slice(1)
    .map(parse);
}

export function parseIndexText(text: string): IndexRow[] {
  return parseTableText(text, parseRow);
}

export function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeDurably(
  path: string,
  text: string | Uint8Array,
  mode: number,
  exact: boolean,
): Stats {
  const descriptor = openSync(path, "wx", mode);
  try {
    if (exact) fchmodSync(descriptor, mode);
    writeFileSync(descriptor, text);
    fsyncSync(descriptor);
    return fstatSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export type Staging = { readonly check?: () => void; readonly mode?: number };

export function createDurably(
  path: string,
  text: string | Uint8Array,
  { check, mode }: Staging = {},
): Stats {
  const temporary = stagingName(path);

  let staged: Stats;
  try {
    staged = writeDurably(temporary, text, mode ?? 0o644, mode !== undefined);
    check?.();
    linkSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }

  syncDirectory(dirname(path));
  return staged;
}

export function replaceDurably(
  path: string,
  text: string | Uint8Array,
  { check, mode }: Staging = {},
): Stats {
  const temporary = stagingName(path);
  const exact = mode ?? (existsSync(path) ? statSync(path).mode & 0o777 : undefined);
  try {
    const staged = writeDurably(temporary, text, exact ?? 0o644, exact !== undefined);
    check?.();
    renameSync(temporary, path);
    syncDirectory(dirname(path));
    return staged;
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
