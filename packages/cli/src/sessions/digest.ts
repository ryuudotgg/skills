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

function claudePrompt(record: RecordObject): string | null {
  const message = record.message;
  if (record.type !== "user" || record.isMeta === true || !object(message)) return null;
  return typeof message.content === "string" ? message.content : null;
}

function claudeReply(record: RecordObject): string | null {
  const message = record.message;
  if (record.type !== "assistant" || !object(message)) return null;
  return texts(message.content, "text").at(-1) ?? null;
}

function codexMessage(record: RecordObject, role: string, type: string): string | null {
  const payload = record.payload;
  if (record.type !== "response_item" || !object(payload)) return null;
  if (payload.type !== "message" || payload.role !== role) return null;

  const found = texts(payload.content, type);
  return found.length > 0 ? found.join("\n") : null;
}

type Reader = (record: RecordObject) => string | null;

const READERS: Record<Host, { prompt: Reader; reply: Reader }> = {
  claude: { prompt: claudePrompt, reply: claudeReply },
  codex: {
    prompt: (record) => codexMessage(record, "user", "input_text"),
    reply: (record) => codexMessage(record, "assistant", "output_text"),
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
