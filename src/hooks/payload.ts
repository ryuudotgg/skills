import { joinPath } from "./python-text.ts";

export const WRITE_LIKE = ["Write", "MultiEdit"] as const;
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
  /(?:(?:^|&&|\|\||[;&|({]|\b(?:then|do|else)\b)\s*|['"])(?:[^\s;&|({'"]*\/)?(?:apply_patch|applypatch)\s*(?:<<(-?)\s*\\?(['"]?)([^\s'"<>;&|()\\]+)\2|(['"])\*\*\* Begin Patch)/;
const DIRECTORY_STEP =
  /(\()|(\))|(?<![^\s;&|({])cd\s+(?:(['"])([^'"]*)\3|([^\s'";&|()]+))\s*(?=&&|;|\)|$)/g;

type Shell = { directory: string; saved: string[] };

function changeDirectory(prefix: string, shell: Shell): void {
  for (const step of prefix.matchAll(DIRECTORY_STEP))
    if (step[1]) shell.saved.push(shell.directory);
    else if (step[2]) shell.directory = shell.saved.pop() ?? shell.directory;
    else shell.directory = joinPath(shell.directory, step[4] ?? step[5]!);
}

function shellPatches(script: string, cwd: string): PatchFile[] {
  const lines = script.split("\n");
  const files: PatchFile[] = [];

  const shell: Shell = { directory: cwd, saved: [] };
  for (let index = 0; index < lines.length; index++) {
    const found = INVOCATION.exec(lines[index]!);
    changeDirectory(found ? lines[index]!.slice(0, found.index) : lines[index]!, shell);
    const directory = shell.directory;

    if (!found) continue;

    if (found[4]) {
      const start = script.indexOf("*** Begin Patch", lines.slice(0, index).join("\n").length);
      files.push(...patchFiles(script.slice(start), directory));
      continue;
    }

    const body: string[] = [];
    for (index++; index < lines.length; index++) {
      const line = lines[index]!;
      if ((found[1] ? line.replace(/^\t+/, "") : line) === found[3]) break;
      body.push(line);
    }

    files.push(...patchFiles(body.join("\n"), directory));
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
        : shellPatches(shellScript(input.command), cwd);

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
