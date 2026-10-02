import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { object, recordsFromFile, type RecordObject } from "../sessions/jsonl.ts";

const lineBreak = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/u;
const missing = /command not found|not found|No such file or directory/u;
const lookupCommand =
  /(?<![\p{L}\p{N}_])command\s+-v(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])which(?![\p{L}\p{N}_])/u;

function readText(path: string): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(path));
}

function eventsFromFile(path: string): RecordObject[] {
  const notes: string[] = [];
  const events = [...recordsFromFile(path, notes)];
  if (notes.length) throw new Error(notes.join("\n"));

  return events;
}

function blocks(event: RecordObject): RecordObject[] {
  const message = event.message;
  if (!object(message)) return [];

  const content = message.content;
  if (typeof content === "string") return [{ type: "text", text: content }];

  return Array.isArray(content) ? content.filter(object) : [];
}

function display(value: unknown): string {
  if (value === undefined || value === null) return "null";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function get(record: RecordObject, key: string, fallback: unknown = null): unknown {
  return key in record ? record[key] : fallback;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(contentText).join("\n");
  if (object(content)) {
    if (content.type === "thinking") return "";
    if ("text" in content) return contentText(content.text);
    if ("content" in content) return contentText(content.content);
  }

  return content === undefined || content === null ? "" : JSON.stringify(content);
}

function clipped(value: unknown, head = 2000, tail = 1000): string {
  const text = contentText(value);
  const characters = [...text];
  const dropped = characters.length - head - tail;
  if (dropped <= 0) return text;

  const marker = `[dropped ${dropped} characters]`;
  return `${characters.slice(0, head).join("")}\n${marker}\n${characters.slice(-tail).join("")}\n${marker}`;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length !== 0;
  if (object(value)) return Object.keys(value).length !== 0;
  return Boolean(value);
}

export function digestText(path: string): string {
  const events = eventsFromFile(path);
  const lines = [`Full transcript: ${realpathSync(path)}`];
  const tools = new Map<unknown, unknown>();
  for (const event of events)
    for (const block of blocks(event))
      if (block.type === "tool_use") tools.set(get(block, "id"), get(block, "name", "unknown"));

  const final = events.findLast(
    (event) => event.type === "result" && get(event, "parent_tool_use_id") === null,
  );

  for (const event of events) {
    const label = get(event, "parent_tool_use_id") !== null ? "[sub] " : "";
    if (event.type === "system") {
      if (event.subtype === "permission_denied")
        lines.push(
          `${label}permission_denied ${display(get(event, "tool_name", get(event, "tool", "unknown")))}`,
        );

      continue;
    }

    for (const block of blocks(event))
      if (block.type === "text" && event.type === "assistant")
        lines.push(`${label}${contentText(block.text)}`);
      else if (block.type === "tool_use") {
        const fields = [
          `${label}tool_use ${display(get(block, "name", "unknown"))}`,
          `id=${display(get(block, "id", ""))}`,
        ];

        const inputs = block.input;
        if (object(inputs))
          for (const key of ["subagent_type", "description", "command", "file_path"])
            if (key in inputs)
              fields.push(`${key}=${JSON.stringify(clipped(inputs[key], 1000, 1000))}`);

        lines.push(fields.join(" "));
      } else if (block.type === "tool_result") {
        const toolId = get(block, "tool_use_id", "");
        const error = truthy(block.is_error) ? " is_error=true" : "";
        lines.push(
          `${label}tool_result ${display(tools.has(toolId) ? tools.get(toolId) : "unknown")} tool_use_id=${display(toolId)}${error}\n${clipped(block.content)}`,
        );
      }

    if (event === final) lines.push("Agent's final reply:", contentText(event.result));
  }

  return `${lines.join("\n")}\n`;
}

function pathName(path: string): string {
  return (
    path
      .split("/")
      .filter((part) => part !== "" && part !== ".")
      .at(-1) ?? ""
  );
}

function reachablePaths(
  result: string,
  command: string,
  name: string,
  known: Set<string>,
): string[] {
  const found: string[] = [];
  for (const line of result
    .split(lineBreak)
    .filter((line, index, lines) => line !== "" || index !== lines.length - 1)) {
    const candidate = line.trim().replace(/^['"]+|['"]+$/gu, "");
    if (!candidate.startsWith("/") || command.includes(candidate) || pathName(candidate) !== name)
      continue;

    if (existsSync(candidate) && statSync(candidate).isDirectory()) continue;

    let executable = false;
    try {
      accessSync(candidate, constants.X_OK);
      executable = true;
    } catch {}

    if (known.has(candidate) || !existsSync(candidate) || executable) found.push(candidate);
  }

  return found;
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function hideCheckText(
  hidePath: string,
  canaryPath: string,
  transcriptPath: string,
): string {
  const events = eventsFromFile(transcriptPath);
  const names = readText(hidePath)
    .split(lineBreak)
    .map((line) => line.trim())
    .filter(Boolean);

  const canaries = readText(canaryPath)
    .split(lineBreak)
    .filter((line) => line.startsWith("/"));

  const results = new Map<unknown, RecordObject[]>();
  const commands: { id: unknown; command: string }[] = [];
  for (const event of events)
    for (const block of blocks(event))
      if (block.type === "tool_result") {
        const toolId = get(block, "tool_use_id");
        const paired = results.get(toolId) ?? [];
        paired.push(block);
        results.set(toolId, paired);
      } else if (
        block.type === "tool_use" &&
        block.name === "Bash" &&
        object(block.input) &&
        typeof block.input.command === "string"
      )
        commands.push({ id: get(block, "id"), command: block.input.command });

  const lines: string[] = [];
  for (const name of names) {
    const pattern = escapePattern(name);
    const namePattern = new RegExp(`(?<![\\p{L}\\p{N}_.-])${pattern}(?![\\p{L}\\p{N}_.-])`, "u");
    const invocationPattern = new RegExp(
      `(?:^|;|&&|\\|\\||\\||\\n)[ \\t]*${pattern}(?=$|\\s|[;|&<>])`,
      "u",
    );

    const known = new Set(canaries.filter((path) => pathName(path) === name));
    const leaked: string[] = [];
    const probes: { command: string; result: string }[] = [];

    let hidden = false;
    for (const { id, command } of commands) {
      const lookup = lookupCommand.test(command) && namePattern.test(command);
      if (!invocationPattern.test(command) && !lookup) continue;

      const paired = results.get(id);
      if (!paired?.length) continue;

      const result = paired.map((block) => contentText(block.content)).join("\n");
      probes.push({ command, result });
      leaked.push(...reachablePaths(result, command, name, known));

      if (
        lookup ||
        result.split(lineBreak).some((line) => namePattern.test(line) && missing.test(line))
      )
        hidden = true;
    }

    lines.push(`${leaked.length ? "LEAKED" : hidden ? "HIDDEN" : "UNCHECKED"} ${name}`);

    for (const path of [...new Set(leaked)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ))
      lines.push(`  reachable at: ${path}`);

    for (const { command, result } of probes)
      lines.push(`  command: ${command}`, `  result: ${[...result].slice(0, 200).join("")}`);
  }

  return lines.length ? `${lines.join("\n")}\n` : "";
}
