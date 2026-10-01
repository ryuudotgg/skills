export function shlex(text: string): string[] {
  const tokens: string[] = [];

  let token = "";
  let started = false;
  let quote: "'" | '"' | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'")
      if (char === quote) quote = undefined;
      else token += char;
    else if (char === "\\") {
      const next = text[++index];
      if (next === undefined) throw new Error("No escaped character");

      token += quote && next !== '"' && next !== "\\" ? `\\${next}` : next;
      started = true;
    } else if (quote)
      if (char === quote) quote = undefined;
      else token += char;
    else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (" \t\r\n".includes(char)) {
      if (started) tokens.push(token);
      token = "";
      started = false;
    } else {
      token += char;
      started = true;
    }
  }

  if (quote) throw new Error("No closing quotation");
  if (started) tokens.push(token);

  return tokens;
}
