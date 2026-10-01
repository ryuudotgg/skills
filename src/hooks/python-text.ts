export const PY_SPACE =
  "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

const LEADING_SPACE = new RegExp(`^[${PY_SPACE}]+`, "u");
const TRAILING_SPACE = new RegExp(`[${PY_SPACE}]+$`, "u");
const ONLY_SPACE = new RegExp(`^[${PY_SPACE}]+$`, "u");

export function pyLstrip(text: string): string {
  return text.replace(LEADING_SPACE, "");
}

export function pyRstrip(text: string): string {
  return text.replace(TRAILING_SPACE, "");
}

export function pyStrip(text: string): string {
  return pyRstrip(pyLstrip(text));
}

export function pyIsSpace(text: string): boolean {
  return ONLY_SPACE.test(text);
}

export function splitlines(text: string): string[] {
  if (!text) return [];

  const lines = text.split(new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c-\\x1e\\x85\\u2028\\u2029]", "u"));
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
  const escaped = JSON.stringify(reason).replace(
    /[\x7f-\uffff]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

  return `{"decision": "block", "reason": ${escaped}}\n`;
}
