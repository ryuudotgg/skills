export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.NO_COLOR && env.TERM !== "dumb";
}

export function painter(on: boolean) {
  const style = (open: number, close: number) => (text: string) =>
    on && text ? `\u001b[${open}m${text}\u001b[${close}m` : text;

  return {
    bold: style(1, 22),
    dim: style(2, 22),
    green: style(32, 39),
    yellow: style(33, 39),
    cyan: style(36, 39),
  };
}

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];

  let line = "";
  for (const word of text.split(" "))
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;

  lines.push(line);
  return lines;
}

export function tilde(home: string): (text: string) => string {
  if (!home || home === "/") return (text) => text;

  const pattern = new RegExp(
    `(?<![^\\s("'=:,])${home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/`,
    "g",
  );

  return (text) => text.replace(pattern, "~/");
}
