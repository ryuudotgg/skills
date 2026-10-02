import { basename, splitext } from "./text.ts";
import { SequenceMatcher } from "./sequence-matcher.ts";

export type Spec = {
  markers: readonly string[];
  blocks: readonly (readonly [string, string])[];
  fences: readonly string[];
  exclude: readonly string[];
};

export type CommentLine = [number, string];

export const C: Spec = { markers: ["//"], blocks: [["/*", "*/"]], fences: ["`"], exclude: [] };

export const JSX: Spec = {
  markers: ["//"],
  blocks: [
    ["/*", "*/"],
    ["{/*", "*/}"],
  ],
  fences: ["`"],
  exclude: [],
};

export const HASH: Spec = { markers: ["#"], blocks: [], fences: ['"""', "'''"], exclude: [] };

export const SHELL: Spec = { markers: ["#"], blocks: [], fences: [], exclude: [] };

export const SQL: Spec = { markers: ["--"], blocks: [["/*", "*/"]], fences: [], exclude: [] };

export const LUA: Spec = { markers: ["--"], blocks: [["--[[", "]]"]], fences: [], exclude: [] };

export const HASKELL: Spec = { markers: ["--"], blocks: [["{-", "-}"]], fences: [], exclude: [] };

export const HTML: Spec = { markers: [], blocks: [["<!--", "-->"]], fences: [], exclude: [] };

export const SFC: Spec = {
  markers: ["//"],
  blocks: [
    ["/*", "*/"],
    ["<!--", "-->"],
  ],
  fences: ["`"],
  exclude: [],
};

export const CSS: Spec = { markers: [], blocks: [["/*", "*/"]], fences: [], exclude: [] };

export const SCSS: Spec = { markers: ["//"], blocks: [["/*", "*/"]], fences: [], exclude: [] };

export const PHP: Spec = {
  markers: ["//", "#"],
  blocks: [["/*", "*/"]],
  fences: [],
  exclude: ["#["],
};

export const BY_EXT: Record<string, Spec> = {
  ".js": C,
  ".mjs": C,
  ".cjs": C,
  ".ts": C,
  ".mts": C,
  ".cts": C,
  ".jsx": JSX,
  ".tsx": JSX,
  ".go": C,
  ".rs": C,
  ".java": C,
  ".kt": C,
  ".swift": C,
  ".scala": C,
  ".dart": C,
  ".c": C,
  ".h": C,
  ".cpp": C,
  ".cc": C,
  ".hpp": C,
  ".cs": C,
  ".php": PHP,
  ".py": HASH,
  ".sh": SHELL,
  ".bash": SHELL,
  ".zsh": SHELL,
  ".rb": HASH,
  ".yaml": HASH,
  ".yml": HASH,
  ".toml": HASH,
  ".pl": HASH,
  ".r": HASH,
  ".ex": HASH,
  ".exs": HASH,
  ".nix": HASH,
  ".tf": HASH,
  ".sql": SQL,
  ".lua": LUA,
  ".hs": HASKELL,
  ".html": HTML,
  ".htm": HTML,
  ".xml": HTML,
  ".svg": HTML,
  ".vue": SFC,
  ".svelte": SFC,
  ".astro": SFC,
  ".css": CSS,
  ".scss": SCSS,
  ".less": SCSS,
};

export const BY_NAME: Record<string, Spec> = {
  Dockerfile: SHELL,
  Makefile: SHELL,
  Justfile: SHELL,
};

const WORD = "[\\p{L}\\p{N}_]";
const SPACE = `\\s`;
const BOUNDARY = `(?:(?<=${WORD})(?!${WORD})|(?<!${WORD})(?=${WORD}))`;

