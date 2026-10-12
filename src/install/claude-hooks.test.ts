import { afterEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { declinedHooks, planClaudeHooks } from "./claude-hooks.ts";
import { object, parseJson, type JsonObject } from "./json.ts";
import { hookTable } from "./hook-table.ts";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemporary(directory);
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "skills-claude-hooks-"));
  directories.push(home);

  return {
    input: { home, agents: join(home, ".agents/skills"), hooksDir: join(home, ".claude/hooks") },
    path: join(home, ".claude/settings.json"),
  };
}

test("Claude without Bun writes only the fail-closed guard", () => {
  const value = fixture();
  const settings: JsonObject = {};

  const result = planClaudeHooks(settings, { ...value.input, noBun: true }, value.path);

  expect(Object.keys(object(settings.hooks)!)).toEqual(["PreToolUse"]);
  expect(result.changes.map(({ target }) => target)).toEqual(["hook pre-tool-use"]);
  expect(result.output).toContain(
    "claude Bun is missing, so hook pre-tool-use denies every Claude shell command until Bun is installed",
  );

  for (const { target } of hookTable)
    if (target !== "hook pre-tool-use")
      expect(result.output).toContain(
        `skip   ${target} Claude entry (Bun is missing, so none is added)`,
      );
});

test("Claude gate diagnostics survive a settings read refusal", () => {
  const value = fixture();

  const result = planClaudeHooks(undefined, { ...value.input, noCli: true }, value.path);

  expect(result.changes).toEqual([]);
  expect(result.output).toHaveLength(4);

  for (const { target } of hookTable)
    expect(result.output).toContain(
      `skip   ${target} Claude entry (the repo's ${target} is not what runs, so none is added)`,
    );
});

test("Claude hook declines preserve owned commands under unreachable matchers", () => {
  const value = fixture();
  const settings: JsonObject = {
    hooks: {
      PreToolUse: [
        {
          matcher: "NotBash",
          hooks: [{ command: "~/.agents/skills/playbook/bin/skills hook pre-tool-use" }],
        },
      ],
    },
  };

  const original = structuredClone(object(settings.hooks)!.PreToolUse);
  const result = planClaudeHooks(
    settings,
    { ...value.input, noBun: true, declined: ["hook pre-tool-use"] },
    value.path,
  );

  expect(object(settings.hooks)!.PreToolUse).toEqual(original);
  expect(result.changes).toEqual([]);
  expect(result.output.some((line) => line.includes("denies every Claude"))).toBe(false);
});

test("Claude refuses numeric hook blocks without changing the document", () => {
  const value = fixture();
  const settings = object(parseJson('{"hooks": 12.50, "number": 9e2}'))!;
  const hooks = settings.hooks;

  const result = planClaudeHooks(settings, value.input, value.path);

  expect(settings.hooks).toBe(hooks);
  expect(result.changes).toEqual([]);
  expect(result.output).toContain(`skip   ${value.path} (hooks is not an object)`);
  expect(result.output).toContain(
    "Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code",
  );
});

test("Claude hook shape refusal prints only wanted hooks after gates and declines", () => {
  const value = fixture();
  const settings: JsonObject = { hooks: null };

  const result = planClaudeHooks(
    settings,
    { ...value.input, noBun: true, declined: ["hook stop"] },
    value.path,
  );

  const block = result.output.find((line) => line.startsWith('{\n  "hooks"'))!;
  expect(Object.keys(JSON.parse(block).hooks)).toEqual(["PreToolUse"]);
  expect(settings.hooks).toBeNull();
});

test.each([{ noCli: true }, { noBun: true, declined: ["hook pre-tool-use"] as const }])(
  "Claude hook shape refusal prints no paste block when gates leave nothing wanted %j",
  (options) => {
    const value = fixture();
    const result = planClaudeHooks({ hooks: null }, { ...value.input, ...options }, value.path);

    expect(result.output).toContain(`skip   ${value.path} (hooks is not an object)`);
    expect(result.output.some((line) => line.includes("Paste the Claude"))).toBe(false);
    expect(result.output.some((line) => line.startsWith("{"))).toBe(false);
  },
);

test("Claude decline keys accept only off and use the first saved value", () => {
  const value = fixture();
  const content = [
    "CLAUDE_HOOK_PRE_TOOL_USE=off",
    "CLAUDE_HOOK_PRE_TOOL_USE=on",
    "CLAUDE_HOOK_STOP=on",
    "CLAUDE_HOOK_STOP=off",
    "CLAUDE_HOOK_SESSION_START=off",
    "CLAUDE_HOOK_UNKNOWN=off",
  ].join("\r\n");

  const settings: JsonObject = {};
  const { declined } = declinedHooks(content);
  planClaudeHooks(settings, { ...value.input, declined }, value.path);

  expect(declined).toEqual(["hook session-start", "hook pre-tool-use"]);
  expect(Object.keys(object(settings.hooks)!)).toEqual(["PostToolUse", "Stop"]);
});

test("Claude malformed hook keys and values are reported with their saved spelling", () => {
  expect(
    declinedHooks(
      ["CLAUDE_HOOK_stop=off", "CLAUDE_HOOK_SESSION_START=", "CLAUDE_HOOK_POST_TOOL_USE=deny"].join(
        "\n",
      ),
    ),
  ).toEqual({
    declined: [],
    notes: [
      "CLAUDE_HOOK_stop names an unknown target, skipped",
      "CLAUDE_HOOK_SESSION_START= is not off, skipped",
      "CLAUDE_HOOK_POST_TOOL_USE=deny is not off, skipped",
    ],
  });
});

test.each([
  "~/.claude/hooks/session-brief.sh",
  "/other/hooks/session-brief.sh",
  "bash ~/.claude/hooks/session-brief.sh",
])("Claude skips an unowned retired command under a custom home %s", (command) => {
  const value = fixture();
  const old = { hooks: [{ command }] };
  const settings: JsonObject = { hooks: { SessionStart: [old] } };

  const result = planClaudeHooks(
    settings,
    { ...value.input, hooksDir: join(value.input.home, "custom/hooks") },
    value.path,
  );

  expect(object(settings.hooks)!.SessionStart).toEqual([old]);
  expect(result.output).toContain(
    `skip   hook session-start Claude entry (${value.path} already runs ${command}, which this repo did not install)`,
  );
});

test("a dropped retired hook names why it was dropped", () => {
  const value = fixture();
  const current = "~/.agents/skills/playbook/bin/skills hook stop";
  const settings: JsonObject = {
    hooks: {
      Stop: [
        { hooks: [{ type: "command", command: current }] },
        { hooks: [{ type: "command", command: join(value.input.hooksDir, "reply-guard.sh") }] },
      ],
    },
  };

  const result = planClaudeHooks(settings, value.input, value.path);

  expect(result.output).toContain(
    `claude drop Stop ${join(value.input.hooksDir, "reply-guard.sh")} (Stop already runs ${current})`,
  );

  expect(object(settings.hooks)!.Stop).toEqual([
    { hooks: [{ type: "command", command: current }] },
  ]);
});
