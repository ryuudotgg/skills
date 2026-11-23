import {
  eventFrom,
  recordOf,
  type EventDraft,
  type PlanEvent,
  type RowEvent,
  type StoredEvent,
  type TrailEvent,
} from "skills-core";

export type Stamp = { wall: number; id?: string; machine?: string; counter?: number };

export type Place = Stamp & { ts: string; project: string; plan: string };

type Placement = Exclude<keyof RowEvent, "kind" | "type" | "row">;

export type Body =
  | Omit<RowEvent, Placement>
  | Omit<TrailEvent, Placement>
  | Omit<StoredEvent, Placement | "id">;

export function stamped(
  draft: EventDraft,
  { wall, id = `e${wall}`, machine = "m", counter = 0 }: Stamp,
): PlanEvent {
  return eventFrom({ ...recordOf(draft), id, wall, machine, counter });
}

export function placed(
  body: Body,
  { wall, id = `e${wall}`, machine = "m", counter = 0, ...place }: Place,
): PlanEvent {
  const stamp = { ...place, wall, machine, counter };
  return body.kind === "stored" ? { ...body, ...stamp, id } : { ...body, ...stamp };
}

export function sequence(): () => number {
  let next = 0;
  return () => next++;
}