const PRAGMA = new RegExp(
  "^(?:#!|#" +
    SPACE +
    "*-\\*-|#" +
    SPACE +
    "*(?:noqa|type:" +
    SPACE +
    "*ignore|pragma(?::|" +
    SPACE +
    "+once" +
    BOUNDARY +
    ")|pylint|flake8|fmt:|shellcheck|frozen_string_literal|(?:end)?region" +
    BOUNDARY +
    ")|//" +
    SPACE +
    "*(?:eslint|biome-ignore|@ts-|prettier-ignore|@flow|@jsx|#region|#endregion|go:|nolint|\\+build|@__PURE__|@vitest|@vite)|/\\*\\*?" +
    SPACE +
    "*(?:eslint|biome-ignore|prettier-ignore|@__PURE__|webpackChunkName|c8" +
    BOUNDARY +
    "|istanbul" +
    SPACE +
    "+ignore" +
    BOUNDARY +
    "|@type" +
    BOUNDARY +
    "|@jsxImportSource)|/\\*\\*?" +
    SPACE +
    "*global" +
    BOUNDARY +
    "(?:" +
    SPACE +
    "*(?:\\*/)?" +
    SPACE +
    "*$|" +
    SPACE +
    "+[\\p{L}\\p{N}_$]+(?:" +
    SPACE +
    "*:" +
    SPACE +
    "*" +
    WORD +
    "+)?(?:" +
    SPACE +
    "*," +
    SPACE +
    "*[\\p{L}\\p{N}_$]+(?:" +
    SPACE +
    "*:" +
    SPACE +
    "*" +
    WORD +
    "+)?)*" +
    SPACE +
    "*,?" +
    SPACE +
    "*(?:\\*/)?" +
    SPACE +
    "*$)|\\{/\\*" +
    SPACE +
    "*(?:eslint|prettier-ignore)|--" +
    SPACE +
    "*(?:noqa|sqlfluff)|\\{-#|<!--" +
    SPACE +
    "*(?:prettier|@|\\[if))",
  "iu",
);

const LICENSE = new RegExp(
  "SPDX-License-Identifier|Copyright" +
    SPACE +
    "*(?:\\(c\\)|\u00a9|\\p{Nd}{4})|Licensed under|All rights reserved",
  "iu",
);

export const DEFAULT_SKIP = [
  "node_modules/",
  "/.git/",
  "/dist/",
  "/build/",
  "/out/",
  "/target/",
  "/vendor/",
  "/generated/",
  "/.venv/",
  "/_archive/",
  "/done/",
];

export function skipPath(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENT_HOOKS_SKIP;
  const skip = raw ? raw.split(",").map((line) => line.trim()).filter(Boolean) : DEFAULT_SKIP;
  return skip.some((part) => path.includes(part));
}

export function specFor(path: string): Spec | undefined {
  const base = basename(path);
  return Object.hasOwn(BY_NAME, base) ? BY_NAME[base] : BY_EXT[splitext(base).toLowerCase()];
}

const QUOTED = /'(?:\\[^\n]|[^'\\\n])*'|"(?:\\[^\n]|[^"\\\n])*"/uy;
const METACHARS = ";&|<>()`";

function quotedAt(raw: string, index: number): RegExpExecArray | null {
  QUOTED.lastIndex = index;
  return QUOTED.exec(raw);
}

function interpolates(fence: string): boolean {
  return !"\"'".includes(fence[0]!);
}

function pastQuoted(raw: string, index: number): number {
  const quoted = quotedAt(raw, index);
  return quoted ? index + quoted[0].length : index + 1;
}

function breaksWord(char: string): boolean {
  return /^\s+$/.test(char) || METACHARS.includes(char);
}

function heredocWord(raw: string, start: number): string {
  const out: string[] = [];

  let index = start;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\\") {
      if (index + 1 >= raw.length) break;
      out.push(raw[index + 1]!);
      index += 2;
    } else if ("'\"".includes(char)) {
      const quoted = quotedAt(raw, index);
      if (!quoted) break;

      out.push(quoted[0].slice(1, -1));
      index += quoted[0].length;
    } else if (breaksWord(char)) break;
    else {
      out.push(char);
      index += 1;
    }
  }

  return out.join("");
}

type Heredoc = [string, boolean];

function heredocAt(raw: string, start: number): Heredoc | undefined {
  let index = start;
  const stripTabs = raw.startsWith("-", index);
  if (stripTabs) index += 1;
  while (index < raw.length && " \t".includes(raw[index]!)) index += 1;

  const term = heredocWord(raw, index);
  return term ? [term, stripTabs] : undefined;
}

