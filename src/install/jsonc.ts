import { JsonNumber, object, parseJson, type Json, type JsonObject } from "./json.ts";

type Span = { start: number; end: number };
type Property = { key: string; value: Span; items?: Span[] };
export type JsoncDocument = {
  text: string;
  clean: string;
  data: JsonObject;
  properties: Property[];
  closing: number;
};

export type JsoncArrayEdit = { keep: number[]; append: Json[] };
type Splice = Span & { text: string };

function equalValues(left: Json, right: Json): boolean {
  if (left === right) return true;
  if (left instanceof JsonNumber || right instanceof JsonNumber)
    return left instanceof JsonNumber && right instanceof JsonNumber && left.text === right.text;

  if (Array.isArray(left) || Array.isArray(right))
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equalValues(value, right[index]!))
    );

  const first = object(left);
  const second = object(right);
  return (
    !!first &&
    !!second &&
    Object.keys(first).length === Object.keys(second).length &&
    Object.entries(first).every(
      ([key, value]) => Object.hasOwn(second, key) && equalValues(value, second[key]!),
    )
  );
}

function stringEnd(text: string, start: number): number {
  let offset = start + 1;
  while (offset < text.length) {
    if (text[offset] === '"') return offset + 1;
    offset += text[offset] === "\\" ? 2 : 1;
  }

  return offset;
}

function blankJsonc(text: string, trailing = true): string {
  const clean = text.split("");
  const blank = (start: number, end: number) => {
    for (let offset = start; offset < end; offset++)
      if (clean[offset] !== "\r" && clean[offset] !== "\n") clean[offset] = " ";
  };

  for (let offset = 0; offset < text.length;) {
    if (text[offset] === '"') {
      offset = stringEnd(text, offset);
      continue;
    }

    if (text.startsWith("//", offset)) {
      const newline = text.indexOf("\n", offset);
      const end = newline === -1 ? text.length : newline;
      blank(offset, end);
      offset = end;
    } else if (text.startsWith("/*", offset)) {
      const closing = text.indexOf("*/", offset + 2);
      if (closing === -1) throw new Error("invalid JSONC: unterminated comment");

      blank(offset, closing + 2);
      offset = closing + 2;
    } else offset++;
  }

  const commentsBlanked = clean.join("");
  if (!trailing) return commentsBlanked;

  for (let offset = 0; offset < text.length;) {
    if (commentsBlanked[offset] === '"') {
      offset = stringEnd(commentsBlanked, offset);
      continue;
    }

    if (commentsBlanked[offset] === ",") {
      const next = commentsBlanked.slice(offset + 1).match(/^\s*(.)/s)?.[1];
      const previous = commentsBlanked.slice(0, offset).trimEnd().at(-1);
      if ((next === "]" || next === "}") && previous && !"[{,:".includes(previous))
        clean[offset] = " ";
    }

    offset++;
  }

  return clean.join("");
}

function valueEnd(text: string, start: number): number {
  if (text[start] === '"') return stringEnd(text, start);
  if (text[start] !== "{" && text[start] !== "[") {
    const length = text.slice(start).match(/^[^\s,}\]]+/)![0].length;
    return start + length;
  }

  let depth = 0;
  for (let offset = start; offset < text.length; offset++)
    if (text[offset] === '"') offset = stringEnd(text, offset) - 1;
    else if (text[offset] === "{" || text[offset] === "[") depth++;
    else if (text[offset] === "}" || text[offset] === "]") {
      depth--;
      if (!depth) return offset + 1;
    }

  throw new Error("invalid JSONC: missing closing delimiter");
}

function nextToken(text: string, start: number): number {
  return start + (text.slice(start).match(/^\s*/)?.[0].length ?? 0);
}

export function parseJsonc(text: string): JsoncDocument {
  if (text.startsWith("\uFEFF")) throw new Error("byte order mark is not supported");

  const clean = blankJsonc(text, false);
  const data = object(parseJson(blankJsonc(text)));
  if (!data) throw new Error("top level is not an object");

  const properties: Property[] = [];

  let offset = nextToken(clean, nextToken(clean, 0) + 1);
  while (clean[offset] !== "}") {
    const end = stringEnd(clean, offset);
    const key: string = JSON.parse(clean.slice(offset, end));
    const start = nextToken(clean, nextToken(clean, end) + 1);
    const value = { start, end: valueEnd(clean, start) };
    const property: Property = { key, value };
    if (Array.isArray(data[key])) {
      property.items = [];

      let position = nextToken(clean, start + 1);
      while (clean[position] !== "]") {
        const item = { start: position, end: valueEnd(clean, position) };
        property.items.push(item);
        position = nextToken(clean, item.end);
        if (clean[position] === ",") position = nextToken(clean, position + 1);
      }
    }

    properties.push(property);
    offset = nextToken(clean, value.end);
    if (clean[offset] === ",") offset = nextToken(clean, offset + 1);
  }

  return { text, clean, data, properties, closing: offset };
}

