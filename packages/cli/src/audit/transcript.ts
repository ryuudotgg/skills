export const word = "[\\p{L}\\p{N}_]";
export const boundary = `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;

export const codexArm = new RegExp(
  `(?<![\\p{L}\\p{N}_/-])codex(?:\\s+-[-\\p{L}\\p{N}_]+(?:=(?:"[^"]*"|'[^']*'|[^\\s]*)|\\s+(?:"[^"]*"|'[^']*'|[^\\s]+))?)*\\s+(?:exec|review)${boundary}`,
  "u",
);

type Redirect = "file" | "heredoc" | "tabbed heredoc";
type Heredoc = { delimiter: string; tabbed: boolean };

function afterHeredocs(text: string, newline: number, pending: readonly Heredoc[]): number {
  let index = newline;
  for (const { delimiter, tabbed } of pending)
    while (index < text.length) {
      const end = text.indexOf("\n", index + 1);
      const stop = end === -1 ? text.length : end;
      const line = text.slice(index + 1, stop);
      index = stop;
      if ((tabbed ? line.replace(/^\t+/u, "") : line) === delimiter) break;
    }

  return index;
}

function simpleCommands(text: string): string[][] {
  const commands: string[][] = [];
  const pending: Heredoc[] = [];

  let words: string[] = [];
  let current: string | null = null;
  let quote: string | null = null;
  let redirect: Redirect | null = null;

  const endWord = () => {
    if (current === null) return;

    if (redirect === null) words.push(current);
    else if (redirect !== "file")
      pending.push({ delimiter: current, tabbed: redirect === "tabbed heredoc" });

    current = null;
    redirect = null;
  };

  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);

    words = [];
    redirect = null;
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote !== null)
      if (character === quote) quote = null;
      else if (quote === '"' && character === "\\" && index + 1 < text.length)
        current += text[++index]!;
      else current += character;
    else if (character === "'" || character === '"') {
      quote = character;
      current ??= "";
    } else if (character === "\\") {
      const next = text[++index];
      if (next !== undefined && next !== "\n") current = (current ?? "") + next;
    } else if (character === "#" && current === null)
      while (index + 1 < text.length && text[index + 1] !== "\n") index++;
    else if (character === "<" || character === ">") {
      if (current !== null && /^\d+$/u.test(current)) current = null;
      else endWord();

      if (text.startsWith("<<<", index)) {
        redirect = "file";
        index += 2;
      } else if (text.startsWith("<<", index)) {
        redirect = text[index + 2] === "-" ? "tabbed heredoc" : "heredoc";
        index += redirect === "heredoc" ? 1 : 2;
      } else {
        redirect = "file";
        if ("<>&|".includes(text[index + 1] ?? "")) index++;
      }
    } else if (character === "\n") {
      endCommand();
      index = afterHeredocs(text, index, pending.splice(0));
    } else if (";|&()".includes(character)) endCommand();
    else if (/\s/u.test(character)) endWord();
    else current = (current ?? "") + character;
  }

  endCommand();
  return commands;
}

const valueOptions = new Set([
  "-a",
  "--add-dir",
  "--ask-for-approval",
  "-C",
  "-c",
  "--cd",
  "--color",
  "--config",
  "--cyber-access-program",
  "--disable",
  "--enable",
  "-i",
  "--image",
  "--local-provider",
  "-m",
  "--model",
  "-o",
  "--output-last-message",
  "--output-schema",
  "-p",
  "--profile",
  "--remote",
  "--remote-auth-token-env",
  "-s",
  "--sandbox",
  "--thread-source",
]);

const wrapperValues = new Map([
  ["command", new Set<string>()],
  ["env", new Set(["-C", "--chdir", "-u", "--unset"])],
  ["exec", new Set(["-a"])],
  ["nohup", new Set<string>()],
  ["time", new Set<string>()],
  ["timeout", new Set(["-k", "--kill-after", "-s", "--signal"])],
]);

const keywords = new Set(["!", "{", "do", "elif", "else", "if", "then", "until", "while"]);
const lookup = /^-[A-Za-z]*[vV]/u;
const assignment = /^[A-Za-z_][A-Za-z0-9_]*=/u;

type CodexInvocation = { subcommand: string | undefined; sandbox: string | undefined };

function codexInvocation(words: readonly string[]): CodexInvocation | undefined {
  let index = 0;
  while (index < words.length) {
    const head = words[index++]!;
    if (keywords.has(head) || assignment.test(head)) continue;

    const values = wrapperValues.get(head);
    if (values === undefined) {
      index--;
      break;
    }

    for (; words[index]?.startsWith("-"); index++) {
      if (head === "command" && lookup.test(words[index]!)) return;
      if (values.has(words[index]!)) index++;
    }

    if (head === "timeout") index++;
  }

  if (words[index] !== "codex") return;

  let subcommand: string | undefined;
  let sandbox: string | undefined;
  for (index++; index < words.length && words[index] !== "--"; index++) {
    const option = words[index]!;
    if (option === "-s" || option === "--sandbox") sandbox = words[index + 1];
    else if (option.startsWith("--sandbox=")) sandbox = option.slice("--sandbox=".length);

    if (valueOptions.has(option)) index++;
    else if (!option.startsWith("-")) subcommand ??= option;
  }

  return { subcommand, sandbox };
}

function codexInvocations(command: string): CodexInvocation[] {
  return simpleCommands(command).flatMap((words) => codexInvocation(words) ?? []);
}

export function runsCodexArm(command: string): boolean {
  return codexInvocations(command).some(
    ({ subcommand }) => subcommand === "exec" || subcommand === "review",
  );
}

export function writesThroughCodex(command: string): boolean {
  return codexInvocations(command).some(
    ({ subcommand, sandbox }) => subcommand === "exec" && sandbox === "workspace-write",
  );
}
