import type { PlanEvent } from "./events.ts";
import { fields, isText } from "./payload.ts";

export const MOVED = "moved";

export const ADOPTED = "adopted";

export const MOVE_ENDERS = ["start", ADOPTED] as const;

export type Moved = {
  sha256: string;
  size: number;
  source: string;
  to: string | null;
  toDevice: string | null;
  head: string;
  base: string;
  blobs: string[];
};

export type Adopted = {
  sha256: string;
  checkout: string;
  branch: string;
};

function nullable(value: unknown): value is string | null {
  return value === null || isText(value);
}

export function movedFrom(payload: unknown): Moved | undefined {
  const { sha256, size, source, to, toDevice, head, base, blobs } = fields(payload) ?? {};
  if (!isText(sha256) || !isText(source) || !isText(head) || !isText(base)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (!nullable(to) || !nullable(toDevice)) return undefined;
  if (!Array.isArray(blobs) || !blobs.every(isText)) return undefined;

  return { sha256, size, source, to, toDevice, head, base, blobs };
}

export function movesIn(events: Iterable<PlanEvent>): Map<string, Moved> {
  const moving = new Map<string, Moved>();
  for (const event of events)
    if (event.type === MOVED && event.kind === "stored") {
      const moved = movedFrom(event.payload);
      if (moved !== undefined) moving.set(event.plan, moved);
    } else if ((MOVE_ENDERS as readonly string[]).includes(event.type)) moving.delete(event.plan);

  return moving;
}

export function movingTo(moved: Moved): string {
  return moved.to ?? "any";
}

export function movingMark(moved: Moved): string {
  return `(moving to ${movingTo(moved)})`;
}

export function moveRefusal(
  id: string,
  moved: Moved,
  self: string | undefined,
): string | undefined {
  if (moved.toDevice === null || moved.toDevice === self) return undefined;
  return `${id} is moving to ${movingTo(moved)}`;
}
