import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  blockerState,
  CAPABILITIES,
  type IndexRow,
  isCapability,
  planNeeds,
  proseRefs,
  type World,
} from "skills-core";

const BANNED =
  /^(current state|steps|git workflow|drift check|stop conditions|commands you will need)$/;

const FORWARD =
  /(until|once|which[ \t]+is|pending|blocked[ \t]+by|blocks[ \t]+on|waits[ \t]+on|waiting[ \t]+on|will[ \t]+be)[ \t]+[0-9]{3}([^0-9]|$)/;

const CONDITIONAL = /(when|after)[ \t]+[0-9]{3}([^0-9]|$)/;
const INTENTION =
  /(wants|needs|deserves|should[ \t]+be|should[ \t]+get|worth)[ \t]+its[ \t]+own[ \t]+plan/;

const ID_TOKEN = /(^|[^0-9])[0-9]{3}([^0-9]|$)/;
const PLAN_FILE = /^[0-9]{3}-.*\.md$/;

type Known = { statuses: Map<string, string>; filed: Set<string>; world: World };

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function trimEnd(value: string): string {
  return value.replace(/[ \t]+$/, "");
}

function firstId(text: string): string {
  return /[0-9]{3}/.exec(text)?.[0] ?? "";
}

function fileLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function surfaceValue(line: string): string {
  const value = trimEnd(line.replace(/^surface:[ \t]*/, ""));
  const quoted = value.length >= 2 && /^(".*"|'.*')$/.test(value);
  return (quoted ? value.slice(1, -1) : value).replace(/^[ \t]+|[ \t]+$/g, "");
}

export function landedHeading(text: string): { start: number; end: number } | undefined {
  let fence: string | undefined;
  let start = 0;
  for (const line of text.split("\n")) {
    const end = start + line.length;
    const marker = /^[ \t]*(```|~~~)/.exec(line)?.[1];
    if (marker && (fence === undefined || fence === marker))
      fence = fence === undefined ? marker : undefined;
    else if (fence === undefined && /^## Landed[ \t]*\r?$/.test(line)) return { start, end };

    start = end + 1;
  }

  return undefined;
}

export function landedLine(text: string): { line: string; offset: number } | undefined {
  const heading = landedHeading(text);
  if (!heading) return undefined;

  const first = /^(?:[ \t]*\r?\n)*([^\r\n]+)/.exec(text.slice(heading.end));
  const line = first?.[1];
  if (!first || !line || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(line)) return undefined;

  return { line, offset: heading.end + first[0].length - line.length };
}

function shapeErrors(name: string, text: string, isCtx: boolean): string[] {
  const banned: string[] = [];

  const front: {
    opened: boolean;
    closed: boolean;
    surface: boolean;
    critical?: string;
  } = { opened: false, closed: false, surface: false };

  const body = { inAcceptance: false, fenced: false, items: 0 };
  for (const [index, line] of fileLines(text).entries()) {
    if (index === 0 && line === "---") {
      front.opened = true;
      continue;
    }

    const inFrontmatter = front.opened && !front.closed;
    if (!inFrontmatter && /^[ \t]*```/.test(line)) body.fenced = !body.fenced;
    if (body.fenced) continue;

    if (inFrontmatter && line === "---") {
      front.closed = true;
      continue;
    }

    if (inFrontmatter && line.startsWith("surface:")) {
      if (surfaceValue(line) !== "") front.surface = true;
      continue;
    }

    if (inFrontmatter && line.startsWith("critical:")) {
      const value = trimEnd(line.replace(/^critical:[ \t]*/, ""));
      if (value !== "true" && value !== "false") front.critical = value;
      continue;
    }

    if (/^##[ \t]+/.test(line)) {
      const heading = trimEnd(line.replace(/^##[ \t]+/, ""));
      if (BANNED.test(heading.toLowerCase())) banned.push(heading);

      body.inAcceptance = heading === "Acceptance";
      continue;
    }

    if (body.inAcceptance && /^ {0,3}([0-9]+[.)]|[-*+][ \t]+)/.test(line)) body.items++;
  }

  const errors: string[] = [];
  if (!isCtx) {
    if (!front.opened || !front.closed) errors.push(`${name}: no frontmatter`);
    else if (!front.surface) errors.push(`${name}: frontmatter has no surface: value`);

    if (front.critical !== undefined)
      errors.push(`${name}: critical: must be true or false, got "${front.critical}"`);

    for (const word of planNeeds(text)?.filter((need) => !isCapability(need)) ?? [])
      errors.push(
        `${name}: needs: unknown capability "${word}", one of ${CAPABILITIES.join(", ")}`,
      );

    if (body.items > 3) errors.push(`${name}: ${body.items} acceptance items, cap is 3`);
  }

  for (const heading of banned) errors.push(`${name}: banned section "## ${heading}"`);
  return errors;
}

function forwardPointer(
  line: string,
  pattern: RegExp,
  needTail: boolean,
  known: Known,
): string | undefined {
  const lower = asciiLower(line);
  for (let offset = 0; ;) {
    const match = pattern.exec(lower.slice(offset));
    if (!match) return undefined;

    const start = offset + match.index;
    const segment = match[0];
    offset = start + segment.length;

    const id = firstId(segment);
    const status = known.statuses.get(id);
    if (status !== "DONE" && status !== "DROPPED") continue;

    if (needTail) {
      const tail = lower.slice(start + segment.indexOf(id) + 3).replace(/[.,;:)].*$/, "");
      if (!/(lands|closes|ships|is[ \t]+done)/.test(tail)) continue;
    }

    const text = line.slice(start, start + segment.length).replace(/[^0-9]$/, "");
    return `forward pointer at ${id} (${status}): ${text}`;
  }
}

