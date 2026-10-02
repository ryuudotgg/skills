export function splitlines(text: string): string[] {
  if (!text) return [];

  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();

  return lines;
}

export function textMode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes).replace(/\r\n?/g, "\n");
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

export function dirname(path: string): string {
  const head = path.slice(0, path.lastIndexOf("/") + 1);
  return /^\/*$/.test(head) ? head : head.replace(/\/+$/, "");
}

export function joinPath(cwd: string, path: string): string {
  return path.startsWith("/") || !cwd ? path : cwd + (cwd.endsWith("/") ? "" : "/") + path;
}

export function splitext(path: string): string {
  const dot = path.lastIndexOf(".");
  const slash = path.lastIndexOf("/");
  if (dot <= slash) return "";

  for (let index = slash + 1; index < dot; index++) if (path[index] !== ".") return path.slice(dot);

  return "";
}

export function codePointOrder(left: string, right: string): number {
  const first = Array.from(left, (char) => char.codePointAt(0)!);
  const second = Array.from(right, (char) => char.codePointAt(0)!);
  for (let index = 0; index < Math.min(first.length, second.length); index++)
    if (first[index] !== second[index]) return first[index]! - second[index]!;

  return first.length - second.length;
}

export function jsonBlock(reason: string): string {
  return `{"decision": "block", "reason": ${JSON.stringify(reason)}}\n`;
}
