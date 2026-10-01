import type { Context } from "../registry.ts";
import { basename, joinPath, jsonBlock, pyIsSpace, pyStrip, splitlines } from "./python-text.ts";

const COMMIT_SHAPE =
  'git commit -m "<type>(<scope>): <summary>", one line, 50 characters or fewer, no trailer, also accepted as git -C <dir> commit -m and gh stack add -m';
const COMMENT_SHAPE =
  'gh pr comment <number> --body "<trigger>", the whole body the TRIGGER an active reviewer declares';
const PUSH_SHAPE =
  "git push [-u] [-q] origin <branch>, or git push [-u] [-q] origin refs/heads/<branch>:refs/heads/<branch>, alone, to a local branch other than the default, prs mode only; git -C <dir> push resolves against <dir>";
const OTHER_PUSH_JOB =
  "skills publish pushes and opens a branch or stack layer, and skills fix-round pushes a fix round. skills lease-rebase restacks layers, and skills restack-layer lease pushes a resolved stale layer and restacks the owned layers above it.";
const BOTH_SHAPES = `${COMMIT_SHAPE}; ${COMMENT_SHAPE}`;
const SETTING_REASON =
  "Blocked: git config under skills.* holds the operator's reviewer settings, in any letter case. Read them with skills settings <reviewer>; the operator sets them.";
