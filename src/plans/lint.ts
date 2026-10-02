import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { indexIn, readIndex } from "./index-tsv.ts";

const BANNED = /^(current state|steps|git workflow|drift check|stop conditions|commands you will need)$/;
const FORWARD =
  /(until|once|which[ \t]+is|pending|blocked[ \t]+by|blocks[ \t]+on|waits[ \t]+on|waiting[ \t]+on|will[ \t]+be)[ \t]+[0-9]{3}([^0-9]|$)/;

const CONDITIONAL = /(when|after)[ \t]+[0-9]{3}([^0-9]|$)/;
const INTENTION = /(wants|needs|deserves|should[ \t]+be|should[ \t]+get|worth)[ \t]+its[ \t]+own[ \t]+plan/;
const ID_TOKEN = /(^|[^0-9])[0-9]{3}([^0-9]|$)/;
const PLAN_FILE = /^[0-9]{3}-.*\.md$/;

type Known = { statuses: Map<string, string>; filed: Set<string> };

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

function shapeErrors(name: string, text: string, isCtx: boolean): string[] {
  const banned: string[] = [];

  const front: { opened: boolean; closed: boolean; surface: boolean; critical?: string } = {
    opened: false,
    closed: false,
    surface: false,
  };

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

    if (front.critical !== undefined) errors.push(`${name}: critical: must be true or false, got "${front.critical}"`);
    if (body.items > 3) errors.push(`${name}: ${body.items} acceptance items, cap is 3`);
  }

  for (const heading of banned) errors.push(`${name}: banned section "## ${heading}"`);
  return errors;
}

function forwardPointer(line: string, pattern: RegExp, needTail: boolean, known: Known): string | undefined {
  const lower = asciiLower(line);
  for (let offset = 0; ; ) {
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

function namesFiledId(lower: string, known: Known): boolean {
  for (let rest = lower; ; ) {
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
    if (intention && !namesFiledId(lower, known))
      errors.push(`${at}intention with no id: ${line.slice(intention.index, intention.index + intention[0].length)}`);
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
    .filter((name) => name.endsWith(".md") && !name.startsWith(".") && isFile(`${directory}/${name}`))
    .sort();
}

export function lintFile(directory: string, name: string, known: Known | undefined): string[] {
  const path = `${directory}/${name}`;
  const isCtx = name.startsWith("ctx-");
  const errors: string[] = [];

  const bytes = statSync(path).size;
  if (!isCtx && bytes > 4096) errors.push(`${name}: ${bytes} bytes, over the 4096 cap`);

  const text = readFileSync(path, "utf8");
  errors.push(...shapeErrors(name, text, isCtx));
  if (isCtx && known) errors.push(...ctxErrors(name, text, known));

  return errors;
}

export function lint(directory: string, project: string, id?: string): { stdout: string; stderr: string; code: number } {
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return { stdout: "", stderr: `no plans directory ${directory}\n`, code: 1 };

  const index = indexIn(directory);
  const indexed = existsSync(index) && statSync(index).isFile();
  const known: Known | undefined = indexed
    ? {
        statuses: new Map(readIndex(index).map((row) => [row.id, row.status])),
        filed: new Set(
          [...markdown(directory), ...markdown(`${directory}/done`)]
            .filter((name) => PLAN_FILE.test(name))
            .map((name) => name.slice(0, 3)),
        ),
      }
    : undefined;

  const files = markdown(directory).filter((name) => id === undefined || name.startsWith(`${id}-`));
  if (id !== undefined && files.length === 0) return { stdout: "", stderr: `no plan ${id} in ${project}\n`, code: 1 };

  const errors = files.flatMap((name) => lintFile(directory, name, known));
  if (errors.length > 0) return { stdout: `${errors.join("\n")}\n${errors.length} error(s)\n`, stderr: "", code: 1 };

  return { stdout: "ok\n", stderr: "", code: 0 };
}
