import { compareEvents } from "./clock.ts";
import { eventFrom, type EventRecord, type PlanEvent } from "./events.ts";

export type FeedEvent = EventRecord & { id: string };

export type Scene = { events: PlanEvent[]; now: number };

export function feedLines(events: readonly FeedEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}

function isFeedEvent(value: unknown): value is FeedEvent {
  if (typeof value !== "object" || value === null) return false;

  const line = value as Record<string, unknown>;
  const strings = ["id", "machine", "ts", "project", "plan", "type"].every(
    (key) => typeof line[key] === "string",
  );

  return (
    strings &&
    Number.isInteger(line.wall) &&
    Number.isInteger(line.counter) &&
    typeof line.legacy === "boolean" &&
    "payload" in line
  );
}

export function parseFeed(text: string): FeedEvent[] {
  const events: FeedEvent[] = [];
  for (const [index, line] of text.split("\n").entries()) {
    if (line === "") continue;

    const value: unknown = JSON.parse(line);
    if (!isFeedEvent(value)) throw new Error(`feed line ${index + 1} is not an event`);

    try {
      eventFrom(value);
    } catch (error) {
      throw new Error(`feed line ${index + 1}: ${error instanceof Error ? error.message : error}`);
    }

    events.push(value);
  }

  return events;
}

function compareFeed(left: FeedEvent, right: FeedEvent): number {
  const order = compareEvents(left, right);
  if (order !== 0) return order;
  if (left.id === right.id) return 0;

  return left.id < right.id ? -1 : 1;
}

export function mergeFeed(
  held: readonly FeedEvent[],
  fresh: readonly FeedEvent[],
): readonly FeedEvent[] {
  const known = new Set(held.map((event) => event.id));
  const added = fresh.filter((event) => !known.has(event.id) && known.add(event.id));
  if (added.length === 0) return held;

  return [...held, ...added].sort(compareFeed);
}

export function sceneAt(events: readonly FeedEvent[], at: number | undefined, wall: number): Scene {
  const kept = at === undefined ? events : events.filter((event) => event.wall <= at);
  return { events: kept.map(eventFrom), now: at ?? wall };
}