function heredocsAfter(raw: string): Heredoc[] {
  const parens: number[] = [];
  const braces: number[] = [];
  const spans: [number, number][] = [];
  const operators: [number, number][] = [];

  let popped: [number, number] | undefined;
  let escaped = -1;
  let index = 0;
  while (index < raw.length) {
    const char = raw[index]!;
    if (char === "\\") {
      index += 2;
      escaped = index;
    } else if (char === "'") index = pastQuoted(raw, index);
    else if (char === '"') {
      const span = quotedAt(raw, index);
      index = span && !span[0].includes("$(") ? index + span[0].length : index + 1;
    } else if (char === "#" && index !== escaped && (index === 0 || breaksWord(raw[index - 1]!)))
      break;
    else if (raw.startsWith("${", index)) {
      braces.push(index);
      index += 2;
    } else if (char === "}" && braces.length) {
      spans.push([braces.pop()!, index]);
      index += 1;
    } else if (char === "(") {
      parens.push(index);
      index += 1;
    } else if (char === ")") {
      if (parens.length) {
        const start = parens.pop()!;
        if (popped?.[0] === start + 1 && popped[1] === index - 1) spans.push([start, index - 1]);
        popped = [start, index];
      }

      index += 1;
    } else if (char === "<") {
      let end = index;
      while (end < raw.length && raw[end] === "<") end += 1;
      if (end - index === 2) operators.push([index, end]);
      index = end;
    } else index += 1;
  }

  return operators
    .filter(([at]) => !spans.some(([start, end]) => start < at && at < end))
    .map(([, end]) => heredocAt(raw, end))
    .filter((pending): pending is Heredoc => pending !== undefined);
}

function heredocClosed(raw: string, pending: Heredoc): boolean {
  const [term, stripTabs] = pending;
  return (stripTabs ? raw.replace(/^\t+/, "") : raw).replace(/[\r\n]+$/, "") === term;
}

function fenceAfter(
  raw: string,
  spec: Spec,
  initial: string | undefined,
): [string | undefined, boolean] {
  const { markers, fences } = spec;
  const widest = [...fences].sort((left, right) => right.length - left.length);

  let inside = initial;
  let closed = false;
  let index = 0;
  while (index < raw.length)
    if (raw[index] === "\\") index += 2;
    else if (inside !== undefined)
      if (raw.startsWith(inside, index)) {
        index += inside.length;
        inside = undefined;
        closed = true;
      } else if (interpolates(inside)) index = pastQuoted(raw, index);
      else index += 1;
    else {
      const fence = widest.find((candidate) => raw.startsWith(candidate, index));
      if (fence !== undefined) {
        inside = fence;
        index += fence.length;
      } else if (markers.some((marker) => raw.startsWith(marker, index))) break;
      else index = pastQuoted(raw, index);
    }

  return [inside, closed];
}

export const RESYNC_BOUND = 256;

function lastCloseLine(lines: string[], spec: Spec): Map<string, number> {
  const last = new Map<string, number>();
  for (const [index, raw] of lines.entries())
    for (const fence of spec.fences)
      if (raw.includes(fence) && fenceAfter(raw, spec, fence)[1]) last.set(fence, index + 1);

  return last;
}

type State = {
  last: Map<string, number>;
  since: number;
  open?: string | undefined;
  heredoc?: Heredoc[];
};

function inString(state: State, raw: string, line: number, spec: Spec): boolean {
  const { markers, blocks } = spec;
  const queued = state.heredoc;
  if (queued?.length) {
    if (heredocClosed(raw, queued[0]!)) state.heredoc = queued.slice(1);
    return true;
  }

  const inside = state.open;
  const starts = [...markers, ...blocks.map(([opener]) => opener)];
  const head = raw.trimStart();

  if (
    inside === undefined &&
    starts.some((opener) => head.startsWith(opener)) &&
    !spec.exclude.some((exclude) => head.startsWith(exclude))
  )
    return false;

  if (
    inside === undefined &&
    spec.markers.length === 1 &&
    spec.markers[0] === "#" &&
    !spec.blocks.length &&
    !spec.fences.length &&
    !spec.exclude.length
  ) {
    const opened = heredocsAfter(raw);
    if (opened.length) {
      state.heredoc = opened;
      return false;
    }
  }

  let [opened] = fenceAfter(raw, spec, inside);
  const started = inside === undefined ? line : state.since;
  if (
    opened !== undefined &&
    ((state.last.get(opened) ?? 0) <= line || line - started >= RESYNC_BOUND)
  )
    opened = undefined;

  state.open = opened;
  state.since = started;

  return inside !== undefined;
}