const UNREADABLE = `Blocked: the payload was unreadable, so commits and PR comments stay blocked. Allowed shapes: ${BOTH_SHAPES}.`;
const PUNCTUATION = new Set(";|&()<>");
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--exec-path",
  "--super-prefix",
  "--attr-source",
]);
const NESTING = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "ssh", "su"]);
const UNSAFE = /[\n\r$`\\]/;

export type Result =
  | { kind: "PASS" }
  | { kind: "DENY_SETTING" }
  | { kind: "COMMIT"; message: string }
  | { kind: "COMMENT"; detail: string }
  | { kind: "PUSH"; detail: string; directory: string }
  | { kind: "DENY_COMMIT"; detail: string }
  | { kind: "DENY_COMMENT"; detail: string }
  | { kind: "DENY_PUSH"; detail: string }
  | { kind: "DENY"; detail: string };

type Patterns = { setting: RegExp; fallback: RegExp; push: RegExp; digit: RegExp };
let asciiPatterns: Patterns | undefined;
let unicodePatterns: Patterns | undefined;

function patterns(raw: string): Patterns {
  const ascii = !/[\u0080-\uffff]/.test(raw);
  const cached = ascii ? asciiPatterns : unicodePatterns;
  if (cached) return cached;

  const word = ascii ? "\\w" : "\\p{L}\\p{N}_";
  const boundary = ascii ? "\\b" : `(?:(?<![${word}])(?=[${word}])|(?<=[${word}])(?![${word}]))`;
  const name = (value: string) => `${boundary}${value}${boundary}`;

  const commit = `${name("git")}[^\\n]*${boundary}commit|${name("gh")}[^\\n]*${name("stack")}[^\\n]*${boundary}add`;
  const comment = `${name("gh")}[^\\n]*${name("pr")}[^\\n]*${boundary}comment`;
  const push = `${name("git")}[^\\n]*${name("(push|send-pack)")}|${name("gh")}[^\\n]*${name("stack")}[^\\n]*${boundary}(push|sync|submit|link)`;

  const setting = `${name(ascii ? "git" : "g[i\\u0131\\u0130]t")}[^\\n;&|]*${name(ascii ? "config" : "conf[i\\u0131\\u0130]g")}[^\\n;&|]*(?<![${word}.-])${ascii ? "skills" : "sk[i\\u0131\\u0130]lls"}\\.${ascii ? "[a-z0-9]" : "[a-z0-9\\u0131\\u0130]"}`;
  const extraDigits =
    "\\u{b2}-\\u{b3}\\u{b9}\\u{1369}-\\u{1371}\\u{19da}\\u{2070}\\u{2074}-\\u{2079}\\u{2080}-\\u{2089}\\u{2460}-\\u{2468}\\u{2474}-\\u{247c}\\u{2488}-\\u{2490}\\u{24ea}\\u{24f5}-\\u{24fd}\\u{24ff}\\u{2776}-\\u{277e}\\u{2780}-\\u{2788}\\u{278a}-\\u{2792}\\u{10a40}-\\u{10a43}\\u{10e60}-\\u{10e68}\\u{11052}-\\u{1105a}\\u{1f100}-\\u{1f10a}";

  const result = {
    setting: new RegExp(setting, ascii ? "i" : "iu"),
    fallback: new RegExp(`${commit}|${comment}|${push}`, ascii ? "" : "u"),
    push: new RegExp(push, ascii ? "" : "u"),
    digit: new RegExp(ascii ? "^[0-9]+$" : `^[\\p{Nd}${extraDigits}]+$`, "u"),
  };

  if (ascii) asciiPatterns = result;
  else unicodePatterns = result;

  return result;
}

function tokens(raw: string): string[] {
  const text = raw
    .replaceAll("\\\r\n", "")
    .replaceAll("\\\n", "")
    .replace(/`|\$\(/g, " ; ");

  const parts: string[] = [];

  let token = "";
  let state: "space" | "word" | "punctuation" | "'" | '"' = "space";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (state === "'" || state === '"') {
      if (char === state) state = "word";
      else if (char === "\\" && state === '"') {
        const next = text[++index];
        if (next === undefined) throw new Error("No escaped character");
        token += next === '"' || next === "\\" ? next : "\\" + next;
      } else token += char;

      continue;
    }

    if (state === "punctuation") {
      if (PUNCTUATION.has(char)) {
        token += char;
        continue;
      }

      parts.push(token);
      token = "";
      state = "space";
    }

    if (" \t\r\n".includes(char)) {
      if (state === "word") parts.push(token);
      token = "";
      state = "space";
    } else if (PUNCTUATION.has(char)) {
      if (state === "word") parts.push(token);
      token = char;
      state = "punctuation";
    } else if (char === "'" || char === '"') state = char;
    else if (char === "\\") {
      const next = text[++index];
      if (next === undefined) throw new Error("No escaped character");

      token += next;
      state = "word";
    } else {
      token += char;
      state = "word";
    }
  }

  if (state === "'" || state === '"') throw new Error("No closing quotation");
  if (state !== "space") parts.push(token);

  return parts;
}

function isPunctuation(part: string): boolean {
  return Boolean(part) && [...part].every((char) => PUNCTUATION.has(char));
}

function segments(parts: string[]): string[][] {
  const found: string[][] = [[]];
  for (const part of parts)
    if (isPunctuation(part)) found.push([]);
    else found.at(-1)!.push(part);

  return found;
}

function gitSubcommand(parts: string[], start: number): string {
  for (let index = start + 1; index < parts.length; index++) {
    const part = parts[index]!;
    if (GIT_VALUE_OPTIONS.has(part)) index++;
    else if (!part.startsWith("-")) return part;
  }

  return "";
}

function inOrder(parts: string[], first: string, second: string): boolean {
  return parts.includes(first) && parts.slice(parts.indexOf(first) + 1).includes(second);
}

function hasStackMessage(parts: string[]): boolean {
  return parts.some(
    (part) =>
      part.startsWith("-m") ||
      part === "--message" ||
      part.startsWith("--message=") ||
      /^-[A-Za-z]*m$/.test(part),
  );
}