function inline(value: Json): string {
  if (value instanceof JsonNumber) return value.text;
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;

  return `{ ${Object.entries(value)
    .map(([key, entry]) => `${JSON.stringify(key)}: ${inline(entry)}`)
    .join(", ")} }`;
}

function splice(text: string, edits: Splice[]): string {
  return edits
    .map((edit, order) => ({ ...edit, order }))
    .sort(
      (left, right) => right.start - left.start || right.end - left.end || right.order - left.order,
    )
    .reduce(
      (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end),
      text,
    );
}

function indentAt(text: string, offset: number): string {
  return text.slice(text.lastIndexOf("\n", offset - 1) + 1, offset).match(/^[\t ]*/)?.[0] ?? "";
}

function insertBeforeClosing(
  text: string,
  closing: number,
  content: string,
  indent: string,
  newline: string,
): Splice {
  const line = text.lastIndexOf("\n", closing - 1) + 1;
  const ownLine = /^[\t ]*$/.test(text.slice(line, closing));
  return {
    start: ownLine ? line : closing,
    end: ownLine ? line : closing,
    text: `${ownLine ? "" : newline}${content}${newline}${ownLine ? "" : indent}`,
  };
}

export function editJsoncArrays(
  document: JsoncDocument,
  updates: Record<string, JsoncArrayEdit>,
): string {
  const { text, clean, data } = document;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = text.match(/(?:^|\n)([\t ]+)"/)?.[1] ?? "  ";
  const edits: Splice[] = [];
  const additions: string[] = [];
  for (const [key, update] of Object.entries(updates)) {
    const old = data[key];
    if (old !== undefined && !Array.isArray(old)) throw new Error(`${key} is not an array`);

    const values = [...update.keep.map((index) => (old as Json[])[index]!), ...update.append];
    if (equalValues(old ?? [], values)) continue;

    const property = document.properties.find((property) => property.key === key);
    if (!property) {
      additions.push(
        `${unit}${JSON.stringify(key)}: [${newline}${values.map((value) => `${unit}${unit}${inline(value)}`).join(`,${newline}`)}${newline}${unit}]`,
      );

      continue;
    }

    const items = property.items!;
    const keep = new Set(update.keep);
    const last = items.at(-1);
    const trailing = last !== undefined && text[nextToken(clean, last.end)] === ",";
    const lastKept = update.keep.at(-1);
    for (const [index, item] of items.entries()) {
      const separator = nextToken(clean, item.end);
      const comma = text[separator] === ",";
      if (keep.has(index)) {
        if (comma && index === lastKept && !trailing && !update.append.length)
          edits.push({ start: separator, end: separator + 1, text: "" });
        else if (!comma && index === lastKept && update.append.length)
          edits.push({ start: item.end, end: item.end, text: "," });

        continue;
      }

      const line = text.lastIndexOf("\n", item.start - 1) + 1;
      const after = comma ? separator + 1 : item.end;
      const endOfLine = text.indexOf("\n", after);
      const alone =
        /^[\t ]*$/.test(text.slice(line, item.start)) &&
        /^[\t \r]*$/.test(clean.slice(after, endOfLine === -1 ? text.length : endOfLine));

      if (alone)
        edits.push({ start: line, end: endOfLine === -1 ? text.length : endOfLine + 1, text: "" });
      else {
        edits.push({ ...item, text: "" });
        if (comma) edits.push({ start: separator, end: separator + 1, text: "" });
      }
    }

    if (!update.append.length) continue;

    const closing = property.value.end - 1;
    const base = indentAt(text, property.value.start);
    const indent = items.length ? indentAt(text, items[0]!.start) || base + unit : base + unit;
    const content = update.append.map((value) => `${indent}${inline(value)}`).join(`,${newline}`);
    edits.push(insertBeforeClosing(text, closing, content + (trailing ? "," : ""), base, newline));
  }

  if (additions.length) {
    const last = document.properties.at(-1);
    const comma = last && text[nextToken(clean, last.value.end)] === ",";
    if (last && !comma) edits.push({ start: last.value.end, end: last.value.end, text: "," });

    edits.push(
      insertBeforeClosing(
        text,
        document.closing,
        additions.join(`,${newline}`) + (comma ? "," : ""),
        "",
        newline,
      ),
    );
  }

  return splice(text, edits);
}