export function commentLines(text: string, spec: Spec): CommentLine[] {
  const { markers, blocks } = spec;
  const units: CommentLine[][] = [];

  let closer: string | undefined;
  let pending: CommentLine[] = [];
  const lines = text.split("\n");
  const state: State = { last: lastCloseLine(lines, spec), since: 0 };
  for (const [index, raw] of lines.entries()) {
    const line = index + 1;
    const stripped = raw.trim();
    if (closer) {
      pending.push([line, stripped]);

      if (stripped.includes(closer)) {
        units.push(pending);
        closer = undefined;
        pending = [];
      }

      continue;
    }

    if (inString(state, raw, line, spec) || !stripped) continue;
    if (spec.exclude.some((exclude) => stripped.startsWith(exclude))) continue;

    const block = blocks.find(([opener]) => stripped.startsWith(opener));
    if (block) {
      const [opener, close] = block;
      if (!stripped.slice(opener.length).includes(close)) {
        closer = close;
        pending = [[line, stripped]];
      } else units.push([[line, stripped]]);
    } else if (markers.some((marker) => stripped.startsWith(marker)))
      units.push([[line, stripped]]);
  }

  if (pending.length) units.push([pending[0]!]);

  return units
    .filter(
      (unit) => !PRAGMA.test(unit[0]![1]) && !unit.some(([, stripped]) => LICENSE.test(stripped)),
    )
    .flat();
}

export const MATCH_WORK_LIMIT = 2_000_000;
export const MATCH_LINE_LIMIT = 2000;

function counts(lines: readonly string[]): Map<string, number> {
  const counter = new Map<string, number>();
  for (const line of lines) counter.set(line, (counter.get(line) ?? 0) + 1);
  return counter;
}

function subtract(first: Map<string, number>, second: Map<string, number>): Map<string, number> {
  return new Map(
    [...first]
      .map(([line, count]): [string, number] => [line, count - (second.get(line) ?? 0)])
      .filter(([, count]) => count > 0),
  );
}

function overBudget(oldMid: string[], newMid: string[]): boolean {
  if (Math.max(oldMid.length, newMid.length) > MATCH_LINE_LIMIT) return true;
  const counter = counts(oldMid);
  return newMid.reduce((total, line) => total + (counter.get(line) ?? 0), 0) > MATCH_WORK_LIMIT;
}

function changedIndices(oldText: string, newText: string): Set<number> {
  const oldLines = (oldText || "").split("\n").map((line) => line.trim());
  const newLines = newText.split("\n").map((line) => line.trim());

  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head])
    head += 1;

  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  )
    tail += 1;

  const oldMid = oldLines.slice(head, oldLines.length - tail);
  const newMid = newLines.slice(head, newLines.length - tail);
  if (overBudget(oldMid, newMid)) {
    const surplus = subtract(counts(newMid), counts(oldMid));
    return new Set(newMid.flatMap((line, index) => (surplus.has(line) ? [index + head] : [])));
  }

  const matcher = new SequenceMatcher(oldMid, newMid);
  return new Set(
    matcher
      .getOpcodes()
      .flatMap(([tag, , , start, end]) =>
        tag === "equal"
          ? []
          : Array.from({ length: end - start }, (_, index) => start + index + head),
      ),
  );
}

export function soleOffset(text: string, newText: string): number | undefined {
  const start = text.indexOf(newText);
  if (start === -1 || text.indexOf(newText, start + 1) !== -1) return undefined;
  return start;
}

function windows(count: number, cap: number): number[] {
  const widest = Math.min(count, cap);
  const sizes: number[] = [];

  let size = 1;
  while (size < widest) {
    sizes.push(size);
    size *= 2;
  }

  return widest ? [...sizes, widest] : [];
}