function pushes(segment: string[]): boolean {
  for (const [index, part] of segment.entries()) {
    const name = basename(part);
    const rest = name === "git" || name === "gh" ? segment.slice(index + 1) : [];

    if (name === "git" && ["push", "send-pack"].includes(gitSubcommand(segment, index)))
      return true;

    if (["git-push", "git-send-pack"].includes(name)) return true;
    if (
      name === "git" &&
      rest.some(
        (option, offset) => option === "-c" && rest[offset + 1]?.toLowerCase().startsWith("alias."),
      )
    )
      return true;

    if (
      name === "gh" &&
      ["push", "sync", "submit", "link"].some((action) => inOrder(rest, "stack", action))
    )
      return true;
  }

  return false;
}

function pushRefspecs(segment: string[]): string[] {
  for (const [index, part] of segment.entries()) {
    if (basename(part) !== "git" || gitSubcommand(segment, index) !== "push") continue;

    return segment
      .slice(segment.indexOf("push", index + 1) + 1)
      .filter((value) => !value.startsWith("-") && value !== "origin");
  }

  return [];
}

function pushDetail(parts: string[]): string {
  const groups = segments(parts).filter(pushes);
  const values = groups.flat();
  const refspecs = groups.flatMap(pushRefspecs);

  if (
    values.some(
      (part) =>
        (part.startsWith("-") && !part.startsWith("--") && part.slice(1).includes("f")) ||
        ["--force", "--force-if-includes"].includes(part) ||
        part.startsWith("--force-with-lease") ||
        part.startsWith("+"),
    )
  )
    return "force push. A typed push never rewrites a pushed commit: skills fix-round pushes a fix round and lease rebases the owned layers above it, and skills lease-rebase restacks owned layers onto a moved parent. skills restack-layer lease pushes a resolved stale layer and restacks the owned layers above it.";

  if (values.some((part) => ["--delete", "-d", "--prune"].includes(part) || part.startsWith(":")))
    return "delete push. A typed push never deletes a remote ref: skills publish and skills fix-round make every push past the allowed shape, and removing a remote branch is the operator's.";

  if (
    groups.some((group) => group.includes("gh") && group.includes("stack")) ||
    refspecs.length > 1 ||
    values.some((part) => ["--all", "--mirror"].includes(part) || part.includes("*"))
  )
    return "stack push. Stack pushes and stack submission go through skills publish.";

  return `chained or unsupported push. ${OTHER_PUSH_JOB}`;
}

function branch(value: string): string {
  if (!value || value.startsWith("-") || value.startsWith("refs/")) return "";
  if ([...value].some((char) => "*?[:+~^`".includes(char) || pyIsSpace(char))) return "";
  return value;
}

function pushedBranch(refspec: string): string {
  if (branch(refspec)) return refspec;

  const separator = refspec.indexOf(":");
  const left = refspec.slice(0, separator);
  if (separator < 0 || left !== refspec.slice(separator + 1) || !left.startsWith("refs/heads/"))
    return "";

  return branch(left.slice("refs/heads/".length));
}

function oneMessage(parts: string[]): string | undefined {
  if (parts.length === 2 && ["-m", "--message"].includes(parts[0]!)) return parts[1];
  if (parts.length === 1 && parts[0]!.startsWith("-m") && parts[0]!.length > 2)
    return parts[0]!.slice(2);

  if (parts.length === 1 && parts[0]!.startsWith("--message="))
    return parts[0]!.slice("--message=".length);

  return undefined;
}

