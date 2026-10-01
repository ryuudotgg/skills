import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { claudeBlock, hookBlock, hookTable } from "./hook-table.ts";

const repo = resolve(import.meta.dir, "../..");

function pageBlock(name: string): string {
  const page = readFileSync(resolve(repo, `docs/content/docs/agents/${name}.mdx`), "utf8");
  const blocks = Array.from(page.matchAll(/```json\n([\s\S]*?)\n```/g), (match) => match[1]!);
  const hookBlocks = blocks.filter((block) => Object.hasOwn(JSON.parse(block), "hooks"));
  expect(hookBlocks).toHaveLength(1);

  return hookBlocks[0]!;
}

test("hook table contains only CLI verbs", () => {
  expect(hookTable).toHaveLength(4);
  for (const entry of hookTable) expect(entry.target).toStartWith("hook ");
});

test("agent page matcher: Claude and Codex blocks equal the registered hook rendering", () => {
  expect(claudeBlock("~/.agents/skills")).toBe(pageBlock("claude-code"));
  expect(hookBlock("/Users/you/.agents/skills", "codex")).toBe(pageBlock("codex"));
});

test("custom AGENTS_DIR commands are shell quoted and JSON escaped", () => {
  const block = JSON.parse(claudeBlock('/some path/it\'s "mine"'));
  expect(block.hooks.Stop[0].hooks[0].command).toBe(
    "'/some path/it'\\''s \"mine\"/playbook/bin/skills' hook stop",
  );
});
