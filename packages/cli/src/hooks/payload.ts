import { basename, joinPath } from "./text.ts";

export const GUARDED = ["apply_patch", "Bash", "Edit", "Write", "MultiEdit"] as const;
export const MATCHERS = {
  claude: "^(Edit|MultiEdit|Write)$",
  codex: "^(Bash|apply_patch)$",
} as const;

export function unguarded(tool: string | undefined): string {
  return `${tool || "an unnamed tool"} reached this hook, which covers only ${GUARDED.join(", ")}, and gave it no file path to read. Nothing was scanned. Narrow the PostToolUse matcher to ${MATCHERS.claude} in Claude Code or ${MATCHERS.codex} in Codex so an uncovered tool cannot pass unguarded.`;
}

type Hunk = { old: string; new: string };
type PatchFile = { path: string; hunks: Hunk[] };
type Row = [string, string];
export type Edit = {
  path: string;
  old: string | undefined;
  new: string;
  mode: "patch" | "edit" | "write";
  everywhere?: boolean;
};

function hunk(rows: Row[]): Hunk {
  while (rows.length && rows[0]![0] === " " && rows[0]![1] === "") rows.shift();
  while (rows.length && rows.at(-1)![0] === " " && rows.at(-1)![1] === "") rows.pop();

  return {
    old: rows
      .filter(([kind]) => kind !== "+")
      .map(([, text]) => text)
      .join("\n"),
    new: rows
      .filter(([kind]) => kind !== "-")
      .map(([, text]) => text)
      .join("\n"),
  };
}

export function patchFiles(command: string, cwd = ""): PatchFile[] {
  const out: PatchFile[] = [];
  let current: PatchFile | undefined;
  let movable = false;
  let rows: Row[] = [];
  const close = () => {
    if (current && rows.some(([kind]) => kind !== " ")) current.hunks.push(hunk(rows));
    rows = [];
  };

  for (const line of (command || "").split("\n")) {
    if (line === "*** End Patch") break;

    const header = /^\*\*\* (Add File|Update File|Delete File): ([^\n]+)$/.exec(line);
    if (header) {
      close();
      current =
        header[1] === "Delete File" ? undefined : { path: joinPath(cwd, header[2]!), hunks: [] };

      if (current) out.push(current);
      movable = header[1] === "Update File";
      continue;
    }

    const move = movable && /^\*\*\* Move to: ([^\n]+)$/.exec(line);
    movable = false;
    if (current && move) current.path = joinPath(cwd, move[1]!);
    if (!current || line.startsWith("*** ")) continue;

    if (line.startsWith("@@")) close();
    else if (line.startsWith("+") || line.startsWith("-")) rows.push([line[0]!, line.slice(1)]);
    else if (line === "" || line.startsWith(" ")) rows.push([" ", line.slice(1)]);
  }

  close();

  return out;
}

const SESSION = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
export function sessionOf(data: Record<string, unknown>): string | undefined {
  return typeof data.session_id === "string" && SESSION.test(data.session_id)
    ? data.session_id
    : undefined;
}

export function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function shellScript(value: unknown): string {
  if (!Array.isArray(value)) return string(value);
  const argv = value.filter((item): item is string => typeof item === "string");
  return argv.length >= 3 && /^-\w*c$/.test(argv[1]!) ? argv[2]! : argv.join(" ");
}