function allowed(raw: string, parts: string[]): Result | undefined {
  if (UNSAFE.test(raw) || parts.some(isPunctuation)) return undefined;

  if (parts[0] === "git") {
    let rest = parts.slice(1);
    let directory = "";
    if (rest.length >= 2 && rest[0] === "-C") {
      directory = rest[1]!;
      rest = rest.slice(2);
    }

    if (rest[0] === "commit") {
      const message = oneMessage(rest.slice(1));
      if (message !== undefined) return { kind: "COMMIT", message };

      return {
        kind: "DENY_COMMIT",
        detail: rest.includes("--amend")
          ? "amend is not allowed"
          : "commit has an extra flag or no single message",
      };
    }

    if (rest[0] !== "push") return undefined;

    const flags = rest.slice(1, -2);
    if (
      new Set(flags).size !== flags.length ||
      flags.some((flag) => flag !== "-u" && flag !== "-q") ||
      rest.at(-2) !== "origin"
    )
      return undefined;

    return pushedBranch(rest.at(-1)!)
      ? { kind: "PUSH", detail: rest.at(-1)!, directory }
      : undefined;
  }

  if (parts[0] === "gh" && parts[1] === "stack" && parts[2] === "add") {
    const rest = parts.slice(3);
    const alternatives = [
      [rest, []],
      [rest.slice(1), rest.slice(0, 1)],
      [rest.slice(0, -1), rest.slice(-1)],
    ];

    for (const [messages, positional] of alternatives) {
      const message = oneMessage(messages!);
      if (message !== undefined && !positional!.some((part) => part.startsWith("-")))
        return { kind: "COMMIT", message };
    }

    return hasStackMessage(rest)
      ? { kind: "DENY_COMMIT", detail: "stack add has an extra flag or no single message" }
      : undefined;
  }

  if (parts[0] === "gh" && parts[1] === "pr" && parts[2] === "comment")
    return parts.length === 6 &&
      patterns(raw).digit.test(parts[3]!) &&
      parts[4] === "--body" &&
      parts[5]
      ? { kind: "COMMENT", detail: parts[5] }
      : { kind: "DENY_COMMENT", detail: "PR comment is not a reviewer trigger" };

  return undefined;
}

function substituted(raw: string): Result | undefined {
  if (!raw.includes("$(") && !raw.includes("`")) return undefined;

  let rest = raw;
  for (
    let match = /\$\(([^()]*)\)|`([^`]*)`/.exec(rest);
    match;
    match = /\$\(([^()]*)\)|`([^`]*)`/.exec(rest)
  ) {
    const inner = classify(match[1] ?? match[2]!);
    if (inner.kind === "COMMIT" || inner.kind === "DENY_COMMIT")
      return {
        kind: "DENY_COMMIT",
        detail: "chained, substituted, multi line or unsupported commit",
      };

    if (inner.kind === "COMMENT" || inner.kind === "DENY_COMMENT")
      return {
        kind: "DENY_COMMENT",
        detail: "chained, substituted, multi line or unsupported PR comment",
      };

    if (inner.kind === "PUSH" || inner.kind === "DENY_PUSH")
      return { kind: "DENY_PUSH", detail: `substituted push. ${OTHER_PUSH_JOB}` };

    if (inner.kind === "DENY") return { kind: "DENY", detail: "substituted command" };

    rest = `${rest.slice(0, match.index)} _ ${rest.slice(match.index + match[0].length)}`;
  }

  return (rest.includes("$(") || rest.includes("`")) && patterns(raw).fallback.test(rest)
    ? { kind: "DENY", detail: "substitution could not be read" }
    : undefined;
}

