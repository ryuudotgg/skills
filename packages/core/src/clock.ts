export type Clock = { wall: number; counter: number };

export type Stamp = Clock & { machine: string };

export function tick(last: Clock, physical: number): Clock {
  return Number.isFinite(physical) && physical > last.wall
    ? { wall: physical, counter: 0 }
    : { wall: last.wall, counter: last.counter + 1 };
}

export function compareEvents(left: Stamp, right: Stamp): number {
  if (left.wall !== right.wall) return left.wall < right.wall ? -1 : 1;
  if (left.counter !== right.counter) return left.counter < right.counter ? -1 : 1;
  if (left.machine === right.machine) return 0;

  return left.machine < right.machine ? -1 : 1;
}

export function secondStamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString().replace(/\.\d{3}Z$/, "Z");
}