const INVOCATION =
  /(?:(?:^|&&|\|\||[;&|({]|\b(?:then|do|else)\b)\s*|['"])(?:[^\s;&|({'"]*\/)?(?:apply_patch|applypatch)\s*(?:<<(-?)\s*\\?(['"]?)([^\s'"<>;&|()\\]+)\2|(['"])\*\*\* Begin Patch)/g;

const HEREDOC = /(?<!<)<<(?!<)(-?)\s*(?:'([^']+)'|"([^"]+)"|(\\?)([^\s'"<>;&|()\\]+))/g;

const TARGET = /(?:>>?|\btee(?:\s+-\w+)*)\s*(['"]?)([^\s'";&|<>()]+)\1/;

const INERT =
  /((?<!<)<<(?!<)-?\s*\\?(?:'[^']*'|"[^"]*"))|'[^']*'|"(?:\\.|[^"\\])*"|(?<![^\s;&|(){}])#.*$/g;

const CONTINUED = /(?<!\\)(?:\\\\)*\\$/;

function inert(line: string): string {
  return line.replace(INERT, (text, delimiter?: string) => delimiter ?? " ".repeat(text.length));
}

const OWNER = /(?:^|[;&|({]|\b(?:then|do|else)\b)\s*([^\s;&|(){}]+)[^;&|(){}]*$/;

const SCRIPT_SIGN = /(?:^|[\s;&|(){}/'"])(?:(?:ba|z|da|k|fi)?sh|eval)(?=$|[\s;&|()'"])|[|({]/;

const SOURCED = /(?:^|[;&|({]|\b(?:then|do|else)\b)\s*(?:source|\.)\s/;

const DIRECTORY_STEP =
  /(\()|(\))|(?<![^\s;&|({])cd\s+(?:(['"])([^'"]*)\3|([^\s'";&|()]+))\s*(?=&&|;|\)|$)/g;

type Shell = { directory: string; saved: string[] };

function changeDirectory(prefix: string, shell: Shell): void {
  for (const step of prefix.matchAll(DIRECTORY_STEP))
    if (step[1]) shell.saved.push(shell.directory);
    else if (step[2]) shell.directory = shell.saved.pop() ?? shell.directory;
    else shell.directory = joinPath(shell.directory, step[4] ?? step[5]!);
}

type Heredoc = {
  at: number;
  kind: "patch" | "script" | "source" | "data";
  strip: boolean;
  delimiter: string;
  target?: string;
};

type Opener = Heredoc | { at: number; kind: "argument" };

function reader(line: string, shown: string, at: number, quoted: boolean): Heredoc["kind"] {
  if (SOURCED.test(shown)) return "source";

  const owner = basename(OWNER.exec(shown.slice(0, at))?.[1] ?? "");
  const last = !/[;&|]/.test(shown.slice(at)) && !SCRIPT_SIGN.test(line);
  return (owner === "cat" || owner === "tee") && quoted && last ? "data" : "script";
}

function openers(line: string): Opener[] {
  const patches: Opener[] = [...line.matchAll(INVOCATION)].map((found) =>
    found[4]
      ? { at: found.index, kind: "argument" }
      : {
          at: found.index + found[0].lastIndexOf("<<"),
          kind: "patch",
          strip: found[1] === "-",
          delimiter: found[3]!,
        },
  );

  const shown = inert(line);
  const others: Opener[] = [...shown.matchAll(HEREDOC)]
    .filter((found) => !patches.some((patch) => patch.at === found.index))
    .map((found) => ({
      at: found.index,
      kind: reader(line, shown, found.index, found[5] === undefined || found[4] === "\\"),
      strip: found[1] === "-",
      delimiter: found[2] ?? found[3] ?? found[5]!,
      target: basename(TARGET.exec(line)?.[2] ?? ""),
    }));

  return [...patches, ...others].sort((left, right) => left.at - right.at);
}

function terminator(lines: string[], from: number, strip: boolean, delimiter: string) {
  for (let index = from; index < lines.length; index++)
    if ((strip ? lines[index]!.replace(/^\t+/, "") : lines[index]) === delimiter) return index;

  return undefined;
}

function shellPatches(script: string, shell: Shell): PatchFile[] {
  const lines = script.split("\n");
  const files: PatchFile[] = [];
  for (let index = 0; index < lines.length; index++) {
    const first = index;

    let line = lines[index]!;
    while (CONTINUED.test(inert(line)) && index + 1 < lines.length)
      line = line.slice(0, -1) + lines[++index];

    const heredocs: (Heredoc & { directory: string })[] = [];

    let from = 0;
    for (const opener of openers(line)) {
      changeDirectory(line.slice(from, opener.at), shell);
      from = opener.at;

      if (opener.kind !== "argument") heredocs.push({ ...opener, directory: shell.directory });
      else {
        const start = lines.slice(0, first).join("\n").length + opener.at;
        const patch = script.indexOf("*** Begin Patch", start);
        files.push(...patchFiles(script.slice(patch), shell.directory));
      }
    }

    changeDirectory(line.slice(from), shell);

    for (const heredoc of heredocs) {
      const end = terminator(lines, index + 1, heredoc.strip, heredoc.delimiter);
      if (end === undefined && heredoc.kind !== "patch") continue;

      const body = lines.slice(index + 1, end).join("\n");
      const run =
        Boolean(heredoc.target) &&
        lines.slice(end! + 1).some((later) => later.includes(heredoc.target!));

      const kind = heredoc.kind === "data" && run ? "script" : heredoc.kind;
      index = end ?? lines.length;

      if (kind === "patch") files.push(...patchFiles(body, heredoc.directory));
      else if (kind === "source") files.push(...shellPatches(body, shell));
      else if (kind === "script")
        files.push(...shellPatches(body, { directory: heredoc.directory, saved: [] }));
    }
  }

  return files;
}

export function parsePayload(payload: Record<string, unknown>): {
  paths: string[];
  edits: Edit[];
  reason?: string;
} {
  const input = object(payload.tool_input) ?? {};
  const tool = string(payload.tool_name);
  if (tool === "apply_patch" || tool === "Bash") {
    const cwd = joinPath(string(payload.cwd), string(input.workdir));
    const files =
      tool === "apply_patch"
        ? patchFiles(string(input.command), cwd)
        : shellPatches(shellScript(input.command), { directory: cwd, saved: [] });

    return {
      paths: files.map((file) => file.path),
      edits: files.flatMap((file) =>
        file.hunks.map((part) => ({ path: file.path, ...part, mode: "patch" as const })),
      ),
    };
  }

  const path = string(input.file_path);
  if (!(GUARDED as readonly string[]).includes(tool) && !path)
    return { paths: [], edits: [], reason: unguarded(tool) };

  const edit: Edit =
    tool === "Edit"
      ? {
          path,
          old: string(input.old_string),
          new: string(input.new_string),
          mode: "edit",
          everywhere: input.replace_all === true,
        }
      : { path, old: undefined, new: string(input.content), mode: "write" };

  return { paths: [path], edits: [edit] };
}
