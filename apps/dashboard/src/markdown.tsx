import { useMemo, type ReactNode } from "react";

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "em"; children: Inline[] }
  | { kind: "strong"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "front"; text: string }
  | { kind: "heading"; level: Level; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] };

const HEADING = /^ {0,3}(#{1,6})(?=[ \t]|$)/;
const FENCE = /^( {0,3})(`{3,}(?=[^`]*$)|~{3,})(.*)$/;
const ITEM = /^( {0,3})([-*+]|(\d{1,9})[.)])([ \t]+|$)/;
const INDENTED = /^(?: {4}|\t)/;

const PUNCTUATION = /[!-/:-@[-`{-~]/;
const WORD = /[\p{L}\p{N}]/u;
const LINK_SCHEMES: readonly string[] = ["http:", "https:"];
const MAX_DEPTH = 16;

type Level = 1 | 2 | 3 | 4 | 5 | 6;

const blank = (line: string) => line.trim() === "";

function fenceEnd(line: string, fence: string): boolean {
  const match = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
  return match !== null && match[1]![0] === fence[0] && match[1]!.length >= fence.length;
}

function headingOf(line: string): { level: Level; text: string } | undefined {
  const open = HEADING.exec(line);
  if (!open) return undefined;

  const text = line.slice(open[0].length).trim();
  const closing = /(^|[ \t])#+$/.exec(text);
  const kept = closing ? text.slice(0, closing.index).trimEnd() : text;
  return { level: open[1]!.length as Level, text: kept };
}

function startsBlock(line: string): boolean {
  return HEADING.test(line) || FENCE.test(line) || ITEM.test(line);
}

function interrupts(line: string): boolean {
  if (HEADING.test(line) || FENCE.test(line)) return true;

  const item = ITEM.exec(line);
  if (!item || blank(line.slice(item[0].length))) return false;
  return item[3] === undefined || Number(item[3]) === 1;
}

function stripIndent(line: string, width: number): string {
  let index = 0;
  while (index < width && line[index] === " ") index++;
  return line.slice(index);
}

type Cursor = { lines: readonly string[]; at: number };

function fenced(cursor: Cursor, open: RegExpExecArray): Block {
  const [, indent = "", fence = ""] = open;
  const body: string[] = [];
  cursor.at++;

  while (cursor.at < cursor.lines.length && !fenceEnd(cursor.lines[cursor.at]!, fence))
    body.push(stripIndent(cursor.lines[cursor.at++]!, indent.length));

  cursor.at++;
  return { kind: "code", text: body.join("\n") };
}

function indentedCode(cursor: Cursor): Block {
  const body: string[] = [];
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at]!;
    if (!blank(line) && !INDENTED.test(line)) break;

    body.push(line.startsWith("\t") ? line.slice(1) : line.slice(4));
    cursor.at++;
  }

  while (body.length > 0 && blank(body.at(-1)!)) body.pop();
  return { kind: "code", text: body.join("\n") };
}

function listItem(cursor: Cursor, open: RegExpExecArray, depth: number): Block[] {
  const width = open[4] === "" ? open[0].length + 1 : open[0].length;
  const body = [cursor.lines[cursor.at]!.slice(open[0].length)];
  cursor.at++;

  let gap = false;
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at]!;
    const indented = line.length - line.trimStart().length >= width;
    if (blank(line)) gap = true;
    else if (indented) gap = false;
    else if (gap || startsBlock(line)) break;

    body.push(indented ? stripIndent(line, width) : line);
    cursor.at++;
  }

  while (body.length > 0 && blank(body.at(-1)!)) body.pop();
  if (depth >= MAX_DEPTH) return [{ kind: "paragraph", text: body.join("\n") }];

  return parseBlocks(body, depth + 1);
}

function list(cursor: Cursor, first: RegExpExecArray, depth: number): Block {
  const ordered = first[3] !== undefined;
  const marker = first[2]!.slice(-1);
  const items: Block[][] = [];
  while (cursor.at < cursor.lines.length) {
    while (items.length > 0 && cursor.at < cursor.lines.length && blank(cursor.lines[cursor.at]!))
      cursor.at++;

    const open = ITEM.exec(cursor.lines[cursor.at] ?? "");
    if (!open || (open[3] !== undefined) !== ordered || open[2]!.slice(-1) !== marker) break;

    items.push(listItem(cursor, open, depth));
  }

  return { kind: "list", ordered, start: ordered ? Number(first[3]) : 1, items };
}

function paragraph(cursor: Cursor): Block {
  const body: string[] = [];
  while (cursor.at < cursor.lines.length) {
    const line = cursor.lines[cursor.at]!;
    if (blank(line) || (body.length > 0 && interrupts(line))) break;

    body.push(line.trim());
    cursor.at++;
  }

  return { kind: "paragraph", text: body.join("\n") };
}

function frontmatter(cursor: Cursor): Block | undefined {
  if (cursor.lines[0] !== "---") return undefined;

  const end = cursor.lines.indexOf("---", 1);
  if (end < 0) return undefined;

  cursor.at = end + 1;
  return { kind: "front", text: cursor.lines.slice(0, end + 1).join("\n") };
}

function parseBlocks(lines: readonly string[], depth = 0): Block[] {
  const cursor: Cursor = { lines, at: 0 };
  const blocks: Block[] = [];
  while (cursor.at < lines.length) {
    const line = lines[cursor.at]!;
    if (blank(line)) {
      cursor.at++;
      continue;
    }

    const heading = headingOf(line);
    const fence = FENCE.exec(line);
    const item = ITEM.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", ...heading });
      cursor.at++;
    } else if (fence) blocks.push(fenced(cursor, fence));
    else if (INDENTED.test(line)) blocks.push(indentedCode(cursor));
    else if (item) blocks.push(list(cursor, item, depth));
    else blocks.push(paragraph(cursor));
  }

  return blocks;
}

export function parseMarkdown(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const cursor: Cursor = { lines, at: 0 };
  const front = frontmatter(cursor);
  const rest = parseBlocks(lines.slice(cursor.at));
  return front ? [front, ...rest] : rest;
}

function closingCode(text: string, from: number, run: number): number {
  let at = from;
  while (at < text.length) {
    const found = text.indexOf("`".repeat(run), at);
    if (found < 0) return -1;

    let end = found + run;
    while (text[end] === "`") end++;
    if (end - found === run) return found;

    at = end;
  }

  return -1;
}

