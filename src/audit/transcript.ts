import type { RecordObject } from "../sessions/jsonl.ts";

export const word = "[\\p{L}\\p{N}_]";
export const boundary = `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;

export const codexArm = new RegExp(
  `(?<![\\p{L}\\p{N}_/-])codex(?:\\s+-[-\\p{L}\\p{N}_]+(?:=(?:"[^"]*"|'[^']*'|[^\\s]*)|\\s+(?:"[^"]*"|'[^']*'|[^\\s]+))?)*\\s+(?:exec|review)${boundary}`,
  "u",
);

export function toolName(block: RecordObject): string {
  if (typeof block.name !== "string") return "unknown";

  return block.name.startsWith("mcp__")
    ? block.name.slice(block.name.lastIndexOf("__") + 2)
    : block.name;
}