function spliceOffset(
  text: string,
  context: string,
  trailing: boolean,
  cap: number,
): number | undefined {
  const lines = context.split("\n");
  for (const size of windows(lines.length, cap)) {
    const probe = (trailing ? lines.slice(0, size) : lines.slice(-size)).join("\n");
    const offset = probe ? soleOffset(text, probe) : undefined;
    if (offset !== undefined) return trailing ? offset : offset + probe.length;
  }

  return undefined;
}

export function restored(
  text: string,
  headText: string,
  oldText: string,
  cap = 64,
): string | undefined {
  if (!oldText || !headText) return undefined;

  const offset = soleOffset(headText, oldText);
  if (offset === undefined) return undefined;

  const lead = headText.slice(0, offset);
  const tail = headText.slice(offset + oldText.length);
  const leading = lead ? spliceOffset(text, lead, false, cap) : undefined;
  const trailing = tail ? spliceOffset(text, tail, true, cap) : undefined;

  let point: number | undefined;
  if (lead && tail) {
    if (leading === undefined || trailing === undefined || leading !== trailing) return undefined;
    point = leading;
  } else {
    point = leading ?? trailing;
    const edge = !lead ? 0 : text.length;
    if (point === undefined || point !== edge) return undefined;
  }

  const out = text.slice(0, point) + oldText + text.slice(point);
  if (out.split("\n").length - 1 > MATCH_LINE_LIMIT) return undefined;

  return soleOffset(out, oldText) !== undefined ? out : undefined;
}

export function added(
  fileText: string,
  oldText: string | undefined,
  newText: string,
  spec: Spec,
  options: { everywhere?: boolean; taken?: Set<number> } = {},
): CommentLine[] {
  if (!newText) return [];

  const text = fileText || "";
  const found = commentLines(text, spec);
  if (!found.length) return [];

  oldText = oldText || "";
  const start = soleOffset(text, newText);
  if (start === undefined) {
    const copies = options.everywhere
      ? Math.max(1, text.split(newText.replace(/\r\n?/g, "\n")).length - 1)
      : 1;

    const surplus = subtract(
      counts(newText.split("\n").map((line) => line.trim())),
      counts(oldText.split("\n").map((line) => line.trim())),
    );

    for (const [line, count] of surplus) surplus.set(line, count * copies);

    return found.filter(([line, stripped]) => {
      const left = options.taken?.has(line) ? 0 : (surplus.get(stripped) ?? 0);
      if (left > 0) surplus.set(stripped, left - 1);
      return left > 0;
    });
  }

  const base = text.slice(0, start).split("\n").length - 1;
  const before = text.slice(0, start) + oldText + text.slice(start + newText.length);
  const was = commentLines(before, spec);
  const wasComment = new Set(was.map(([line]) => line));

  const shift = newText.split("\n").length - oldText.split("\n").length;
  const newEnd = base + newText.split("\n").length;
  const oldEnd = newEnd - shift;
  const inSpan = found.filter(([line]) => base < line && line <= newEnd);
  const surplus = subtract(
    counts(inSpan.map(([, stripped]) => stripped)),
    counts(was.filter(([line]) => base < line && line <= oldEnd).map(([, stripped]) => stripped)),
  );

  const changed = changedIndices(oldText, newText);
  const picked = new Set<number>();
  for (const flagged of [true, false])
    for (const [line, stripped] of inSpan) {
      if (picked.has(line) || (surplus.get(stripped) ?? 0) < 1) continue;
      if (changed.has(line - base - 1) === flagged) {
        surplus.set(stripped, surplus.get(stripped)! - 1);
        picked.add(line);
      }
    }

  return found.filter(([line]) =>
    line <= base
      ? !wasComment.has(line)
      : line > newEnd
        ? !wasComment.has(line - shift)
        : picked.has(line),
  );
}

export function clip(text: string, width = 90): string {
  const points = Array.from(text);
  return points.length <= width ? text : points.slice(0, width - 3).join("") + "...";
}

export const RULE =
  "Default is none. Delete each. Keep one line only where it names an external constraint, a landmine, or why the obvious approach lost.";
