import { flatten, TRAIL_COLUMNS, type TrailEntry } from "skills-core";
import {
  cutCodePoints,
  parseTableText,
  parseTsvRow,
  readTableTolerant,
  type Table,
} from "./index-tsv.ts";

export function trailIn(directory: string): string {
  return `${directory}/log.tsv`;
}

function parseEntry(line: string): TrailEntry {
  return { ...parseTsvRow(TRAIL_COLUMNS, line), line };
}

export function readTrailTolerant(path: string): Table<TrailEntry> {
  return readTableTolerant(path, parseEntry);
}

export function parseTrailText(text: string): TrailEntry[] {
  return parseTableText(text, parseEntry);
}

export function logDetail(detail: string): string {
  return cutCodePoints(flatten(detail), 140);
}
