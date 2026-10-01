import { closeSync, openSync, opendirSync, readSync, statSync } from "node:fs";

export const earliestMicros = -62135596800000000;

export type RecordObject = { [key: string]: unknown };
export type Notes = string[];

export function object(value: unknown): value is RecordObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function note(notes: Notes, message: string): void {
  if (!notes.includes(message)) notes.push(message);
}

export function pathString(value: string): string {
  const prefix = value.startsWith("//") && !value.startsWith("///") ? "//" : value.startsWith("/") ? "/" : "";
  const components = value.split("/").filter((part) => part !== "" && part !== ".");
  return prefix + components.join("/") || ".";
}

export function childPath(root: string, name: string): string {
  return pathString(root.endsWith("/") ? `${root}${name}` : `${root}/${name}`);
}

export function directoryEntries(root: string): string[] {
  const directory = opendirSync(root);
  const names: string[] = [];
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync())
      names.push(entry.name);
  } finally {
    directory.closeSync();
  }

  return names;
}

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parsedRecord(line: string): RecordObject | null {
  try {
    const record: unknown = JSON.parse(line);
    return object(record) ? record : null;
  } catch {
    return null;
  }
}

export function* recordsFromFile(path: string, notes: Notes): Generator<RecordObject> {
  let descriptor: number | undefined;
  let pieces: string[] = [];
  let afterReturn = false;

  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const buffer = Buffer.alloc(65536);
  const newline = /\r\n|\r|\n/gu;
  try {
    descriptor = openSync(path, "r");
    if (statSync(path).isDirectory()) throw new Error("directory");

    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      const text = decoder.decode(buffer.subarray(0, count), { stream: count !== 0 });

      let start: number = afterReturn && text.startsWith("\n") ? 1 : 0;
      newline.lastIndex = start;
      if (text) afterReturn = false;

      for (let match = newline.exec(text); match !== null; match = newline.exec(text)) {
        pieces.push(text.slice(start, match.index));
        start = match.index + match[0].length;
        afterReturn = match[0] === "\r" && start === text.length;

        const record = parsedRecord(pieces.join(""));
        pieces = [];
        if (record) yield record;
      }

      pieces.push(text.slice(start));

      if (count !== 0) continue;

      const record = parsedRecord(pieces.join(""));
      if (record) yield record;

      break;
    }
  } catch {
    note(notes, `${pathString(path)} is unavailable`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function fractionMicros(value: string | undefined): number {
  return Number((value ?? "").slice(0, 6).padEnd(6, "0"));
}

function clock(value: string): { hour: number; minute: number; second: number; micros: number } | null {
  const match = /^(\d{2})(?::(\d{2})(?::(\d{2})(?:[.,](\d+))?)?|(\d{2})(?:(\d{2})(?:[.,](\d+))?)?)?$/u.exec(value);
  if (!match) return null;

  return {
    hour: Number(match[1]),
    minute: Number(match[2] ?? match[5] ?? 0),
    second: Number(match[3] ?? match[6] ?? 0),
    micros: fractionMicros(match[4] ?? match[7]),
  };
}

function localMicros(value: string): number | null {
  const time = clock(value);
  if (!time || time.hour > 24 || time.minute > 59 || time.second > 59) return null;
  if (time.hour === 24 && (time.minute !== 0 || time.second !== 0 || time.micros !== 0)) return null;

  return (time.hour * 3600 + time.minute * 60 + time.second) * 1e6 + time.micros;
}

function offsetMicros(sign: string, value: string): number | null {
  const time = clock(value);
  if (!time) return null;

  const magnitude = (time.hour * 3600 + time.minute * 60 + time.second) * 1e6 + time.micros;
  if (magnitude >= 86400e6) return null;

  return sign === "-" ? -magnitude : magnitude;
}

export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const text = value.replaceAll("Z", "+00:00");
  const match = /^(\d{4})-(\d{2})-(\d{2})|^(\d{4})(\d{2})(\d{2})/u.exec(text);
  if (!match) return null;

  const year = Number(match[1] ?? match[4]);
  const month = Number(match[2] ?? match[5]);
  const day = Number(match[3] ?? match[6]);

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(0, 0, 0, 0);
  if (year < 1 || month < 1 || month > 12 || day < 1 || date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;

  const remainder = text.slice(match[0].length);
  if (!remainder) return date.getTime() * 1000;

  const separator = [...remainder][0]!;
  const time = remainder.slice(separator.length);
  const offsetIndex = time.search(/[+-]/u);
  const local = localMicros(offsetIndex < 0 ? time : time.slice(0, offsetIndex));
  if (local === null) return null;

  const offset = offsetIndex < 0 ? 0 : offsetMicros(time[offsetIndex]!, time.slice(offsetIndex + 1));
  if (offset === null) return null;

  const timestamp = date.getTime() * 1000 + local - offset;
  if (timestamp < earliestMicros || timestamp >= 253402300800000000) return null;

  return timestamp;
}

function halfEven(value: number): number {
  const lower = Math.floor(value);
  const fraction = value - lower;
  return fraction > 0.5 || (fraction === 0.5 && lower % 2 !== 0) ? lower + 1 : lower;
}

function modifiedMicros(path: string): number {
  const nanoseconds = statSync(path, { bigint: true }).mtimeNs;
  const whole = nanoseconds / 1000000000n;
  const seconds = Number(whole) + Number(nanoseconds % 1000000000n) / 1e9;
  const truncated = Math.trunc(seconds);
  return truncated * 1e6 + halfEven((seconds - truncated) * 1e6);
}

function matches(name: string, pattern: string): boolean {
  if (name.startsWith(".") && !pattern.startsWith(".")) return false;
  const expression = pattern.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join(".*");
  return new RegExp(`^${expression}$`, "u").test(name);
}

export function recentFiles(segments: readonly string[], cutoffMicros: number, notes: Notes): string[] {
  const root = pathString(segments[0]!);
  if (!isDirectory(root)) {
    note(notes, `${root} is unavailable`);
    return [];
  }

  let parents = [root];
  for (const [index, pattern] of segments.slice(1).entries()) {
    const final = index === segments.length - 2;
    const children: string[] = [];
    for (const parent of parents) {
      if (!pattern.includes("*")) {
        const path = childPath(parent, pattern);
        if (final || isDirectory(path)) children.push(path);
        continue;
      }

      let names: string[];
      try {
        names = directoryEntries(parent);
      } catch {
        continue;
      }

      for (const name of names) {
        const path = childPath(parent, name);
        if (matches(name, pattern) && (final || isDirectory(path))) children.push(path);
      }
    }

    parents = children;
  }

  const paths: string[] = [];
  for (const path of parents) {
    try {
      if (modifiedMicros(path) >= cutoffMicros) paths.push(path);
    } catch {
      note(notes, `${path} is unavailable`);
    }
  }

  return paths;
}
