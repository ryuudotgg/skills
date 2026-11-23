import { object, toolName, type RecordObject } from "../sessions/jsonl.ts";

export const word = "[\\p{L}\\p{N}_]";
export const boundary = `(?:(?<=${word})(?!${word})|(?<!${word})(?=${word}))`;

export const spawnTools: ReadonlySet<string> = new Set(["Agent", "Task"]);
const readOnlySeats = new Set([
  "codex-reviewer",
  "comment-sicko",
  "Explore",
  "opus-review",
  "Plan",
]);

const implementationBlock = `The branch is already the right one: work on it as checked out and create none.
Leave every change unstaged. Run no git add, git commit, git push, gh, gt or any other stacking tool command. Create no worktree.
Use the package manager the lockfile names and add no competing lockfile.
Never kill, restart or hijack a process, server or database this run did not start.
Change only what this brief names. Where the brief is ambiguous against the file on disk, stop and report instead of guessing.
Intent lives in names, types and assertions, never in comments. The one comment that survives names an external constraint, a landmine, or why the obvious approach lost.
No em dash, en dash or hyphen used as a dash, in code, strings or copy.
Where it is unclear where something lands (which surface, which tab, public or private, who can see it), stop and say so.
Never write to production data.`;

export type ArmModel = { kind: "unknown" } | { kind: "model"; model: string };
type Delegate = { kind: "spawn" } | ArmModel;

type Input = { body: string };
type SimpleCommand = { words: string[]; stdin: Input | undefined };
type Redirect = "file" | "heredoc" | "tabbed heredoc";
type Heredoc = { delimiter: string; tabbed: boolean; input: Input };

function afterHeredocs(text: string, newline: number, pending: readonly Heredoc[]): number {
  let index = newline;
  for (const { delimiter, tabbed, input } of pending) {
    const body: string[] = [];
    while (index < text.length) {
      const end = text.indexOf("\n", index + 1);
      const stop = end === -1 ? text.length : end;
      const line = text.slice(index + 1, stop);
      const stripped = tabbed ? line.replace(/^\t+/u, "") : line;

      index = stop;
      if (stripped === delimiter) break;

      body.push(stripped);
    }

    input.body = body.join("\n");
  }

  return index;
}

