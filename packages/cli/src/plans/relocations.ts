import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { foldsCase } from "../io.ts";
import { asciiLower } from "../project.ts";
import { replaceDurably } from "./index-tsv.ts";

export const RELOCATIONS = "relocations.tsv";

export type Relocation = {
  readonly source: string;
  readonly target: string;
  readonly at: number | null;
};

export type Place = { readonly row: Relocation; readonly place: string };

export type RelocationRecord = {
  placesOf(directory: string): readonly Place[];
  formerPathsOf(checkout: string): readonly string[];
};

function recordPath(plans: string): string {
  return join(plans, RELOCATIONS);
}

function parsedRow(line: string): Relocation | undefined {
  const fields = line.split("\t");
  if (fields.length !== 3) return undefined;

  const [source = "", target = "", at = ""] = fields;
  if (!source.startsWith("/") || !target.startsWith("/")) return undefined;
  if (at === "") return { source, target, at: null };

  return /^\d+$/u.test(at) ? { source, target, at: Number(at) } : undefined;
}

export function readRelocations(plans: string): Relocation[] {
  let text: string;
  try {
    text = readFileSync(recordPath(plans), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return text.split("\n").flatMap((line) => parsedRow(line) ?? []);
}

function writeRelocations(plans: string, rows: readonly Relocation[]): void {
  const unique = new Map<string, Relocation>();
  for (const row of rows)
    if (row.source !== row.target) unique.set(`${row.source}\t${row.target}`, row);

  const text = [...unique.values()]
    .map((row) => `${row.source}\t${row.target}\t${row.at ?? ""}\n`)
    .join("");

  replaceDurably(recordPath(plans), text);
}

function inside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`);
}

function placeUnder(path: string, source: string, target: string): string {
  return target + path.slice(source.length);
}

export function writePending(plans: string, sources: readonly string[], target: string): void {
  const moving = new Set(sources);
  const kept = readRelocations(plans).filter(
    (row) => row.target !== target || !moving.has(row.source),
  );

  writeRelocations(plans, [
    ...kept,
    ...[...moving].map((source) => ({ source, target, at: null })),
  ]);
}

export function settleRelocation(plans: string, target: string, at: number): void {
  const known = readRelocations(plans);
  const sources = known.flatMap((row) =>
    row.at === null && row.target === target ? row.source : [],
  );

  const rows = known.map((row) => {
    if (row.target === target) return { ...row, at: row.at ?? at };
    const moved = sources.find((source) => inside(row.target, source));
    return moved === undefined ? row : { ...row, target: placeUnder(row.target, moved, target) };
  });

  const nested = known.flatMap((row) =>
    row.at === null || row.target === target
      ? []
      : sources
          .filter((source) => source !== row.target && inside(source, row.target))
          .map((source) => ({ source: placeUnder(source, row.target, row.source), target, at })),
  );

  writeRelocations(plans, [...rows, ...nested]);
}

export function dropPending(plans: string, target: string): void {
  const kept = readRelocations(plans).filter((row) => row.at !== null || row.target !== target);
  writeRelocations(plans, kept);
}

type Settled = { readonly row: Relocation; readonly spelled: (path: string) => string };

const asWritten = (path: string): string => path;

export function relocationRecord(plans: string): RelocationRecord {
  let settled: Settled[] | undefined;
  const settledRows = (): Settled[] =>
    (settled ??= readRelocations(plans)
      .filter((row) => row.at !== null)
      .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
      .map((row) => ({ row, spelled: foldsCase(row.target) ? asciiLower : asWritten })));

  return {
    placesOf(directory) {
      return settledRows()
        .filter(
          ({ row, spelled }) =>
            inside(spelled(directory), spelled(row.source)) && existsSync(row.target),
        )
        .map(({ row }) => ({ row, place: placeUnder(directory, row.source, row.target) }));
    },

    formerPathsOf(checkout) {
      return settledRows().flatMap(({ row, spelled }) =>
        spelled(row.target) === spelled(checkout) ? row.source : [],
      );
    },
  };
}
