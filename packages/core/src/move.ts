import type { PlanEvent } from "./events.ts";

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

function fields(payload: unknown): Record<string, unknown> {
  return typeof payload === "object" && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : {};
}

function text(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function nullable(value: unknown): value is string | null {
  return value === null || text(value);
}

export function movedFrom(payload: unknown): Moved | undefined {
  const { sha256, size, source, to, toDevice, head, base, blobs } = fields(payload);
  if (!text(sha256) || !text(source) || !text(head) || !text(base)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  if (!nullable(to) || !nullable(toDevice)) return undefined;
  if (!Array.isArray(blobs) || !blobs.every(text)) return undefined;

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
