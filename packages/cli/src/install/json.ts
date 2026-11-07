export class JsonNumber {
  constructor(readonly text: string) {}
}

export type Json = null | boolean | string | JsonNumber | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

const keyOrder = new WeakMap<JsonObject, string[]>();

function quote(value: string): string {
  return JSON.stringify(value).replace(
    /(\\+)(u[dD][89a-fA-F][0-9a-fA-F]{2})/g,
    (match, slashes: string, escape: string) =>
      slashes.length % 2
        ? `${slashes.slice(1)}${String.fromCharCode(Number.parseInt(escape.slice(1), 16))}`
        : match,
  );
}

export function object(value: Json | undefined): JsonObject | undefined {
  return value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof JsonNumber)
    ? value
    : undefined;
}

export function parseJson(text: string): Json {
  let offset = 0;
  const invalid = (message: string, position = offset): never => {
    const before = text.slice(0, position);
    const line = before.split("\n").length;
    const column = Array.from(before.slice(before.lastIndexOf("\n") + 1)).length + 1;
    const char = Array.from(before).length;

    throw new Error(`invalid JSON: ${message}: line ${line} column ${column} (char ${char})`);
  };

  const space = () => {
    while (/[ \t\r\n]/.test(text[offset] ?? "x")) offset++;
  };

  const string = (): string => {
    const start = offset++;
    while (offset < text.length) {
      const current = text[offset++]!;
      if (current === '"') {
        try {
          return JSON.parse(text.slice(start, offset));
        } catch {
          return invalid("Invalid \\escape", offset - 2);
        }
      }

      if (current.charCodeAt(0) < 32) invalid("Invalid control character at", offset - 1);
      if (current === "\\") offset++;
    }

    return invalid("Unterminated string starting at", start);
  };

  const value = (depth: number): Json => {
    if (depth > 980) throw new Error("nested too deeply to parse");

    space();

    const current = text[offset];
    if (current === '"') return string();
    if (current === "{" || current === "[") {
      const closing = current === "{" ? "}" : "]";
      const result: JsonObject | Json[] = current === "{" ? Object.create(null) : [];
      if (!Array.isArray(result)) keyOrder.set(result, []);
      offset++;
      space();

      if (text[offset] === closing) {
        offset++;
        return result;
      }

      for (;;) {
        space();

        let key = "";
        if (!Array.isArray(result)) {
          if (text[offset] !== '"') invalid("Expecting property name enclosed in double quotes");
          key = string();
          space();
          if (text[offset++] !== ":") invalid("Expecting ':' delimiter", offset - 1);
        }

        const entry = value(depth + 1);
        if (Array.isArray(result)) result.push(entry);
        else {
          if (Object.hasOwn(result, key)) throw new Error(`duplicate key: ${key}`);
          result[key] = entry;
          keyOrder.get(result)!.push(key);
        }

        space();

        if (text[offset] === closing) {
          offset++;
          return result;
        }

        if (text[offset++] !== ",") invalid("Expecting ',' delimiter", offset - 1);
      }
    }

    for (const constant of ["NaN", "Infinity", "-Infinity"])
      if (text.startsWith(constant, offset)) throw new Error(`${constant} is not JSON`);

    for (const [token, result] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (text.startsWith(token, offset)) {
        offset += token.length;
        return result;
      }

    const token = text
      .slice(offset)
      .match(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/)?.[0];

    if (!token) return invalid("Expecting value");

    offset += token.length;

    return new JsonNumber(token);
  };

  const result = value(0);
  space();
  if (offset < text.length) invalid("Extra data");

  return result;
}

export function stringifyJson(value: Json, unit = "  ", depth = 0): string {
  if (value instanceof JsonNumber) return value.text;
  if (typeof value === "string") return quote(value);
  if (value === null || typeof value !== "object") return JSON.stringify(value);

  const indentation = unit.repeat(depth);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return `[\n${value.map((entry) => `${indentation}${unit}${stringifyJson(entry, unit, depth + 1)}`).join(",\n")}\n${indentation}]`;
  }

  const observed = (keyOrder.get(value) ?? []).filter((key) => Object.hasOwn(value, key));
  const keys = [...observed, ...Object.keys(value).filter((key) => !observed.includes(key))];
  const entries = keys.map((key) => [key, value[key]!] as const);
  if (!entries.length) return "{}";

  return `{\n${entries.map(([key, entry]) => `${indentation}${unit}${quote(key)}: ${stringifyJson(entry, unit, depth + 1)}`).join(",\n")}\n${indentation}}`;
}
