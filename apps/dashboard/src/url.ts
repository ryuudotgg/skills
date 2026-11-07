import { instantText, parseTime } from "skills-core";

export type Moment =
  | { kind: "live" }
  | { kind: "cut"; at: number }
  | { kind: "invalid"; text: string };

export function momentOf(search: string): Moment {
  const text = new URLSearchParams(search).get("at");
  if (text === null || text === "") return { kind: "live" };

  const at = parseTime(text);
  return at === undefined ? { kind: "invalid", text } : { kind: "cut", at };
}

export function hrefAt(path: string, moment: Moment): string {
  return moment.kind === "cut" ? `${path}?at=${instantText(moment.at)}` : path;
}

export function tokenOf(hash: string): string | undefined {
  return /^#token=([A-Za-z0-9_-]+)$/.exec(hash)?.[1];
}
