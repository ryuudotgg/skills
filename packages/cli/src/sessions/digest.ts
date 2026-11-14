import { USAGE_FIELDS, type Host } from "skills-core";
import { object, type RecordObject } from "./jsonl.ts";
import { redact } from "./redact.ts";
import { freshState, readRecord, type FileState } from "./transcripts.ts";

export const DIGEST_FIELD = 2_000;

type Turn = { kind: "Prompt" | "Reply"; text: string };

export type Digest = { host: Host; turns: Turn[]; reply: string | null; file: FileState };

export function freshDigest(host: Host): Digest {
  return { host, turns: [], reply: null, file: freshState(host) };
}

export function copyDigest(digest: Digest): Digest {
  return { ...digest, turns: [...digest.turns], file: structuredClone(digest.file) };
}

function clipped(text: string): string {
  if (text.length <= DIGEST_FIELD) return text;
  return `${text.slice(0, DIGEST_FIELD)} [dropped ${text.length - DIGEST_FIELD} characters]`;
}

function texts(content: unknown, type: string): string[] {
  if (!Array.isArray(content)) return [];

  return content.flatMap((block) =>
    object(block) && block.type === type && typeof block.text === "string" ? [block.text] : [],
  );
}

const CLAUDE_INTERRUPTED = /^\[Request interrupted by user( for tool use)?\]$/;

type Wrapper = readonly [open: string, close: string];

const CLAUDE_INJECTED: readonly Wrapper[] = [["<task-notification>", "</task-notification>"]];

const CODEX_INJECTED: readonly Wrapper[] = [
  ["# AGENTS.md instructions", "</INSTRUCTIONS>"],
  ["<environment_context>", "</environment_context>"],
  ["<user_instructions>", "</user_instructions>"],
  ["<hook_prompt", "</hook_prompt>"],
  ["<recommended_plugins>", "</recommended_plugins>"],
];

function wrapped(text: string, wrappers: readonly Wrapper[]): boolean {
  const trimmed = text.trim();
  return wrappers.some(([open, close]) => trimmed.startsWith(open) && trimmed.endsWith(close));
}

function joined(found: readonly string[]): string | null {
  return found.length > 0 ? found.join("\n") : null;
}

function claudePrompt(record: RecordObject): string | null {
  const { message, origin } = record;
  if (record.type !== "user" || record.isMeta === true || !object(message)) return null;
  if (object(origin) && origin.kind === "task-notification") return null;

  const content = message.content;
  const blocks: unknown[] = Array.isArray(content) ? content : [];
  if (blocks.some((block) => object(block) && block.type === "tool_result")) return null;

  const found = typeof content === "string" ? [content] : texts(content, "text");
  return joined(
    found.filter((text) => !CLAUDE_INTERRUPTED.test(text) && !wrapped(text, CLAUDE_INJECTED)),
  );
}

function claudeReply(record: RecordObject): string | null {
  const message = record.message;
  if (record.type !== "assistant" || !object(message)) return null;
  return texts(message.content, "text").at(-1) ?? null;
}

function codexTexts(record: RecordObject, role: string, type: string): string[] {
  const payload = record.payload;
  if (record.type !== "response_item" || !object(payload)) return [];
  if (payload.type !== "message" || payload.role !== role) return [];
  return texts(payload.content, type);
}

function codexPrompt(record: RecordObject): string | null {
  return joined(
    codexTexts(record, "user", "input_text").filter((text) => !wrapped(text, CODEX_INJECTED)),
  );
}

type Reader = (record: RecordObject) => string | null;

const READERS: Record<Host, { prompt: Reader; reply: Reader }> = {
  claude: { prompt: claudePrompt, reply: claudeReply },
  codex: {
    prompt: codexPrompt,
    reply: (record) => joined(codexTexts(record, "assistant", "output_text")),
  },
  opencode: { prompt: () => null, reply: () => null },
};

export function foldDigest(digest: Digest, record: RecordObject, secrets: readonly string[]) {
  readRecord(record, digest.file);

  const reader = READERS[digest.host];
  const prompt = reader.prompt(record);
  if (prompt !== null) {
    if (digest.reply !== null) digest.turns.push({ kind: "Reply", text: digest.reply });
    digest.reply = null;
    digest.turns.push({ kind: "Prompt", text: clipped(redact(prompt, secrets)) });
    return;
  }

  const reply = reader.reply(record);
  if (reply !== null) digest.reply = clipped(redact(reply, secrets));
}

export function digestText(digest: Digest, secrets: readonly string[]): string {
  const { part } = digest.file;
  const turns =
    digest.reply === null ? digest.turns : [...digest.turns, { kind: "Reply", text: digest.reply }];

  const tools = Object.entries(part.tools).sort(([left], [right]) => (left < right ? -1 : 1));
  const models = Object.entries(part.models).sort(([left], [right]) => (left < right ? -1 : 1));

  const lines = [
    ...turns.map((turn) => `${turn.kind}: ${turn.text}`),
    "Tools:",
    ...tools.map(([name, calls]) => `${redact(name, secrets)} ${calls}`),
    "Tokens:",
    ...models.map(([model, usage]) =>
      [
        redact(model, secrets),
        redact(usage.effort, secrets),
        ...USAGE_FIELDS[digest.host].map((field) => `${field} ${usage[field] ?? 0}`),
      ].join(" "),
    ),
  ];

  return `${lines.join("\n")}\n`;
}
