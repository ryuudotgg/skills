import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { git } from "../run.ts";
import { processIo, type Io } from "../io.ts";

export const MESSAGE = new RegExp(
  `^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\\([^()\\s\\p{Cc}]+\\))?!?: [^\\s\\p{Cc}]([^\\p{Cc}]*[^\\s\\p{Cc}])?$`,
  "u",
);

export type MessageProblem =
  | "multi line message"
  | "longer than 50 characters"
  | "no Conventional prefix";

export function messageProblem(value: string): MessageProblem | undefined {
  if (/[\r\n\u2028\u2029]/u.test(value)) return "multi line message";
  if ([...value].length > 50) return "longer than 50 characters";
  if (!MESSAGE.test(value)) return "no Conventional prefix";

  return undefined;
}

export type SelectedIndex = { paths: string[] } | { reason: string };

export async function selectedIndex(
  cwd: string,
  files: readonly string[],
  io: Io = processIo(),
): Promise<SelectedIndex> {
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
  const selection = index ?? (await selectedIndex(cwd, files, io));
  if ("reason" in selection) return selection.reason;

  const remaining: string[] = [];
  for (const path of files) {
    if (existsSync(resolve(cwd, path))) {
      remaining.push(path);
      continue;
    }

    const tracked = await git(
      cwd,
      ["ls-files", "--error-unmatch", "-z", "--", path],
      { capture: true, stderr: "ignore" },
      io,
    );

    if (tracked.code === 0) {
      remaining.push(path);
      continue;
    }

    if (tracked.code !== 1) return `cannot read tracked files: ${path}`;

    const staged = await git(
      cwd,
      ["diff", "--cached", "--no-renames", "--name-only", "-z", "--", path],
      { capture: true },
      io,
    );

    if (staged.code !== 0) return "cannot read staged changes";
    if (staged.output) continue;
    if (!alsoAccept || !(await alsoAccept(path))) return `no such file: ${path}`;
  }

  if (
    remaining.length &&
    (await git(cwd, ["add", "--", ...remaining], { write: true }, io)).code !== 0
  )
    return "git add failed";

  return undefined;
}

export async function stagedChanges(
  cwd: string,
  io: Io = processIo(),
): Promise<boolean | undefined> {
  const result = await git(cwd, ["diff", "--cached", "--no-renames", "--quiet"], {}, io);
  if (result.code === 0) return false;
  if (result.code === 1) return true;

  return undefined;
}

export async function commitStaged(
  cwd: string,
  message: string,
  io: Io = processIo(),
): Promise<boolean | string> {
  const staged = await stagedChanges(cwd, io);
  if (staged === undefined) return "cannot read staged changes";
  if (!staged) return false;

  const before = await git(cwd, ["rev-parse", "HEAD"], { capture: true }, io);
  if (before.code !== 0) return "cannot read HEAD";
  if ((await git(cwd, ["commit", "--quiet", "-m", message], { write: true }, io)).code !== 0)
    return "git commit failed";

  const after = await git(cwd, ["rev-parse", "HEAD"], { capture: true }, io);
  if (after.code !== 0) return "cannot read HEAD";

  const actual = await git(cwd, ["log", "-1", "--format=%B"], { capture: true }, io);
  if (actual.code !== 0) return "cannot read commit message";
  if (actual.output.replace(/\n+$/, "") === message) return true;

  if (
    after.output !== before.output &&
    (
      await git(
        cwd,
        ["reset", "--quiet", "--soft", before.output.replace(/\n+$/, "")],
        { write: true },
        io,
      )
    ).code !== 0
  )
    return "git reset failed";

  return "commit message was altered by a hook or template";
}
