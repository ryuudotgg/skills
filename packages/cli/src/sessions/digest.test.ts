import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Host } from "skills-core";
import { digestText, foldDigest, freshDigest, type Digest } from "./digest.ts";
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

const said = (text: string) => ({
  type: "assistant",
  message: { content: [{ type: "text", text }] },
});

const typed = (content: string) => ({ type: "user", message: { content } });

test("saved turns take the current secrets", () => {
  const value = "plum-otter-4471-quiet";
  const folded = freshDigest("claude");
  foldDigest(folded, typed(`deploy with ${value}`), []);
  foldDigest(folded, said(`used ${value} for it`), []);

  const digest = JSON.parse(JSON.stringify(folded)) as Digest;
  foldDigest(digest, typed("next"), [value]);

  const text = digestText(digest, [value]);
  expect(text).not.toContain(value);
  expect(text.split("\n").slice(0, 3)).toEqual([
    "Prompt: deploy with [redacted:env]",
    "Reply: used [redacted:env] for it",
    "Prompt: next",
  ]);
});

test("compaction summaries and local command output are not prompts", () => {
  const summary = {
    type: "user",
    isCompactSummary: true,
    message: {
      content: "This session is being continued from a previous conversation.",
    },
  };

  const text = digestOf("claude", [
    typed("first"),
    said("one"),
    summary,
    typed("<local-command-stdout>ok</local-command-stdout>"),
    said("two"),
    typed("typed"),
  ]);

  expect(text.split("\n").slice(0, text.split("\n").indexOf("Tools:"))).toEqual([
    "Prompt: first",
    "Reply: two",
    "Prompt: typed",
  ]);

  expect(text).not.toContain("This session is being continued");
  expect(text).not.toContain("local-command-stdout");
});

test("a typed prompt quoting local command output stays a prompt", () => {
  const quoted = "why did <local-command-stdout>ok</local-command-stdout> print?";
  const lines = digestOf("claude", [typed(quoted)]).split("\n");
  expect(lines).toContain(`Prompt: ${quoted}`);

  const between = [
    "<local-command-stdout>first</local-command-stdout>",
    "Compare these outputs.",
    "<local-command-stdout>second</local-command-stdout>",
  ].join("\n");

  expect(digestOf("claude", [typed("<local-command-stdout>")])).toStartWith(
    "Prompt: <local-command-stdout>\n",
  );

  const text = digestOf("claude", [typed("start"), said("one"), typed(between), said("two")]);
  expect(text).toStartWith(`Prompt: start\nReply: one\nPrompt: ${between}\nReply: two\nTools:\n`);
});

test("a turn renders as saved where one redact pass would leave work for the next", () => {
  const cases: [text: string, secrets: string[]][] = [
    ["word ".repeat(401), ["characters"]],
    [`${" ".repeat(1991)}redacted`, ["redacted"]],
    [`${"abcdefgh".padStart(2_000, " ")}X`, ["abcdefgh"]],
    [
      '"left" bad "right \\u0070lum-otter-4471-quiet"',
      ['left" bad "right', "plum-otter-4471-quiet"],
    ],
  ];

  for (const [text, known] of cases) {
    const digest = freshDigest("claude");
    foldDigest(digest, typed(text), known);

    const saved = digest.turns[0]!.text;
    expect(saved).toContain("[redacted:env]");
    expect(digestText(digest, known)).toStartWith(`Prompt: ${saved}\n`);
  }
});

test("a turn takes a new secret wherever it sits", () => {
  const cases: [text: string, value: string][] = [
    [
      "[redacted:plum-otter-4471-quiet".padStart(2_000, " ") + " ordinary text",
      "plum-otter-4471-quiet",
    ],
    ["trace [dropped 12345678 characters]", "12345678"],
    ['{"pin":48273165}', "48273165"],
    ["kept [redacted:plum-otter-4471-quiet] here", "plum-otter-4471-quiet"],
  ];

  for (const [text, value] of cases) {
    const digest = freshDigest("claude");
    foldDigest(digest, typed(text), []);
    expect(digestText(digest, [value])).not.toContain(value);
  }
});

test("same secrets render the same text", () => {
  const secret = secrets.find((each) => each.startsWith("AKIA"))!;
  const digest = freshDigest("claude");
  for (const record of recordsOf(claude)) foldDigest(digest, record, [secret]);

  const turns = [
    ...digest.turns,
    ...(digest.reply === null ? [] : [{ kind: "Reply", text: digest.reply }]),
  ];

  const lines = digestText(digest, [secret])
    .split("\n")
    .filter((line) => line.startsWith("Prompt: ") || line.startsWith("Reply: "));

  expect(turns.map((turn) => turn.text).join("\n")).toContain("[redacted:");
  expect(turns.some((turn) => turn.text.endsWith(" characters]"))).toBe(true);
  expect(lines).toEqual(turns.map((turn) => `${turn.kind}: ${turn.text}`));
});