export function classify(raw: string): Result {
  const mentionsConfig =
    raw.toLowerCase().includes("config") ||
    ((raw.includes("\u0131") || raw.includes("\u0130")) && /conf[i\u0131\u0130]g/i.test(raw));

  if (mentionsConfig && patterns(raw).setting.test(raw)) return { kind: "DENY_SETTING" };

  let parts: string[];
  try {
    parts = tokens(raw);
  } catch {
    const expressions = patterns(raw);
    if (expressions.push.test(raw))
      return { kind: "DENY_PUSH", detail: `push could not be parsed. ${OTHER_PUSH_JOB}` };

    if (splitlines(raw).some((line) => expressions.fallback.test(line)))
      return { kind: "DENY", detail: "command could not be parsed" };

    return { kind: "PASS" };
  }

  const hidden = substituted(raw);
  if (hidden) return hidden;

  const exact = allowed(raw, parts);
  if (exact) return exact;

  const groups = segments(parts);

  let commit = false;
  let comment = false;
  for (const segment of groups)
    for (const [index, part] of segment.entries()) {
      const name = basename(part);
      if (name === "git" && ["commit", "commit-tree"].includes(gitSubcommand(segment, index)))
        commit = true;

      if (name !== "gh") continue;

      const rest = segment.slice(index + 1);
      if (inOrder(rest, "pr", "comment")) comment = true;
      if (inOrder(rest, "stack", "add") && hasStackMessage(rest)) commit = true;
    }

  if (commit)
    return {
      kind: "DENY_COMMIT",
      detail: "chained, substituted, multi line or unsupported commit",
    };

  if (comment)
    return {
      kind: "DENY_COMMENT",
      detail: "chained, substituted, multi line or unsupported PR comment",
    };

  if (groups.some(pushes)) return { kind: "DENY_PUSH", detail: pushDetail(parts) };

  const expressions = patterns(raw);
  for (const segment of groups) {
    if (
      segment.some((part) => NESTING.has(basename(part))) &&
      segment.some((part) => expressions.fallback.test(part))
    )
      return segment.some((part) => expressions.push.test(part))
        ? { kind: "DENY_PUSH", detail: pushDetail(parts) }
        : { kind: "DENY", detail: "nested command" };
  }

  return { kind: "PASS" };
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("unreadable payload");

  return value as Record<string, unknown>;
}

function command(payload: Record<string, unknown>): string {
  const value = object(payload.tool_input).command;
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((part): part is string => typeof part === "string"))
    throw new Error("unreadable command");

  if (
    value.length === 3 &&
    ["bash", "sh", "zsh"].includes(basename(value[0]!)) &&
    ["-c", "-lc"].includes(value[1]!)
  )
    return value[2]!;

  return value
    .map((part) =>
      !part
        ? "''"
        : /^[\w@%+=:,./-]+$/.test(part)
          ? part
          : "'" + part.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
}

function deny(reason: string): string {
  const escaped = jsonBlock(reason).slice('{"decision": "block", "reason": '.length, -2);
  return `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ${escaped}}}\n`;
}

type GitRead = { code: number | undefined; output: string };

async function gitRead(
  directory: string,
  args: string[],
  options: { capture: true; stderr: "ignore"; timeout: number },
): Promise<GitRead> {
  try {
    const child = Bun.spawn(["git", "-C", directory, ...args], {
      stdin: "ignore",
      stdout: options.capture ? "pipe" : "ignore",
      stderr: options.stderr,
      timeout: options.timeout,
      killSignal: "SIGTERM",
    });

    const bytes = new Response(child.stdout).arrayBuffer();
    const code = await child.exited;
    if (child.signalCode) return { code: undefined, output: "" };

    const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(await bytes)
      .replace(/\r\n?/g, "\n");

    return { code, output };
  } catch {
    return { code: undefined, output: "" };
  }
}

async function pushBlock(result: Extract<Result, { kind: "PUSH" }>, cwd: string): Promise<string> {
  const directory = joinPath(cwd, result.directory);
  const target = pushedBranch(result.detail);
  const options = { capture: true, stderr: "ignore", timeout: 5_000 } as const;
  const [head, local, remapped] = await Promise.all([
    gitRead(directory, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], options),
    gitRead(directory, ["show-ref", "--verify", "--quiet", `refs/heads/${target}`], options),
    gitRead(directory, ["config", "--get-all", "remote.origin.push"], options),
  ]);

  if ([head, local, remapped].some((result) => result.code === undefined))
    return "git could not be read, so the default branch is unknown";

  const prefix = "refs/remotes/origin/";
  const defaultBranch = pyStrip(head.output).slice(prefix.length);
  if (head.code !== 0 || !head.output.startsWith(prefix) || !defaultBranch)
    return "origin/HEAD is unset, so the default branch is unknown. Run git remote set-head origin -a, then push again";

  if (target === defaultBranch) return `${defaultBranch} is the default branch`;
  if (local.code !== 0) return `${target} is not a local branch`;
  if (!result.detail.includes(":") && remapped.code !== 1)
    return `remote.origin.push may send ${target} elsewhere, so name the destination: git push origin refs/heads/${target}:refs/heads/${target}`;

  return "";
}

