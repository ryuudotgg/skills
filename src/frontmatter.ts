export type Frontmatter =
  | { kind: "missing" }
  | { kind: "unclosed" }
  | { kind: "invalid"; message: string }
  | { kind: "not-mapping" }
  | { kind: "mapping"; data: Record<string, unknown>; lines: ReadonlyMap<string, number> };

const keyLine = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#'"[\]{}?<][^:]*?)[ \t]*:/;

export function readFrontmatter(text: string, parse: (yaml: string) => unknown): Frontmatter {
  const rows = text.split("\n").map((row) => row.replace(/\r$/, ""));
  if (rows[0] !== "---") return { kind: "missing" };

  const closing = rows.indexOf("---", 1);
  if (closing < 0) return { kind: "unclosed" };

  try {
    const data = parse(rows.slice(1, closing).join("\n"));
    if (data === null || typeof data !== "object" || Array.isArray(data)) return { kind: "not-mapping" };

    // Bun.YAML keeps the last of duplicate keys, so this refuses duplicates and every key form it cannot compare.
    const lines = new Map<string, number>();
    for (let index = 1; index < closing; index++) {
      const row = rows[index]!;
      if (!row || /^(?:[\s#]|-(?:\s|$))/.test(row)) continue;

      const match = keyLine.exec(row);
      if (!match) return { kind: "invalid", message: `line ${index + 1} is not a plain key` };

      const raw = match[1]!;
      const key = raw.startsWith('"') || raw.startsWith("'") ? String(parse(raw)) : raw.trimEnd();
      if (lines.has(key)) return { kind: "invalid", message: `duplicate key ${key}` };

      lines.set(key, index + 1);
    }

    return { kind: "mapping", data: data as Record<string, unknown>, lines };
  } catch (error) {
    return { kind: "invalid", message: error instanceof Error ? error.message : String(error) };
  }
}
