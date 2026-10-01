import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, relative } from "node:path";
import { clip, commentLines, RULE, skipPath, specFor } from "./comment-scan.ts";
import { object } from "./payload.ts";
import {
  codePointOrder,
  jsonBlock,
  PY_SPACE,
  pyRstrip,
  pyStrip,
  splitlines,
  textMode,
} from "./python-text.ts";

const MAX_REWRITES = 2;

function pattern(source: string, flags = ""): RegExp {
  const classes = source.replace(/\[(?:\\.|[^\]\\])*\]/g, (value) =>
    value.replaceAll("\\s", PY_SPACE),
  );

  return new RegExp(
    classes.replaceAll("\\s", `[${PY_SPACE}]`).replaceAll("\\S", `[^${PY_SPACE}]`),
    flags + "u",
  );
}

const OPENERS = pattern(
  "(?:(?<![^\\n])|[.!?:]\\s+|\\n\\s*(?:[-*]\\s+)?)(Let me know if|I hope this helps|Hope (?:this|that) helps|Feel free to|Great question|You're absolutely right|Certainly!|Of course!|Happy to help|It is important to note|It's worth noting|To summarize|In summary|Let me explain|Let's (?:break this down|dive in)|Here's the thing)",
);
const LABEL = /\*\*[^*\n]{1,60}:\*\*|\*\*[^*\n]{1,60}\*\*:/u;
const HYPHEN_DASH = pattern("(?<=[^\\s-]) -{1,2} (?=[^\\s-])");
const TEXT_BLOCK = /(?<![^\n])```text[ \t]*\r?\n(.*?)(?<![^\n])```[ \t]*\r?(?=\n|$)/gsu;
const PR_URL = "https?://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+";
const PR_BLOCKQUOTE = pattern(`(?<![^\\n])[^\\n]*${PR_URL}[^\\n]*\\n(?:[ \\t]*\\n)*[ \\t]*> `);
const PATH_TOKEN = pattern(
  "^(?:[~/].*|[^/\\s]+(?:/[^/\\s]+)*/[^/\\s.]+(?:\\.[^/\\s.]+)*\\.[A-Za-z0-9]+)$",
);
const LINE_SUFFIX = /(?::\p{Nd}+)+$|#L\p{Nd}+(?:-L\p{Nd}+)?$/u;
const WORD = "[\\p{L}\\p{N}_]";
const PLAN_ID = pattern(
  `(?<!${WORD})plan\\s*#?\\s*\\p{Nd}+(?!${WORD})|(?<!${WORD})plans\\s*#?\\s*\\p{Nd}+\\s*(?:,|and|or)\\s*#?\\s*\\p{Nd}+(?!${WORD})`,
  "i",
);
const URL = pattern("https?://\\S+", "g");

