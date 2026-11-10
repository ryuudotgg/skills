import { readFileSync } from "node:fs";
import { join } from "node:path";

export const IGNORE_FILE = ".plansignore";

export const FILE_PLAN = "-";

const DEFAULT_IGNORES = [
  "plans.db",
  "plans.db-*",
  "*.lock",
  ".revisions-spool/",
  ".resume-*",
  ".DS_Store",
  "_archive/",
] as const;

type Rule = { readonly negate: boolean; readonly dirOnly: boolean; readonly regex: RegExp };

type Scope = { readonly base: string; readonly rules: readonly Rule[] };

export type Ignore = { readonly ignores: (path: string, dir: boolean) => boolean };

function escaped(character: string): string {
  return /[\\^$.|?*+()[\]{}]/.test(character) ? `\\${character}` : character;
}

const POSIX: Readonly<Record<string, string>> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  blank: " \\t",
  cntrl: "\\x00-\\x1f\\x7f",
  digit: "0-9",
  graph: "!-~",
  lower: "a-z",
  print: " -~",
  punct: "!-\\/:-@\\[-`{-~",
  space: " \\t\\n\\r\\f\\v",
  upper: "A-Z",
  xdigit: "0-9a-fA-F",
};

function classOf(pattern: string, start: number): { source: string; end: number } | undefined {
  let at = start + 1;
  let negate = false;
  if (pattern[at] === "!" || pattern[at] === "^") {
    negate = true;
    at += 1;
  }

  let body = "";
  if (pattern[at] === "]") {
    body += "\\]";
    at += 1;
  }

  for (; at < pattern.length && pattern[at] !== "]"; at += 1) {
    const close = pattern.startsWith("[:", at) ? pattern.indexOf(":]", at + 2) : -1;
    const named = close === -1 ? undefined : POSIX[pattern.slice(at + 2, close)];
    if (close !== -1 && named === undefined) throw new SyntaxError("unknown character class");
    if (named !== undefined) {
      body += named;
      at = close + 1;
      continue;
    }

    const character = pattern[at] as string;
    body += character === "\\" || character === "^" ? `\\${character}` : character;
  }

  if (at >= pattern.length) return undefined;
  return { source: `[${negate ? "^" : ""}${body}]`, end: at };
}

function sourceOf(pattern: string): string {
  let source = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const character = pattern[at] as string;
    if (character === "\\" && at + 1 < pattern.length) {
      source += escaped(pattern[at + 1] as string);
      at += 1;
    } else if (pattern.startsWith("**/", at) && (at === 0 || pattern[at - 1] === "/")) {
      source += "(?:.*/)?";
      at += 2;
    } else if (
      pattern.startsWith("**", at) &&
      at + 2 === pattern.length &&
      pattern[at - 1] === "/"
    ) {
      source += ".*";
      at += 1;
    } else if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else if (character === "[") {
      const found = classOf(pattern, at);
      if (found === undefined) source += "\\[";
      else {
        source += found.source;
        at = found.end;
      }
    } else source += escaped(character);
  }

  return source;
}

function trimmed(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === " " && line[end - 2] !== "\\") end -= 1;
  return line.slice(0, end);
}

function compileRule(line: string): Rule | undefined {
  let pattern = trimmed(line.replace(/\r$/, ""));
  if (pattern === "" || pattern.startsWith("#")) return undefined;

  const negate = pattern.startsWith("!");
  if (negate) pattern = pattern.slice(1);
  else if (pattern.startsWith("\\!") || pattern.startsWith("\\#")) pattern = pattern.slice(1);

  const dirOnly = pattern.endsWith("/") && !pattern.endsWith("\\/");
  if (dirOnly) pattern = pattern.slice(0, -1);
  if (pattern === "") return undefined;

  const anchored = pattern.includes("/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);

  try {
    const regex = new RegExp(`^${anchored ? "" : "(?:.*/)?"}${sourceOf(pattern)}$`);
    return { negate, dirOnly, regex };
  } catch {
    return undefined;
  }
}

function rulesOf(lines: readonly string[]): Rule[] {
  return lines.flatMap((line) => compileRule(line) ?? []);
}

function readRules(path: string): Rule[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  return rulesOf(text.split("\n"));
}

function matches(scopes: readonly Scope[], path: string, dir: boolean): boolean {
  let ignored = false;
  for (const scope of scopes) {
    if (scope.base !== "" && !path.startsWith(`${scope.base}/`)) continue;

    const relative = scope.base === "" ? path : path.slice(scope.base.length + 1);
    for (const rule of scope.rules)
      if ((dir || !rule.dirOnly) && rule.regex.test(relative)) ignored = !rule.negate;
  }

  return ignored;
}

export function projectIgnore(root: string, project: string): Ignore {
  const scopes: Scope[] = [
    { base: "", rules: rulesOf(DEFAULT_IGNORES) },
    { base: "", rules: readRules(join(root, IGNORE_FILE)) },
    { base: project, rules: readRules(join(root, project, IGNORE_FILE)) },
  ];

  return { ignores: (path, dir) => matches(scopes, path, dir) };
}
