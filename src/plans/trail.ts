import {
  cutCodePoints,
  flatten,
  parseTableText,
  parseTsvRow,
  readTableTolerant,
  type Table,
} from "./index-tsv.ts";

export const AD_HOC_ID = "-";

export const TRAIL_COLUMNS = ["ts", "project", "id", "event", "detail"] as const;
export type TrailEntry = Record<(typeof TRAIL_COLUMNS)[number], string> & { line: string };

export const LOG_HEADER = "ts\tproject\tid\tevent\tdetail\n";

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

export const bookkeepingEvents = ["thread", "nudge", "conflict-sent"] as const;

export function lastEvent(
  trail: readonly TrailEntry[],
  project: string,
  id: string,
  ignored: readonly string[] = [],
): { event: string; detail: string } | undefined {
  const entry = trail.findLast(
    (entry) => entry.project === project && entry.id === id && !ignored.includes(entry.event),
  );

  return entry ? { event: entry.event, detail: entry.detail } : undefined;
}

export type History = {
  start: number | undefined;
  live: boolean;
  thread: string | undefined;
  sent: Set<string>;
};

export type Histories = Map<string, History>;

const OPENS_THREAD: Record<string, boolean> = {
  start: true,
  review: true,
  handback: false,
  done: false,
};

export function historyKey(project: string, id: string): string {
  return `${project}\t${id}`;
}

export function emptyHistory(): History {
  return { start: undefined, live: false, thread: undefined, sent: new Set() };
}

export function applyEntry(
  history: History,
  entry: Pick<TrailEntry, "event" | "ts" | "detail">,
): void {
  if (entry.event === "thread") history.thread = entry.detail;
  if (entry.event === "conflict-sent") history.sent.add(entry.detail);
  if (entry.event === "start") history.start = Date.parse(entry.ts);

  const live = OPENS_THREAD[entry.event];
  if (live !== undefined) history.live = live;
}

export function historiesOf(trail: readonly TrailEntry[]): Histories {
  const histories: Histories = new Map();
  for (const entry of trail) {
    if (entry.id === AD_HOC_ID) continue;

    const key = historyKey(entry.project, entry.id);
    const history = histories.get(key) ?? emptyHistory();

    histories.set(key, history);
    applyEntry(history, entry);
  }

  return histories;
}
