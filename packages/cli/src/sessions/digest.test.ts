import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "skills-core";
import { digestText, foldDigest, freshDigest } from "./digest.ts";
import type { RecordObject } from "./jsonl.ts";

const home = join(import.meta.dir, "fixture", "home");

const claude = join(
  home,
  ".claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl",
);

const codex = join(
  home,
  ".codex/sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-fixture.jsonl",
);

const secrets = readFileSync(join(import.meta.dir, "fixture", "secrets.txt"), "utf8")
  .split("\n")
  .flatMap((line) => line.split("\t")[2] ?? []);

function digestOf(host: Host, records: readonly RecordObject[]): string {
  const digest = freshDigest(host);
  for (const record of records) foldDigest(digest, record, []);
  return digestText(digest, []);
}

function recordsOf(path: string): RecordObject[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecordObject);
}

test("a Claude digest lists each prompt, the reply that ends its run, tools and tokens", () => {
  const records = recordsOf(claude);
  const lines = digestOf("claude", records).split("\n");
  const bash = JSON.stringify(records).match(/"type":"tool_use","id":"\w+","name":"Bash"/g);

  expect(lines.filter((line) => line.startsWith("Prompt: "))).toHaveLength(1);
  expect(lines.filter((line) => line.startsWith("Reply: "))).toHaveLength(1);
  expect(lines).toContain(`Bash ${bash?.length}`);
  expect(lines.slice(lines.indexOf("Tokens:") + 1).filter(Boolean)).toEqual([
    expect.stringMatching(/^claude-opus-5-5 \S+ in \d+ out \d+ cacheRead \d+ cacheWrite \d+$/),
  ]);
});

test("a digest holds no planted secret and marks what it redacted", () => {
  const text = digestOf("claude", recordsOf(claude));
  expect(text).toContain("[redacted:");
  for (const secret of secrets) expect(text).not.toContain(secret);
});

test("a Codex digest reads user and assistant messages", () => {
  const lines = digestOf("codex", recordsOf(codex)).split("\n");

  expect(lines.filter((line) => line.startsWith("Prompt: "))).toHaveLength(2);
  expect(lines.filter((line) => line.startsWith("Reply: "))).toHaveLength(1);
  expect(lines.indexOf("Tools:")).toBeGreaterThan(
    lines.findLastIndex((line) => line.startsWith("Reply: ")),
  );
});

test("a long reply is clipped after redaction and says how much it dropped", () => {
  const reply = `${"word ".repeat(500)}AKIA7KYSXW5ZUZHJB2MQ`;
  const records = [
    { type: "user", message: { content: "go" } },
    { type: "assistant", message: { content: [{ type: "text", text: reply }] } },
  ];

  const line = digestOf("claude", records)
    .split("\n")
    .find((each) => each.startsWith("Reply: "));

  expect(line?.length).toBeGreaterThan(2_000);
  expect(line).toMatch(/ \[dropped \d+ characters\]$/);
  expect(line).not.toContain("AKIA");
});

test("meta and tool result user records are not prompts", () => {
  const lines = digestOf("claude", [
    { type: "user", isMeta: true, message: { content: "caveat" } },
    { type: "user", message: { content: [{ type: "tool_result", content: "out" }] } },
    { type: "user", message: { content: "real" } },
  ]).split("\n");

  expect(lines.filter((line) => line.startsWith("Prompt: "))).toEqual(["Prompt: real"]);
});

test("Claude prompts sent as text blocks are prompts, and image, tool and interrupt records are not", () => {
  const reply = (text: string) => ({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });

  const user = (content: unknown) => ({ type: "user", message: { content } });
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AA==" },
  };

  const lines = digestOf("claude", [
    user("start"),
    reply("first"),
    user([image, { type: "text", text: "what is this?" }]),
    reply("second"),
    user([{ type: "text", text: "and this" }]),
    reply("third"),
    user([image]),
    reply("fourth"),
    user([{ type: "tool_result", tool_use_id: "t1", content: "out" }]),
    reply("fifth"),
    user([{ type: "text", text: "[Request interrupted by user]" }]),
    reply("sixth"),
    user("[Request interrupted by user for tool use]"),
    reply("seventh"),
  ]).split("\n");

  expect(lines.slice(0, lines.indexOf("Tools:"))).toEqual([
    "Prompt: start",
    "Reply: first",
    "Prompt: what is this?",
    "Reply: second",
    "Prompt: and this",
    "Reply: seventh",
  ]);
});

test("injected task notifications and Codex context blocks are not prompts", () => {
  const prompts = (text: string) => text.split("\n").filter((line) => line.startsWith("Prompt: "));
  const fromClaude = prompts(digestOf("claude", recordsOf(claude)));
  const fromCodex = prompts(digestOf("codex", recordsOf(codex)));
  for (const line of [...fromClaude, ...fromCodex]) {
    expect(line).not.toContain("task-notification");
    expect(line).not.toContain("AGENTS.md instructions");
    expect(line).not.toContain("<environment_context>");
  }

  expect(fromCodex).toHaveLength(2);

  const mixed = {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [
        { type: "input_text", text: "<environment_context>\n</environment_context>" },
        { type: "input_text", text: "Ship it." },
      ],
    },
  };

  expect(prompts(digestOf("codex", [mixed]))).toEqual(["Prompt: Ship it."]);

  const typed = { type: "user", origin: { kind: "human" }, message: { content: "typed" } };
  expect(prompts(digestOf("claude", [typed]))).toEqual(["Prompt: typed"]);

  const older = {
    type: "user",
    message: { content: "<task-notification><task-id>b1</task-id></task-notification>" },
  };

  expect(prompts(digestOf("claude", [older, typed]))).toEqual(["Prompt: typed"]);
});

test("a pasted injection header followed by a request stays a prompt", () => {
  const pasted =
    "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>\nBe terse.\n</INSTRUCTIONS>\n\nTrim this.";

  const record = {
    type: "response_item",
    payload: { type: "message", role: "user", content: [{ type: "input_text", text: pasted }] },
  };

  const lines = digestOf("codex", [record]).split("\n");
  expect(lines.filter((line) => line.startsWith("Prompt: "))).toHaveLength(1);
  expect(lines).toContain("Trim this.");
});
