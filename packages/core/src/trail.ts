import { flatten } from "./rows.ts";

export const AD_HOC_ID = "-";

export const TRAIL_COLUMNS = ["ts", "project", "id", "event", "detail"] as const;

export type TrailFields = Record<(typeof TRAIL_COLUMNS)[number], string>;
export type TrailEntry = TrailFields & { line: string };

export const LOG_HEADER = `${TRAIL_COLUMNS.join("\t")}\n`;

export const bookkeepingEvents = ["thread", "nudge", "conflict-sent"] as const;

export function trailEntry(fields: TrailFields): TrailEntry {
  const [ts = "", project = "", id = "", event = "", detail = ""] = TRAIL_COLUMNS.map((column) =>
    flatten(fields[column]),
  );

  return { ts, project, id, event, detail, line: [ts, project, id, event, detail].join("\t") };
}

export function renderTrail(trail: readonly TrailEntry[]): string {
  return LOG_HEADER + trail.map((entry) => `${entry.line}\n`).join("");
}

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

function applyEntry(history: History, entry: Pick<TrailEntry, "event" | "ts" | "detail">): void {
  if (entry.event === "thread") history.thread = entry.detail;
  if (entry.event === "conflict-sent") history.sent.add(entry.detail);
  if (entry.event === "start") history.start = Date.parse(entry.ts);

  const live = OPENS_THREAD[entry.event];
  if (live !== undefined) history.live = live;
}

export function historyOf(trail: Iterable<Pick<TrailEntry, "event" | "ts" | "detail">>): History {
  const history = emptyHistory();
  for (const entry of trail) applyEntry(history, entry);
  return history;
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
