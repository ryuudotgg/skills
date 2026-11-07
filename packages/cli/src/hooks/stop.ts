import { readFileSync } from "node:fs";
import type { RuleId } from "./guards.ts";
import { recordBlock, type Blocked } from "./blocks.ts";
import { object } from "./payload.ts";
import { list, readState, sessionOf, statePath, treeFindings, writeState } from "./sweep.ts";
import { jsonBlock } from "./text.ts";

const MAX_REWRITES = 2;
const STANDALONE =
  "The operator reads only your last message, so it has to stand alone and say nothing about this check or what it flagged.";

const OPENERS = new RegExp(
  "(?:(?<![^\\n])|[.!?:]\\s+|\\n\\s*(?:[-*]\\s+)?)(Let me know if|I hope this helps|Hope (?:this|that) helps|Feel free to|Great question|You're absolutely right|Certainly!|Of course!|Happy to help|It is important to note|It's worth noting|To summarize|In summary|Let me explain|Let's (?:break this down|dive in)|Here's the thing)",
  "u",
);

const LABEL = /\*\*[^*\n]{1,60}:\*\*|\*\*[^*\n]{1,60}\*\*:/u;
const HYPHEN_DASH = new RegExp("(?<=[^\\s-]) -{1,2} (?=[^\\s-])", "u");
const TEXT_BLOCK = /(?<![^\n])```text[ \t]*\r?\n(.*?)(?<![^\n])```[ \t]*\r?(?=\n|$)/gsu;

const PR_URL = "https?://github\\.com/[^/\\s]+/[^/\\s]+/pull/[0-9]+";
const PR_BLOCKQUOTE = new RegExp(
  `(?<![^\\n])[^\\n]*${PR_URL}[^\\n]*\\n(?:[ \\t]*\\n)*[ \\t]*> `,
  "u",
);

const PATH_TOKEN = new RegExp(
  "^(?:[~/].*|[^/\\s]+(?:/[^/\\s]+)*/[^/\\s.]+(?:\\.[^/\\s.]+)*\\.[A-Za-z0-9]+)$",
  "u",
);

const LINE_SUFFIX = /(?::\p{Nd}+)+$|#L\p{Nd}+(?:-L\p{Nd}+)?$/u;
const WORD = "[\\p{L}\\p{N}_]";
const PLAN_ID = new RegExp(
  `(?<!${WORD})plan\\s*#?\\s*\\p{Nd}+(?!${WORD})|(?<!${WORD})plans\\s*#?\\s*\\p{Nd}+\\s*(?:,|and|or)\\s*#?\\s*\\p{Nd}+(?!${WORD})`,
  "iu",
);

const URL = new RegExp("https?://\\S+", "gu");

type Finding = { rule: RuleId; text: string };

function replyFindings(text: string): Finding[] {
  const bodies = [...text.matchAll(TEXT_BLOCK)].flatMap((match) => {
    const above = text.slice(0, match.index).trimEnd().split("\n").at(-1)!;
    return new RegExp(PR_URL, "u").test(above) ? [match[1]!] : [];
  });

  const stripped = text
    .replace(TEXT_BLOCK, "")
    .replace(/```.*?```/gsu, "")
    .replace(/`[^`\n]*`/gu, "");

  const out: Finding[] = [];
  const found = (rule: RuleId, text: string) => out.push({ rule, text });
  if (PR_BLOCKQUOTE.test(stripped))
    found(
      "reply-guard/draft-blockquote",
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
      for (const word of clean.split(new RegExp("\\s+", "u"))) {
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
    found(
      "reply-guard/draft-path",
      `a path shaped token "${path}" in a drafted reply. The operator's chat renders it as a local file link, so cite a commit sha instead.`,
    );

  if (plan !== undefined)
    found(
      "reply-guard/draft-plan-id",
      `a plan id "${plan}" in a drafted reply. Plans exist only on this machine, so say what the code does and cite a commit sha or a linked issue.`,
    );

  if (hasBacktick)
    found(
      "reply-guard/draft-backtick",
      "a backtick in a drafted reply. Write the draft as plain text.",
    );

  if (prose.some((part) => /[\u2014\u2013]/u.test(part) || HYPHEN_DASH.test(part)))
    found(
      "reply-guard/dash",
      "a dash used as punctuation. Use a comma, a colon, parentheses or a full stop.",
    );

  const opener = prose.map((part) => OPENERS.exec(part)).find(Boolean);
  if (opener)
    found("reply-guard/filler", `chatbot filler "${opener[1]!.trim()}". Delete the sentence.`);

  const label = prose.map((part) => LABEL.exec(part)).find(Boolean);
  if (label)
    found(
      "reply-guard/bold-label",
      `a bold label with a colon ("${label[0]}"). Write it as a sentence or a plain bullet.`,
    );

  return out;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  const record = object(value);
  return record ? Object.keys(record).length > 0 : Boolean(value);
}

export function verdict(payload: unknown, env: NodeJS.ProcessEnv): Blocked | undefined {
  if (env.AGENT_HOOKS === "0") return undefined;

  const data = object(payload);
  if (!data) return undefined;

  const path = statePath(data, sessionOf(data) ?? "anon");
  const state = readState(path);
  const active = truthy(data.stop_hook_active);
  if (!active) state.rewrites = 0;
  if (state.rewrites >= MAX_REWRITES) return undefined;

  const reply = replyFindings(
    typeof data.last_assistant_message === "string" ? data.last_assistant_message : "",
  );

  const { since, hits: tree } = treeFindings(
    typeof data.cwd === "string" ? data.cwd : "",
    state.seen,
    env,
  );

  const listed = tree.length ? list(since, tree, state.seen) : "";
  const rewrites = reply.length || tree.length ? state.rewrites + 1 : 0;
  try {
    writeState(path, state.seen, rewrites);
  } catch {
    if (active) return undefined;
  }

  const parts: string[] = [];
  const rules = reply.map((finding) => finding.rule);

  if (reply.length)
    parts.push(
      "Your reply has " +
        reply.map((finding) => finding.text).join(" It also has ") +
        " Rewrite the whole reply.",
    );

  if (listed) {
    parts.push(`${listed}\nThen send your whole reply again, updated for anything you changed.`);
    rules.push("reply-guard/comment-lines");
  }

  return parts.length ? { reason: [...parts, STANDALONE].join("\n"), rules } : undefined;
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

  const blocked = verdict(payload, process.env);
  if (!blocked) return 0;

  process.stdout.write(jsonBlock(blocked.reason));
  await recordBlock(blocked, object(payload)!, process.env);

  return 0;
}
