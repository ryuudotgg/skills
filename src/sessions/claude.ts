import { childPath, object, parseTimestamp, pathString, recentFiles, recordsFromFile } from "./jsonl.ts";
import type { Notes, RecordObject } from "./jsonl.ts";

export type TranscriptEvent = {
  timestamp: number;
  type: "user" | "assistant" | "system";
  text: string;
  blocks: RecordObject[];
  model: string | null;
  usage: RecordObject | null;
  isMeta: boolean;
};
export type Subagent = {
  agentType: string;
  model: string;
  effort: string;
  startedAt: number;
  endedAt: number;
  assistantMessages: number;
};

export function encodedProjectDir(home: string, cwd: string): string {
  return childPath(childPath(pathString(home), ".claude/projects"), cwd.replace(/[^A-Za-z0-9]/gu, "-"));
}

export function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (object(value)) return Object.keys(value).length > 0;
  return Boolean(value);
}

export function setting(values: Set<string>): string {
  if (values.size === 0) return "unknown";
  if (values.size > 1) return "mixed";
  return values.values().next().value!;
}

export function extractedText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const texts: string[] = [];
  for (const block of content)
    if (object(block) && block.type === "text" && typeof block.text === "string") texts.push(block.text);

  return texts.join("");
}

export function transcriptEvent(record: RecordObject): TranscriptEvent | null {
  const timestamp = parseTimestamp(record.timestamp);
  const type = record.type;
  const message = record.message;
  if (timestamp === null || (type !== "user" && type !== "assistant" && type !== "system") || !object(message)) return null;

  const content = message.content;
  return {
    timestamp,
    type,
    text: extractedText(content),
    blocks: Array.isArray(content) ? content.filter(object) : [],
    model: typeof message.model === "string" ? message.model : null,
    usage: object(message.usage) ? message.usage : null,
    isMeta: truthy(record.isMeta),
  };
}

export function subagentFromRecords(records: Iterable<RecordObject>): Subagent | null {
  const timestamps: number[] = [];
  const models = new Set<string>();
  const efforts = new Set<string>();

  let agentType = "unknown";
  let assistantMessages = 0;
  for (const record of records) {
    const timestamp = parseTimestamp(record.timestamp);
    if (timestamp !== null) timestamps.push(timestamp);

    const candidate = truthy(record.attributionAgent) ? record.attributionAgent : record.agentType;
    if (typeof candidate === "string" && candidate) agentType = candidate;
    if (record.type !== "assistant") continue;

    assistantMessages++;
    const model = object(record.message) ? record.message.model : null;
    if (typeof model === "string" && model) models.add(model);
    if (typeof record.effort === "string" && record.effort) efforts.add(record.effort);
  }

  if (!timestamps.length) return null;

  return {
    agentType,
    model: setting(models),
    effort: setting(efforts),
    startedAt: timestamps.reduce((earliest, timestamp) => Math.min(earliest, timestamp)),
    endedAt: timestamps.reduce((latest, timestamp) => Math.max(latest, timestamp)),
    assistantMessages,
  };
}

export function* readTranscripts(projectDir: string, cutoffMicros: number, notes: Notes): Generator<TranscriptEvent[]> {
  for (const path of recentFiles([projectDir, "*.jsonl"], cutoffMicros, notes)) {
    const events: TranscriptEvent[] = [];
    for (const record of recordsFromFile(path, notes)) {
      const event = transcriptEvent(record);
      if (event) events.push(event);
    }

    yield events;
  }
}

export function readSubagents(projectDir: string, cutoffMicros: number, notes: Notes): Subagent[] {
  const subagents: Subagent[] = [];
  for (const path of recentFiles([projectDir, "*", "subagents", "*.jsonl"], cutoffMicros, notes)) {
    const subagent = subagentFromRecords(recordsFromFile(path, notes));
    if (subagent !== null && subagent.startedAt >= cutoffMicros) subagents.push(subagent);
  }

  return subagents;
}