function opens(text: string, at: number, run: number): boolean {
  const before = text[at - 1] ?? " ";
  const after = text[at + run] ?? " ";
  if (/\s/.test(after)) return false;
  return text[at] === "*" || !WORD.test(before);
}

function closes(text: string, at: number, run: number): boolean {
  const before = text[at - 1] ?? " ";
  const after = text[at + run] ?? " ";
  if (/\s/.test(before)) return false;
  return text[at] === "*" || !WORD.test(after);
}

function codeSpanEnd(text: string, at: number): number {
  let run = 1;
  while (text[at + run] === "`") run++;

  const close = closingCode(text, at + run, run);
  return close < 0 ? at + run : close + run;
}

function closingDelimiter(text: string, from: number, delimiter: string): number {
  let at = from;
  while (at < text.length) {
    if (text[at] === "\\") {
      at += 2;
      continue;
    }

    if (text[at] === "`") {
      at = codeSpanEnd(text, at);
      continue;
    }

    const whole = text[at - 1] !== delimiter[0] && text[at + delimiter.length] !== delimiter[0];
    if (text.startsWith(delimiter, at) && whole && closes(text, at, delimiter.length)) return at;

    at++;
  }

  return -1;
}

function linkAt(
  text: string,
  at: number,
): { label: string; href: string; end: number } | undefined {
  let depth = 0;
  let close = -1;
  for (let index = at; index < text.length; index++)
    if (text[index] === "\\") index++;
    else if (text[index] === "[") depth++;
    else if (text[index] === "]" && --depth === 0) {
      close = index;
      break;
    }

  if (close < 0 || text[close + 1] !== "(") return undefined;

  let end = -1;
  let open = 0;
  for (let index = close + 2; index < text.length && end < 0; index++)
    if (text[index] === "\\") index++;
    else if (text[index] === "(") open++;
    else if (text[index] === ")" && open-- === 0) end = index;

  if (end < 0) return undefined;

  return {
    label: text.slice(at + 1, close),
    href: text.slice(close + 2, end).trim(),
    end: end + 1,
  };
}