function namesFiledId(line: string, known: Known): boolean {
  let local = line;
  for (const { ref, start, end } of proseRefs(line, known.world)) {
    const state = blockerState(ref, [], known.world).kind;
    if (state === "open" || state === "released") return true;
    local = `${local.slice(0, start)}${" ".repeat(end - start)}${local.slice(end)}`;
  }

  for (let rest = local; ;) {
    const match = ID_TOKEN.exec(rest);
    if (!match) return false;

    const id = firstId(match[0]);
    if (known.statuses.has(id) || known.filed.has(id)) return true;

    rest = rest.slice(match.index + match[0].length - 1);
  }
}

function ctxErrors(name: string, text: string, known: Known): string[] {
  const errors: string[] = [];

  let fenced = false;
  for (const [index, line] of fileLines(text).entries()) {
    if (/^[ \t]*```/.test(line)) {
      fenced = !fenced;
      continue;
    }

    if (fenced) continue;

    const at = `${name}: line ${index + 1}: `;
    const pointer =
      forwardPointer(line, FORWARD, false, known) ?? forwardPointer(line, CONDITIONAL, true, known);

    if (pointer) errors.push(at + pointer);

    const lower = asciiLower(line);
    const intention = INTENTION.exec(lower);
    if (intention && !namesFiledId(line, known))
      errors.push(
        `${at}intention with no id: ${line.slice(intention.index, intention.index + intention[0].length)}`,
      );
  }

  return errors;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function markdown(directory: string): string[] {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return [];
  }

  return names
    .filter(
      (name) => name.endsWith(".md") && !name.startsWith(".") && isFile(`${directory}/${name}`),
    )
    .sort();
}

export type ReadText = (path: string) => string;

const readText: ReadText = (path) => readFileSync(path, "utf8");
export function lintFile(
  directory: string,
  name: string,
  known: Known | undefined,
  read: ReadText = readText,
): string[] {
  const path = `${directory}/${name}`;
  const isCtx = name.startsWith("ctx-");
  const errors: string[] = [];

  const text = read(path);
  const landed = landedHeading(text);
  const bytes = Buffer.byteLength(landed ? text.slice(0, landed.start) : text, "utf8");
  if (!isCtx && bytes > 4096) errors.push(`${name}: ${bytes} bytes, over the 4096 cap`);

  errors.push(...shapeErrors(name, text, isCtx));
  if (isCtx && known) errors.push(...ctxErrors(name, text, known));

  return errors;
}

export function lintedFiles(directory: string, id: string | undefined): string[] {
  return markdown(directory).filter((name) => id === undefined || name.startsWith(`${id}-`));
}

export function lint(
  directory: string,
  project: string,
  id: string | undefined,
  world: ({ rows: readonly IndexRow[] } & World) | undefined,
  read: ReadText = readText,
): { stdout: string; stderr: string; code: number } {
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return { stdout: "", stderr: `no plans directory ${directory}\n`, code: 1 };

  const known: Known | undefined = world
    ? {
        statuses: new Map(world.rows.map((row) => [row.id, row.status])),
        world,
        filed: new Set(
          [...markdown(directory), ...markdown(`${directory}/done`)]
            .filter((name) => PLAN_FILE.test(name))
            .map((name) => name.slice(0, 3)),
        ),
      }
    : undefined;

  const files = lintedFiles(directory, id);
  if (id !== undefined && files.length === 0)
    return { stdout: "", stderr: `no plan ${id} in ${project}\n`, code: 1 };

  const errors = files.flatMap((name) => lintFile(directory, name, known, read));
  if (errors.length > 0)
    return { stdout: `${errors.join("\n")}\n${errors.length} error(s)\n`, stderr: "", code: 1 };

  return { stdout: "ok\n", stderr: "", code: 0 };
}
