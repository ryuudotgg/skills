import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SPACE = "\\t\\n\\v\\f\\r\\x1c-\\x20\\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";

export const MESSAGE = new RegExp(
  `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^()${SPACE}]+\\))?!?: [^${SPACE}]([^\\n]*[^${SPACE}])?$`,
  "u",
);

export type MessageProblem = "multi line message" | "longer than 50 characters" | "no Conventional prefix";

export function messageProblem(value: string): MessageProblem | undefined {
  if (/[\r\n]/.test(value)) return "multi line message";
  if ([...value].length > 50) return "longer than 50 characters";
  if (!MESSAGE.test(value)) return "no Conventional prefix";

  return undefined;
}

export type ProcessResult = { code: number | undefined; output: string };
type RunOptions = { capture?: boolean; write?: boolean; timeout?: number; stderr?: "inherit" | "ignore" };
export type SelectedIndex = { paths: string[] } | { reason: string };

export async function run(cwd: string, argv: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  const timeout = options.write ? undefined : options.timeout ?? 10_000;
  try {
    const child = Bun.spawn([...argv], {
      cwd,
      stdin: "ignore",
      stdout: options.capture ? "pipe" : 2,
      stderr: options.stderr ?? "inherit",
      ...(timeout === undefined ? {} : { timeout, killSignal: "SIGTERM" }),
    });

    const reader = options.capture ? (child.stdout as ReadableStream<Uint8Array>).getReader() : undefined;
    const text = reader ? readAll(reader) : Promise.resolve("");
    const code = await child.exited;

    if (child.signalCode) {
      // A gh extension runs as a grandchild that keeps the pipe open after gh itself is killed.
      await reader?.cancel();
      return { code: undefined, output: "" };
    }

    return { code, output: await text };
  } catch {
    return { code: undefined, output: "" };
  }
}

async function readAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();

  let text = "";
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read())
    text += decoder.decode(chunk.value, { stream: true });

  return text + decoder.decode();
}

export function git(cwd: string, args: readonly string[], options: RunOptions = {}): Promise<ProcessResult> {
  return run(cwd, ["git", ...args], options);
}

export async function defaultBranch(cwd: string): Promise<string | undefined> {
  const result = await git(cwd, ["ls-remote", "--symref", "origin", "HEAD"], { capture: true, stderr: "ignore", timeout: 60_000 });
  if (result.code !== 0) return undefined;

  return result.output.split("\n").find((line) => line.split(/\s+/)[0] === "ref:")
    ?.split(/\s+/)[1]?.replace(/^refs\/heads\//, "");
}

export async function selectedIndex(cwd: string, files: readonly string[]): Promise<SelectedIndex> {
  const args = ["diff", "--cached", "--no-renames", "--name-only", "-z"];
  const staged = await git(cwd, args, { capture: true });
  if (staged.code !== 0) return { reason: "cannot read staged changes" };

  const selected = await git(cwd, [...args, "--", ...files], { capture: true });
  if (selected.code !== 0) return { reason: "cannot read staged changes" };

  const paths = staged.output.split("\0").filter(Boolean);
  const allowed = new Set(selected.output.split("\0").filter(Boolean));
  const outside = paths.find((path) => !allowed.has(path));
  return outside ? { reason: `already staged outside the file list: ${outside}` } : { paths };
}

export async function stageSelected(
  cwd: string,
  files: readonly string[],
  alsoAccept?: (path: string) => Promise<boolean>,
  index?: SelectedIndex,
): Promise<string | undefined> {
  const selection = index ?? await selectedIndex(cwd, files);
  if ("reason" in selection) return selection.reason;

  const remaining: string[] = [];
  for (const path of files) {
    if (existsSync(resolve(cwd, path))) {
      remaining.push(path);
      continue;
    }

    const tracked = await git(cwd, ["ls-files", "--error-unmatch", "-z", "--", path], { capture: true, stderr: "ignore" });
    if (tracked.code === 0) {
      remaining.push(path);
      continue;
    }

    if (tracked.code !== 1) return `cannot read tracked files: ${path}`;
    if (selection.paths.includes(path)) continue;
    if (!alsoAccept || !await alsoAccept(path)) return `no such file: ${path}`;
  }

  if (remaining.length && (await git(cwd, ["add", "--", ...remaining], { write: true })).code !== 0)
    return "git add failed";

  return undefined;
}

export async function stagedChanges(cwd: string): Promise<boolean | undefined> {
  const result = await git(cwd, ["diff", "--cached", "--no-renames", "--quiet"]);
  if (result.code === 0) return false;
  if (result.code === 1) return true;

  return undefined;
}

export async function commitStaged(cwd: string, message: string): Promise<boolean | string> {
  const staged = await stagedChanges(cwd);
  if (staged === undefined) return "cannot read staged changes";
  if (!staged) return false;

  const before = await git(cwd, ["rev-parse", "HEAD"], { capture: true });
  if (before.code !== 0) return "cannot read HEAD";
  if ((await git(cwd, ["commit", "--quiet", "-m", message], { write: true })).code !== 0) return "git commit failed";

  const after = await git(cwd, ["rev-parse", "HEAD"], { capture: true });
  if (after.code !== 0) return "cannot read HEAD";

  const actual = await git(cwd, ["log", "-1", "--format=%B"], { capture: true });
  if (actual.code !== 0) return "cannot read commit message";
  if (actual.output.replace(/\n+$/, "") === message) return true;

  if (after.output !== before.output && (await git(cwd, ["reset", "--quiet", "--soft", before.output.replace(/\n+$/, "")], { write: true })).code !== 0)
    return "git reset failed";

  return "commit message was altered by a hook or template";
}