function linkable(href: string): boolean {
  if (href === "" || /\s/.test(href)) return false;

  try {
    return LINK_SCHEMES.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

export function parseInline(text: string, links = true): Inline[] {
  const nodes: Inline[] = [];
  const unclosed = new Set<string>();
  const lastBracket = text.lastIndexOf("]");
  let plain = "";
  const flush = () => {
    if (plain !== "") nodes.push({ kind: "text", text: plain });
    plain = "";
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at]!;
    if (char === "\\" && PUNCTUATION.test(text[at + 1] ?? "")) {
      plain += text[at + 1];
      at += 2;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (text[at + run] === "`") run++;

      const close = closingCode(text, at + run, run);
      if (close < 0) {
        plain += "`".repeat(run);
        at += run;
        continue;
      }

      const inner = text.slice(at + run, close).replace(/\n/g, " ");
      const trimmed = /^ .* $/.test(inner) && inner.trim() !== "" ? inner.slice(1, -1) : inner;

      flush();
      nodes.push({ kind: "code", text: trimmed });
      at = close + run;
      continue;
    }

    if (char === "!" && text[at + 1] === "[") {
      const image = at < lastBracket ? linkAt(text, at + 1) : undefined;
      const end = image ? image.end : at + 2;
      plain += text.slice(at, end);
      at = end;
      continue;
    }

    if (char === "[") {
      const link = at < lastBracket ? linkAt(text, at) : undefined;
      if (link && links && linkable(link.href)) {
        flush();
        nodes.push({ kind: "link", href: link.href, children: parseInline(link.label, false) });
        at = link.end;
        continue;
      }

      const end = link ? link.end : at + 1;
      plain += text.slice(at, end);
      at = end;
      continue;
    }

    if (char === "*" || char === "_") {
      const double = text[at + 1] === char ? 2 : 1;
      const delimiter = char.repeat(double);
      const searched = opens(text, at, double) && !unclosed.has(delimiter);
      const close = searched ? closingDelimiter(text, at + double + 1, delimiter) : -1;
      if (searched && close < 0) unclosed.add(delimiter);

      if (close > at + double) {
        flush();
        const children = parseInline(text.slice(at + double, close), links);
        nodes.push(double === 2 ? { kind: "strong", children } : { kind: "em", children });
        at = close + double;
        continue;
      }

      plain += delimiter;
      at += double;
      continue;
    }

    plain += char;
    at++;
  }

  flush();
  return nodes;
}

function renderInline(nodes: readonly Inline[]): ReactNode[] {
  return nodes.map((node, index) => {
    if (node.kind === "text") return node.text;
    if (node.kind === "code")
      return (
        <code key={index} className="rounded bg-surface px-1 font-mono text-[0.9em]">
          {node.text}
        </code>
      );

    if (node.kind === "em") return <em key={index}>{renderInline(node.children)}</em>;
    if (node.kind === "strong") return <strong key={index}>{renderInline(node.children)}</strong>;

    return (
      <a
        key={index}
        href={node.href}
        rel="noreferrer"
        className="underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
      >
        {renderInline(node.children)}
      </a>
    );
  });
}

const HEADING_CLASS = {
  1: "text-xl font-semibold",
  2: "text-lg font-semibold",
  3: "text-base font-semibold",
  4: "text-sm font-semibold",
  5: "text-sm font-medium",
  6: "text-sm font-medium text-ink-secondary",
} as const;

function renderBlock(block: Block, key: number): ReactNode {
  if (block.kind === "heading") {
    const Tag = `h${block.level}` as const;
    return (
      <Tag key={key} className={HEADING_CLASS[block.level]}>
        {renderInline(parseInline(block.text))}
      </Tag>
    );
  }

  if (block.kind === "paragraph") return <p key={key}>{renderInline(parseInline(block.text))}</p>;

  if (block.kind === "front" || block.kind === "code")
    return (
      <pre
        key={key}
        data-block={block.kind}
        className="overflow-x-auto rounded border border-hairline bg-surface p-3 font-mono text-sm"
      >
        <code>{block.text}</code>
      </pre>
    );

  const items = block.items.map((item, index) => (
    <li key={index} className="pl-1 [&>*+*]:mt-2">
      {item.map(renderBlock)}
    </li>
  ));

  return block.ordered ? (
    <ol key={key} start={block.start} className="flex list-decimal flex-col gap-1 pl-6">
      {items}
    </ol>
  ) : (
    <ul key={key} className="flex list-disc flex-col gap-1 pl-6">
      {items}
    </ul>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text).map(renderBlock), [text]);
  return <div className="flex max-w-prose flex-col gap-3 leading-relaxed">{blocks}</div>;
}