async function decide(
  result: Result,
  cwd: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const commitReason = `Allowed shape: ${COMMIT_SHAPE}.`;
  const commentReason = `Allowed shape: ${COMMENT_SHAPE}.`;
  const pushReason = (reason: string) => `${reason} Allowed typed push: ${PUSH_SHAPE}.`;
  switch (result.kind) {
    case "PASS":
      return "";

    case "DENY_SETTING":
      return SETTING_REASON;

    case "DENY_COMMIT":
      return `Blocked: ${result.detail}. ${commitReason}`;

    case "DENY_COMMENT":
      return `Blocked: ${result.detail}. ${commentReason}`;

    case "DENY_PUSH":
      return pushReason(`Blocked: ${result.detail}.`);

    case "DENY":
      return pushReason(
        `Blocked: ${result.detail}. Allowed shapes: ${BOTH_SHAPES}. ${OTHER_PUSH_JOB}`,
      );
  }

  if (result.kind === "COMMIT") {
    const { messageProblem } = await import("../publish/commit.ts");
    const problem = messageProblem(result.message);
    const detail =
      problem === "longer than 50 characters"
        ? "message is longer than 50 characters"
        : problem === "no Conventional prefix"
          ? "message has no Conventional prefix"
          : problem;

    if (detail) return `Blocked: ${detail}. ${commitReason}`;
  }

  const { readDelivery } = await import("../delivery.ts");
  const delivery = readDelivery(root, env);
  const extensions = delivery.mode === "prs" ? delivery.active : [];

  if (result.kind === "COMMIT")
    return delivery.mode === "prs"
      ? ""
      : `Blocked: hands-off mode leaves the work unstaged and the operator commits. ${commitReason}`;

  if (result.kind === "COMMENT") {
    let triggers: Map<string, string>;
    try {
      const { readDeclarations } = await import("../reviewers/declaration.ts");

      triggers = new Map(
        readDeclarations(root).map((declaration) => [declaration.name, declaration.trigger]),
      );
    } catch {
      return `Blocked: reviewer declarations are unreadable. ${commentReason}`;
    }

    if (
      [...triggers].some(
        ([name, trigger]) => result.detail === trigger && extensions.includes(name),
      )
    )
      return "";

    const inactive = [...triggers].find(([, trigger]) => result.detail === trigger)?.[0];
    return `Blocked: ${inactive !== undefined ? `${inactive} is inactive` : "the body is no active reviewer's trigger"}. ${commentReason}`;
  }

  if (delivery.mode !== "prs")
    return pushReason("Blocked: hands-off mode leaves the work unstaged and the operator pushes.");

  const block = await pushBlock(result, cwd);
  return block ? pushReason(`Blocked: ${block}.`) : "";
}

export async function guardOutput(
  input: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const payload = object(JSON.parse(input));
    if (
      payload.tool_name !== undefined &&
      payload.tool_name !== null &&
      payload.tool_name !== "Bash"
    )
      return "";

    const result = classify(command(payload));
    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const reason = await decide(result, cwd, root, env);
    return reason ? deny(reason) : "";
  } catch {
    return deny(UNREADABLE);
  }
}

export async function preToolUse(ctx: Context): Promise<number> {
  try {
    const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await Bun.stdin.bytes(),
    );

    const output = await guardOutput(input, ctx.root, process.env);
    if (output) process.stdout.write(output);
  } catch {
    process.stdout.write(deny(UNREADABLE));
  }

  return 0;
}
