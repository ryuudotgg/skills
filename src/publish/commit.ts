import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { processIo, type Io } from "../io.ts";
import { describe, GRACE, pipe, read, within } from "../read.ts";

export const MESSAGE = new RegExp(
  `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^()\\s\\p{Cc}]+\\))?!?: [^\\s\\p{Cc}]([^\\p{Cc}]*[^\\s\\p{Cc}])?$`,
  "u",
);

export type MessageProblem = "multi line message" | "longer than 50 characters" | "no Conventional prefix";

export function messageProblem(value: string): MessageProblem | undefined {
  if (/[\r\n\u2028\u2029]/u.test(value)) return "multi line message";
  if ([...value].length > 50) return "longer than 50 characters";
  if (!MESSAGE.test(value)) return "no Conventional prefix";

  return undefined;
}

export type ProcessResult = { code: number | undefined; output: string };
type RunOptions = { capture?: boolean; write?: boolean; timeout?: number; stderr?: "inherit" | "ignore" };
export type SelectedIndex = { paths: string[] } | { reason: string };

export function argumentsFor(args: readonly string[], names: string): { options: Map<string, string>; files: string[] } | undefined {
  const options = new Map<string, string>();

  let index = 0;
  while (index < args.length) {
    const option = args[index] ?? "";
    if (option === "--") {
      index++;
      break;
    }

    if (!option.startsWith("-") || option === "-") break;

    const name = option[1] ?? "";
    if (!names.includes(name) || options.has(name)) return undefined;

    const value = option.length > 2 ? option.slice(2) : args[++index];
    if (value === undefined) return undefined;

    options.set(name, value);
    index++;
  }

  return { options, files: args.slice(index) };
}

export async function run(cwd: string, argv: readonly string[], options: RunOptions = {}, io: Io = processIo()): Promise<ProcessResult> {
  if (!options.write) {
    const result = await read(argv, { cwd, env: io.env, deadline: options.timeout ?? 10_000 });
    if (options.stderr !== "ignore") io.err(result.stderr);
    if (!result.ok) {
      if (options.stderr !== "ignore") io.err(describe(result.failure) + "\n");
      return { code: undefined, output: "" };
    }

    if (!options.capture) io.err(result.stdout);

    return { code: result.code, output: options.capture ? result.stdout : "" };
  }

  try {
    const child = Bun.spawn([...argv], {
      cwd,
      env: io.env,
      stdin: "ignore",
      stdout: options.capture || io.capture ? "pipe" : 2,
      stderr: options.stderr === "ignore" ? "ignore" : io.capture ? "pipe" : "inherit",
    });

    const output = child.stdout instanceof ReadableStream ? pipe(child.stdout) : undefined;
    const errors = child.stderr instanceof ReadableStream ? pipe(child.stderr) : undefined;
    try {
      const code = await child.exited;

      // A gh extension runs as a grandchild that keeps the pipe open after gh itself is killed.
      await within(Promise.all([output?.done, errors?.done]), GRACE);
      const text = output ? new TextDecoder().decode(output.bytes()) : "";
      if (errors) io.err(new TextDecoder().decode(errors.bytes()));
      if (!options.capture) io.err(text);

      return { code: child.signalCode ? undefined : code, output: options.capture && !child.signalCode ? text : "" };
    } finally {
      output?.cancel();
      errors?.cancel();
      child.unref();
    }
  } catch {
    return { code: undefined, output: "" };
  }
}

export function git(cwd: string, args: readonly string[], options: RunOptions = {}, io: Io = processIo()): Promise<ProcessResult> {
  return run(cwd, ["git", ...args], options, io);
}

export async function selectedIndex(cwd: string, files: readonly string[], io: Io = processIo()): Promise<SelectedIndex> {
  const args = ["diff", "--cached", "--no-renames", "--name-only", "-z"];
  const staged = await git(cwd, args, { capture: true }, io);
  if (staged.code !== 0) return { reason: "cannot read staged changes" };

  const selected = await git(cwd, [...args, "--", ...files], { capture: true }, io);
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
  io: Io = processIo(),
): Promise<string | undefined> {
  const selection = index ?? await selectedIndex(cwd, files, io);
  if ("reason" in selection) return selection.reason;

  const remaining: string[] = [];
  for (const path of files) {
    if (existsSync(resolve(cwd, path))) {
      remaining.push(path);
      continue;
    }

    const tracked = await git(cwd, ["ls-files", "--error-unmatch", "-z", "--", path], { capture: true, stderr: "ignore" }, io);
    if (tracked.code === 0) {
      remaining.push(path);
      continue;
    }

    if (tracked.code !== 1) return `cannot read tracked files: ${path}`;

    const staged = await git(cwd, ["diff", "--cached", "--no-renames", "--name-only", "-z", "--", path], { capture: true }, io);
    if (staged.code !== 0) return "cannot read staged changes";
    if (staged.output) continue;
    if (!alsoAccept || !await alsoAccept(path)) return `no such file: ${path}`;
  }

  if (remaining.length && (await git(cwd, ["add", "--", ...remaining], { write: true }, io)).code !== 0)
    return "git add failed";

  return undefined;
}

export async function stagedChanges(cwd: string, io: Io = processIo()): Promise<boolean | undefined> {
  const result = await git(cwd, ["diff", "--cached", "--no-renames", "--quiet"], {}, io);
  if (result.code === 0) return false;
  if (result.code === 1) return true;

  return undefined;
}

export async function commitStaged(cwd: string, message: string, io: Io = processIo()): Promise<boolean | string> {
  const staged = await stagedChanges(cwd, io);
  if (staged === undefined) return "cannot read staged changes";
  if (!staged) return false;

  const before = await git(cwd, ["rev-parse", "HEAD"], { capture: true }, io);
  if (before.code !== 0) return "cannot read HEAD";
  if ((await git(cwd, ["commit", "--quiet", "-m", message], { write: true }, io)).code !== 0) return "git commit failed";

  const after = await git(cwd, ["rev-parse", "HEAD"], { capture: true }, io);
  if (after.code !== 0) return "cannot read HEAD";

  const actual = await git(cwd, ["log", "-1", "--format=%B"], { capture: true }, io);
  if (actual.code !== 0) return "cannot read commit message";
  if (actual.output.replace(/\n+$/, "") === message) return true;

  if (after.output !== before.output && (await git(cwd, ["reset", "--quiet", "--soft", before.output.replace(/\n+$/, "")], { write: true }, io)).code !== 0)
    return "git reset failed";

  return "commit message was altered by a hook or template";
}
