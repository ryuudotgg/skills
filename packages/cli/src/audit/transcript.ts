export const word = "[\\p{L}\\p{N}_]";
export const boundary = `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;

export const codexArm = new RegExp(
  `(?<![\\p{L}\\p{N}_/-])codex(?:\\s+-[-\\p{L}\\p{N}_]+(?:=(?:"[^"]*"|'[^']*'|[^\\s]*)|\\s+(?:"[^"]*"|'[^']*'|[^\\s]+))?)*\\s+(?:exec|review)${boundary}`,
  "u",
);