function simpleCommands(text: string): SimpleCommand[] {
  const commands: SimpleCommand[] = [];
  const pending: Heredoc[] = [];

  let command: SimpleCommand = { words: [], stdin: undefined };
  let heredoc: Input = { body: "" };
  let current: string | null = null;
  let quote: string | null = null;
  let redirect: Redirect | null = null;

  const endWord = () => {
    if (current === null) return;

    if (redirect === null) command.words.push(current);
    else if (redirect !== "file")
      pending.push({ delimiter: current, tabbed: redirect === "tabbed heredoc", input: heredoc });

    current = null;
    redirect = null;
  };

  const endCommand = () => {
    endWord();
    if (command.words.length) commands.push(command);

    command = { words: [], stdin: undefined };
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
      const descriptor = current !== null && /^\d+$/u.test(current) ? current : undefined;
      const readsStdin = descriptor === undefined ? character === "<" : Number(descriptor) === 0;

      if (descriptor !== undefined) current = null;
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

      heredoc = { body: "" };
      if (readsStdin) command.stdin = redirect === "file" ? undefined : heredoc;
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

const codexValueOptions = new Set([
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
const alarmScript = "alarm shift; exec @ARGV";
const opencodeValueOptions = new Set(["-m", "--model", "--format"]);

type Head = { program: string; assignments: readonly string[]; args: readonly string[] };
type CodexInvocation = {
  subcommand: string | undefined;
  sandbox: string | undefined;
  model: string | undefined;
};

function commandHead(words: readonly string[]): Head | undefined {
  const assignments: string[] = [];

  let index = 0;
  while (index < words.length) {
    const head = words[index++]!;
    if (keywords.has(head)) continue;

    if (assignment.test(head)) {
      assignments.push(head);
      continue;
    }

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

  const program = words[index];
  return program === undefined ? undefined : { program, assignments, args: words.slice(index + 1) };
}

function withoutAlarm(head: Head | undefined): Head | undefined {
  if (head?.program !== "perl" || head.args[0] !== "-e" || head.args[1] !== alarmScript)
    return head;

  const inner = commandHead(head.args.slice(3));
  return inner && { ...inner, assignments: [...head.assignments, ...inner.assignments] };
}

function codexInvocation(words: readonly string[]): CodexInvocation | undefined {
  const head = commandHead(words);
  if (head?.program !== "codex") return;

  const { args } = head;

  let subcommand: string | undefined;
  let sandbox: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const option = args[index]!;
    const value = args[index + 1];
    if (option === "-s" || option === "--sandbox") sandbox = value;
    else if (option.startsWith("--sandbox=")) sandbox = option.slice("--sandbox=".length);
    else if (option === "-m" || option === "--model") model = value;
    else if (option.startsWith("--model=")) model = option.slice("--model=".length);
    else if ((option === "-c" || option === "--config") && value?.startsWith("model="))
      model = value.slice("model=".length).replace(/^(["'])(.*)\1$/u, "$2");

    if (codexValueOptions.has(option)) index++;
    else if (!option.startsWith("-")) subcommand ??= option;
  }

  return { subcommand, sandbox, model };
}

function armModel(model: string | undefined): ArmModel {
  return model === undefined ? { kind: "unknown" } : { kind: "model", model };
}

function codexWriteArm({ words }: SimpleCommand): ArmModel | undefined {
  const codex = codexInvocation(words);
  return codex?.subcommand === "exec" && codex.sandbox === "workspace-write"
    ? armModel(codex.model)
    : undefined;
}

function endsWithImplementationBlock(prompt: string): boolean {
  const text = prompt.replace(/\n+$/u, "");
  return text === implementationBlock || text.endsWith(`\n${implementationBlock}`);
}

function opencodeWriteArm({ words, stdin }: SimpleCommand): ArmModel | undefined {
  const head = withoutAlarm(commandHead(words));
  const prompt = stdin?.body;
  if (
    head?.program !== "opencode" ||
    head.assignments.includes("AGENT_HOOKS=0") ||
    prompt === undefined ||
    !endsWithImplementationBlock(prompt)
  )
    return;

  const { args } = head;

  let subcommand: string | undefined;
  let model: string | undefined;
  for (let index = 0; index < args.length && args[index] !== "--"; index++) {
    const option = args[index]!;
    if (option === "-m" || option === "--model") model = args[index + 1];
    else if (option.startsWith("--model=")) model = option.slice("--model=".length);

    if (opencodeValueOptions.has(option)) index++;
    else if (!option.startsWith("-")) subcommand ??= option;
  }

  return subcommand === "run" ? armModel(model) : undefined;
}

function shellWriteArm(command: string): ArmModel | undefined {
  return simpleCommands(command)
    .flatMap((simple) => codexWriteArm(simple) ?? opencodeWriteArm(simple) ?? [])
    .at(-1);
}

export function runsCodexArm(command: string): boolean {
  return simpleCommands(command).some(({ words }) => {
    const subcommand = codexInvocation(words)?.subcommand;
    return subcommand === "exec" || subcommand === "review";
  });
}

export function implementationDelegate(block: RecordObject): Delegate | undefined {
  if (block.type !== "tool_use" || !object(block.input)) return;

  const input = block.input;
  const name = toolName(block);
  if (name === "Bash")
    return typeof input.command === "string" ? shellWriteArm(input.command) : undefined;

  if (name === "delegate_task")
    return [input.title, input.clientRequestId].some(
      (value) => typeof value === "string" && value.endsWith("-impl"),
    )
      ? armModel(
          object(input.target) && typeof input.target.model === "string"
            ? input.target.model
            : undefined,
        )
      : undefined;

  if (
    !spawnTools.has(name) ||
    (typeof input.subagent_type === "string" && readOnlySeats.has(input.subagent_type))
  )
    return;

  return /[Ii]mplement/u.test(JSON.stringify(input)) ? { kind: "spawn" } : undefined;
}
