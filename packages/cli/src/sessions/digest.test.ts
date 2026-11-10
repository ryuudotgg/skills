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