function replyFindings(text: string): string[] {
  const bodies = [...text.matchAll(TEXT_BLOCK)].flatMap((match) => {
    const above = pyRstrip(text.slice(0, match.index)).split("\n").at(-1)!;
    return pattern(PR_URL).test(above) ? [match[1]!] : [];
  });

  const stripped = text
    .replace(TEXT_BLOCK, "")
    .replace(/```.*?```/gsu, "")
    .replace(/`[^`\n]*`/gu, "");

  const out: string[] = [];
  if (PR_BLOCKQUOTE.test(stripped))
    out.push(
      "a drafted reply as a blockquote under a PR link. Drafts go in a ```text block, with the thread URL on the line above the fence.",
    );

  const prose = [stripped.replace(URL, "")];

  let path: string | undefined;
  let plan: string | undefined;
  let hasBacktick = false;
  for (const body of bodies) {
    const clean = body.replace(URL, "");
    prose.push(clean);

    if (path === undefined)
      for (const word of clean.split(pattern("\\s+"))) {
        const token = word.replace(/^[.,;:()"'!?[\]{}<>]+|[.,;:()"'!?[\]{}<>]+$/gu, "");
        if (PATH_TOKEN.test(token.replace(LINE_SUFFIX, ""))) {
          path = token;
          break;
        }
      }

    plan ??= PLAN_ID.exec(clean)?.[0];
    hasBacktick ||= body.includes("`");
  }

  if (path !== undefined)
    out.push(
      `a path shaped token "${path}" in a drafted reply. The operator's chat renders it as a local file link, so cite a commit sha instead.`,
    );

  if (plan !== undefined)
    out.push(
      `a plan id "${plan}" in a drafted reply. Plans exist only on this machine, so say what the code does and cite a commit sha or a linked issue.`,
    );

  if (hasBacktick) out.push("a backtick in a drafted reply. Write the draft as plain text.");
  if (prose.some((part) => /[\u2014\u2013]/u.test(part) || HYPHEN_DASH.test(part)))
    out.push("a dash used as punctuation. Use a comma, a colon, parentheses or a full stop.");

  const opener = prose.map((part) => OPENERS.exec(part)).find(Boolean);
  if (opener) out.push(`chatbot filler "${pyStrip(opener[1]!)}". Delete the sentence.`);

  const label = prose.map((part) => LABEL.exec(part)).find(Boolean);
  if (label)
    out.push(
      `a bold label with a colon ("${label[0]}"). Write it as a sentence or a plain bullet.`,
    );

  return out;
}

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    const gitEnv = { ...process.env, ...env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    const result = spawnSync("git", args, { cwd, env: gitEnv, timeout: 5000, maxBuffer: Infinity });
    return result.status === 0 && !result.error ? textMode(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

function sweepBase(cwd: string, env: NodeJS.ProcessEnv): string {
  const branch = pyStrip(run(["symbolic-ref", "--short", "-q", "HEAD"], cwd, env) ?? "");
  if (!branch) return "HEAD";

  const defaultBranch = pyStrip(
    run(["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], cwd, env) ?? "",
  );

  if (defaultBranch && branch === defaultBranch.slice(defaultBranch.indexOf("/") + 1))
    return "HEAD";

  const recorded = pyStrip(
    run(["config", "--get", `branch.${branch}.skills-base`], cwd, env) ?? "",
  );

  for (const candidate of [recorded, defaultBranch]) {
    const base = candidate ? run(["merge-base", candidate, "HEAD"], cwd, env) : undefined;
    if (base) return pyStrip(base);
  }

  return "HEAD";
}

function addedLines(cwd: string, env: NodeJS.ProcessEnv): Map<string, Set<number> | undefined> {
  const diff = [
    "-c",
    "core.quotePath=false",
    "diff",
    "--unified=0",
    "--no-color",
    "--diff-filter=AMR",
  ];

  const output =
    run([...diff.slice(0, 3), sweepBase(cwd, env), ...diff.slice(3)], cwd, env) ??
    run(diff, cwd, env);

  const files = new Map<string, Set<number> | undefined>();

  let lines: Set<number> | undefined;
  for (const line of splitlines(output ?? ""))
    if (line.startsWith("+++ b/")) {
      lines = new Set();
      files.set(join(cwd, line.slice(6)), lines);
    } else if (line.startsWith("@@") && lines) {
      const match = /\+(\d+)(?:,(\d+))?/.exec(line);
      if (!match) continue;

      const start = Number(match[1]);
      const count = Number(match[2] ?? 1);
      for (let number = start; number < start + count; number++) lines.add(number);
    }

  const untracked = run(["ls-files", "-z", "--others", "--exclude-standard"], cwd, env) ?? "";
  for (const path of untracked.split("\0")) if (path) files.set(join(cwd, path), undefined);

  return files;
}

function treeFindings(cwd: string, seen: Set<string>, env: NodeJS.ProcessEnv): [string, string][] {
  const hits: [string, string][] = [];
  const root = cwd ? pyStrip(run(["rev-parse", "--show-toplevel"], cwd, env) ?? "") : "";
  if (!root) return hits;

  for (const [path, lines] of addedLines(root, env)) {
    const spec = specFor(path);
    if (!spec || skipPath(path, env)) continue;

    let text: string;
    try {
      if (!statSync(path).isFile()) continue;
      text = textMode(readFileSync(path));
    } catch {
      continue;
    }

    for (const [number, content] of commentLines(text, spec)) {
      if (lines && !lines.has(number)) continue;
      const key = `${path}\t${content}`;
      if (!seen.has(key)) hits.push([key, `${relative(root, path)}:${number}  ${clip(content)}`]);
    }
  }

  return hits;
}

function readState(path: string): { seen: Set<string>; rewrites: number } {
  try {
    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path)),
    );

    const state = Array.isArray(parsed) ? { seen: parsed } : object(parsed);
    if (!state) throw new Error("invalid state");

    const keys = state.seen === undefined ? [] : state.seen;

    let values: unknown[];
    if (Array.isArray(keys)) values = keys;
    else if (typeof keys === "string") values = Array.from(keys);
    else {
      const record = object(keys);
      if (!record) throw new Error("invalid seen");
      values = Object.keys(record);
    }

    const raw = state.rewrites === undefined ? 0 : state.rewrites;
    if (
      typeof raw !== "number" &&
      typeof raw !== "boolean" &&
      (typeof raw !== "string" || !/^[+-]?\d+(?:_\d+)*$/.test(pyStrip(raw)))
    )
      throw new Error("invalid rewrites");

    const rewrites = Math.trunc(
      Number(typeof raw === "string" ? pyStrip(raw).replaceAll("_", "") : raw),
    );

    if (!Number.isFinite(rewrites)) throw new Error("invalid rewrites");

    return { seen: new Set(values.map(String)), rewrites };
  } catch {
    return { seen: new Set(), rewrites: 0 };
  }
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = object(value);
  return record ? Object.keys(record).length > 0 : Boolean(value);
}

function writeState(path: string, seen: Set<string>, rewrites: number): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify({ seen: [...seen].sort(codePointOrder), rewrites }));
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function check(payload: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENT_HOOKS === "0") return undefined;

  const data = object(payload);
  if (!data) return undefined;

  const session =
    typeof data.session_id === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(data.session_id)
      ? data.session_id
      : "anon";

  const path = join(
    typeof data.scratchpad_dir === "string" && data.scratchpad_dir ? data.scratchpad_dir : "/tmp",
    `reply-guard-${session}.json`,
  );

  const state = readState(path);
  const active = truthy(data.stop_hook_active);
  if (!active) state.rewrites = 0;
  if (state.rewrites >= MAX_REWRITES) return undefined;

  const reply = replyFindings(
    typeof data.last_assistant_message === "string" ? data.last_assistant_message : "",
  );

  const tree = treeFindings(typeof data.cwd === "string" ? data.cwd : "", state.seen, env);
  const shownTree = tree.slice(0, 8);
  for (const [key] of shownTree) state.seen.add(key);
  const rewrites = reply.length || tree.length ? state.rewrites + 1 : 0;
  try {
    writeState(path, state.seen, rewrites);
  } catch {
    if (active) return undefined;
  }

  const parts: string[] = [];
  if (reply.length)
    parts.push("Your reply has " + reply.join(" It also has ") + " Rewrite the reply.");

  if (tree.length) {
    const shown = shownTree.map(([, hit]) => "  " + hit).join("\n");
    const more = tree.length > 8 ? `\n  ... and ${tree.length - 8} more` : "";
    parts.push(`Comment lines added in this tree:\n${shown}${more}\n${RULE}`);
  }

  return parts.length ? parts.join("\n") : undefined;
}

export async function stop(): Promise<number> {
  if (process.env.AGENT_HOOKS === "0") return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(0)),
    );
  } catch {
    return 0;
  }

  const reason = check(payload, process.env);
  if (reason !== undefined) process.stdout.write(jsonBlock(reason));

  return 0;
}
