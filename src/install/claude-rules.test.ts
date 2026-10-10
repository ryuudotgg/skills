import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readRuleGroups, type RuleGroup } from "../deny-set.ts";
import { readDeliveryConfig } from "../delivery.ts";
import { shellQuote } from "../shell.ts";
import { removeTemporary } from "../test/process.ts";
import {
  applyClaudeRules,
  commitGuardWired,
  fallbackSet,
  groupSummaries,
  managedRulesOnly,
  parseLevels,
  planClaudeRules,
  terminalFailures,
  type ClaudeRulesInput,
} from "./claude-rules.ts";
import { object, parseJson, type Json, type JsonObject } from "./json.ts";
import { type Change, type RulesInput } from "./rules.ts";
import { MetadataCopyError } from "./settings-file.ts";

const root = resolve(import.meta.dir, "../../skills");
const groups = readRuleGroups(root);
const cli = join(root, "playbook/bin/skills");
const directories: string[] = [];
const allow: RuleGroup = {
  kind: "allow",
  id: "cli",
  label: "CLI",
  entries: ["Bash(skills *)"],
  cells: { "hands-off": "allow", prs: "allow" },
};

function fixture(content = "DELIVERY=prs\nAGENT_RULES=deny\n"): ClaudeRulesInput {
  const home = mkdtempSync(join(tmpdir(), "claude-rules-"));
  directories.push(home);

  const current = {
    claude: join(home, ".claude"),
    agents: join(home, ".agents/skills"),
    conf: join(home, ".agents/skills.conf"),
    codex: join(home, ".codex"),
    checkout: dirname(root),
  };

  mkdirSync(current.claude);
  mkdirSync(dirname(current.conf));
  writeFileSync(current.conf, content);

  return {
    root,
    home,
    current,
    config: readDeliveryConfig({ SKILLS_CONF: current.conf }),
    mode: "prs",
    path: join(current.claude, "settings.json"),
    env: {},
    stdin: {},
    stdout: {},
    managedPaths: [],
  };
}

function guard(
  command = `${cli} hook pre-tool-use`,
  matcher: Json | undefined = "Bash",
): JsonObject {
  return {
    hooks: {
      PreToolUse: [
        { ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] },
      ],
    },
  };
}

function rules(input: ClaudeRulesInput, overrides: Partial<RulesInput> = {}): RulesInput {
  return {
    groups,
    mode: input.mode,
    levels: { global: "deny", groups: {} },
    settings: {},
    guard: false,
    home: input.home,
    current: input.current,
    defaults: input.current,
    ...overrides,
  };
}

function change(group: string, from: Change["from"], to: Change["to"]): Change {
  return {
    group,
    from,
    to,
    text: "Bash(example *)",
    class: "neutral",
    spellings: ["Bash(example *)"],
  };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporary));
});

describe("level parsing", () => {
  test.each([
    [
      "AGENT_RULES_PUBLISHING=allow",
      "AGENT_RULES_PUBLISHING=allow is not deny, ask or off, skipped",
    ],
    ["AGENT_RULES_CLI=deny", "AGENT_RULES_CLI=deny is not allow or off, skipped"],
    ["AGENT_RULES_CLI=ask", "AGENT_RULES_CLI=ask is not allow or off, skipped"],
    ["AGENT_RULES_UNKNOWN=deny", "AGENT_RULES_UNKNOWN names an unknown group, skipped"],
    [
      "AGENT_RULES_SKILLS_CONF_WRITE=off",
      "AGENT_RULES_SKILLS_CONF_WRITE names a retired group, skipped",
    ],
  ])("rejects %s", (entry, note) => {
    expect(parseLevels(`AGENT_RULES=deny\n${entry}\n`, [...groups, allow])).toEqual({
      levels: { global: "deny", groups: {} },
      notes: [note],
    });
  });

  test.each(["allow", "invalid", ""])("rejects global %s as unmanaged", (global) => {
    expect(parseLevels(`AGENT_RULES=${global}\n`, groups)).toEqual({
      notes: [`AGENT_RULES=${global} is not deny, ask or off, skipped`],
    });
  });

  test.each(["deny", "ask", "off"] as const)("accepts global and deny override %s", (level) => {
    expect(
      parseLevels(`AGENT_RULES=${level}\r\nAGENT_RULES_PR_COMMENT=${level}\r\n`, groups),
    ).toEqual({ levels: { global: level, groups: { "pr-comment": level } }, notes: [] });
  });

  test.each(["allow", "off"] as const)("accepts allow override %s", (level) => {
    expect(parseLevels(`AGENT_RULES=ask\nAGENT_RULES_CLI=${level}\n`, [allow])).toEqual({
      levels: { global: "ask", groups: { cli: level } },
      notes: [],
    });
  });

  test("keeps the first repeated group key", () => {
    expect(
      parseLevels("AGENT_RULES=deny\nAGENT_RULES_MERGE=ask\nAGENT_RULES_MERGE=off\n", groups),
    ).toEqual({
      levels: { global: "deny", groups: { merge: "ask" } },
      notes: ["AGENT_RULES_MERGE is set more than once, later values skipped"],
    });
  });

  test("keeps the first repeated global key", () => {
    expect(parseLevels("AGENT_RULES=deny\nAGENT_RULES=allow\n", groups)).toEqual({
      levels: { global: "deny", groups: {} },
      notes: ["AGENT_RULES is set more than once, later values skipped"],
    });
  });

  test("an invalid first duplicate stays unmanaged", () => {
    expect(parseLevels("AGENT_RULES=allow\nAGENT_RULES=deny\n", groups).levels).toBeUndefined();
  });

  test("overrides without a global level give one note", () => {
    expect(parseLevels("AGENT_RULES_MERGE=ask\nAGENT_RULES_PUBLISHING=off\n", groups)).toEqual({
      notes: ["AGENT_RULES is unset, group overrides skipped"],
    });
  });

  test("ignores unrelated keys and comments", () => {
    expect(parseLevels("# AGENT_RULES=deny\nDELIVERY=prs\nCLAUDE_FAST_MODE=yes\n", groups)).toEqual(
      { notes: [] },
    );
  });
});

describe("commit guard wiring", () => {
  test.each([
    [undefined, true],
    [null, true],
    ["", true],
    ["*", true],
    ["Bash", true],
    ["Bash|Edit", true],
    ["Edit|Bash", true],
    ["NotBash", false],
    ["ash", false],
    ["BashExtra", false],
    ["Edit", false],
    ["^Bash$", true],
    ["^(Bash|Edit)$", true],
    ["ash$", true],
    ["[", false],
    [true, false],
    [[], false],
    [{}, false],
  ] as const)("matcher %j reaches Bash: %s", (matcher, expected) => {
    expect(
      commitGuardWired(guard(undefined, matcher as Json | undefined), "/home/user", cli, []),
    ).toBe(expected);
  });

  test("resolves a home path and a symlink to this CLI", () => {
    const input = fixture();
    const link = join(input.home, "skills");
    symlinkSync(cli, link);

    expect(commitGuardWired(guard("~/skills hook pre-tool-use"), input.home, cli, [])).toBe(true);
  });

  test("a hook on the store CLI counts while the store still links another checkout", () => {
    const input = fixture();
    const elsewhere = join(input.home, "other/skills");
    mkdirSync(dirname(elsewhere), { recursive: true });
    writeFileSync(elsewhere, "");

    const store = join(input.home, ".agents/skills/playbook/bin/skills");
    mkdirSync(dirname(store), { recursive: true });
    symlinkSync(elsewhere, store);

    const settings = guard(`${store} hook pre-tool-use`);

    expect(commitGuardWired(settings, input.home, cli, [])).toBe(false);
    expect(commitGuardWired(settings, input.home, cli, [], store)).toBe(true);
  });

  test("unquotes the shellQuote form including spaces and apostrophes", () => {
    const input = fixture();
    const link = join(input.home, "skill's CLI");
    symlinkSync(cli, link);

    expect(
      commitGuardWired(guard(`${shellQuote(link)} hook pre-tool-use`), input.home, cli, []),
    ).toBe(true);
  });

  test.each([
    "/missing hook pre-tool-use",
    `${cli} hook stop`,
    `sh ${cli} hook pre-tool-use`,
    `${cli} hook pre-tool-use && true`,
    `'${cli}'x hook pre-tool-use`,
  ])("rejects command %s", (command) => {
    expect(commitGuardWired(guard(command), "/home/user", cli, [])).toBe(false);
  });

  test("a quoted tilde or a relative path is not wired", () => {
    const input = fixture();
    symlinkSync(cli, join(input.home, "skills"));

    for (const command of ["'~/skills' hook pre-tool-use", "skills hook pre-tool-use"])
      expect(commitGuardWired(guard(command), input.home, cli, [])).toBe(false);
  });

  test("an entry filtered by if is not wired", () => {
    const command = `${cli} hook pre-tool-use`;
    const hook = { type: "command", command, if: "Bash(git commit *)" };
    const settings: JsonObject = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [hook] }] } };

    expect(commitGuardWired(settings, "/home/user", cli, [])).toBe(false);
  });

  test("a different checkout CLI is not wired", () => {
    const input = fixture();
    const other = join(input.home, "other-skills");
    writeFileSync(other, "#!/bin/sh\n");

    expect(commitGuardWired(guard(`${other} hook pre-tool-use`), input.home, cli, [])).toBe(false);
  });

  test("a failed realpath on the expected CLI is unwired", () => {
    expect(commitGuardWired(guard(), "/home/user", "/missing", [])).toBe(false);
  });

  test.each([
    {},
    { hooks: null },
    { hooks: [] },
    { hooks: { PreToolUse: {} } },
    { hooks: { PreToolUse: [null, true, "text", {}] } },
    { hooks: { PreToolUse: [{ hooks: {} }] } },
    {
      hooks: { PreToolUse: [{ hooks: [null, true, {}, { command: `${cli} hook pre-tool-use` }] }] },
    },
    {
      hooks: { PreToolUse: [{ hooks: [{ type: "prompt", command: `${cli} hook pre-tool-use` }] }] },
    },
    {
      hooks: {
        PreToolUse: [
          { hooks: [{ type: "command", command: `${cli} hook pre-tool-use`, async: true }] },
        ],
      },
    },
    { hooks: { Stop: [{ hooks: [{ type: "command", command: `${cli} hook pre-tool-use` }] }] } },
  ])("wrong shape or hook %j is unwired without throwing", (data) => {
    expect(commitGuardWired(data as JsonObject, "/home/user", cli, [])).toBe(false);
  });

  test("disableAllHooks true overrides a wired entry", () => {
    expect(commitGuardWired({ ...guard(), disableAllHooks: true }, "/home/user", cli, [])).toBe(
      false,
    );

    expect(commitGuardWired({ ...guard(), disableAllHooks: false }, "/home/user", cli, [])).toBe(
      true,
    );
  });

  test.each(["allowManagedHooksOnly", "disableAllHooks"])(
    "managed %s disables the user guard",
    (flag) => {
      const input = fixture();
      const path = join(input.home, "managed.json");
      writeFileSync(path, JSON.stringify({ [flag]: true }));

      expect(commitGuardWired(guard(), input.home, cli, [path])).toBe(false);
    },
  );
});

describe("warnings and summaries", () => {
  test("only managed files with the permission flag true warn", () => {
    const input = fixture();
    const paths = [true, false, "true", null].map((value, index) => {
      const path = join(input.home, `managed-${index}.json`);
      writeFileSync(path, JSON.stringify({ allowManagedPermissionRulesOnly: value }));
      return path;
    });

    const invalid = join(input.home, "invalid.json");
    writeFileSync(invalid, "{invalid");

    expect(managedRulesOnly([...paths, invalid, join(input.home, "missing.json")])).toEqual([
      paths[0]!,
    ]);
  });

  test.each([
    [true, true, undefined, []],
    [false, true, undefined, ["stdin is not a terminal"]],
    [true, false, undefined, ["stdout is not a terminal"]],
    [true, true, "", ["CI is set"]],
    [false, false, "true", ["stdin is not a terminal", "stdout is not a terminal", "CI is set"]],
  ] as const)("terminal failures for stdin %s stdout %s CI %s", (stdin, stdout, ci, expected) => {
    expect(
      terminalFailures(ci === undefined ? {} : { CI: ci }, { isTTY: stdin }, { isTTY: stdout }),
    ).toEqual([...expected]);
  });

  test("groups counts and verbs in first seen order", () => {
    expect(
      groupSummaries([
        change("first", [], "deny"),
        change("second", ["deny"], "absent"),
        change("first", [], "deny"),
        change("first", ["deny"], "deny"),
        change("first", ["deny", "ask"], "ask"),
        change("first", ["deny", "ask"], "allow"),
        change("first", ["deny", "ask"], "absent"),
      ]),
    ).toEqual([
      {
        group: "first",
        summary:
          "add 2 to deny, rewrite 1 in deny, move 1 from deny to ask, move 1 from deny/ask to allow, remove 1 from deny/ask",
      },
      { group: "second", summary: "remove 1 from deny" },
    ]);
  });
});

describe("fallback set", () => {
  test("renders all nonempty lists with expanded placeholders", () => {
    const input = fixture();
    const custom: RuleGroup[] = [
      {
        kind: "deny",
        id: "deny",
        label: "deny",
        entries: ["Edit({conf})"],
        cells: { "hands-off": "deny", prs: "deny" },
      },
      {
        kind: "deny",
        id: "ask",
        label: "ask",
        entries: ["Bash(ask *)"],
        cells: { "hands-off": "ask", prs: "ask" },
      },
      allow,
    ];

    expect(fallbackSet(rules(input, { groups: custom }), input.path, "reason")).toEqual([
      `Rule set for prs mode, not written (reason). Add it to permissions in ${input.path} yourself:`,
      '"deny": [\n  "Edit(~/.agents/skills.conf)"\n],\n"ask": [\n  "Bash(ask *)"\n],\n"allow": [\n  "Bash(skills *)"\n]',
    ]);
  });

  test("placeholder collision still prints expanded deny cells", () => {
    const input = fixture();
    const custom: RuleGroup[] = ["agents", "codex"].map((placeholder) => ({
      kind: "deny",
      id: placeholder,
      label: placeholder,
      entries: [`Edit({${placeholder}})`],
      cells: { "hands-off": "deny", prs: "deny" },
    }));

    const output = fallbackSet(
      rules(input, {
        groups: custom,
        current: { ...input.current, agents: "/same", codex: "/same" },
      }),
      input.path,
      "collision",
    );

    expect(output[1]).toBe('"deny": [\n  "Edit(//same)",\n  "Edit(//same)"\n]');
  });

  test("placeholder collision keeps the configured ask level", () => {
    const input = fixture();
    const custom: RuleGroup[] = ["agents", "codex"].map((placeholder) => ({
      kind: "deny",
      id: placeholder,
      label: placeholder,
      entries: [`Edit({${placeholder}})`],
      cells: { "hands-off": "deny", prs: "deny" },
    }));

    const output = fallbackSet(
      rules(input, {
        groups: custom,
        levels: { global: "ask", groups: { codex: "off" } },
        current: { ...input.current, agents: "/same", codex: "/same" },
      }),
      input.path,
      "collision",
    );

    expect(output[1]).toBe('"ask": [\n  "Edit(//same)"\n]');
  });

  test("off with nothing to print has no header", () => {
    const input = fixture();

    expect(
      fallbackSet(rules(input, { levels: { global: "off", groups: {} } }), input.path, "reason"),
    ).toEqual([]);
  });
});

describe("applying rules", () => {
  test("planning a synthetic level reads without writing settings or config", () => {
    const input = fixture("DELIVERY=prs\n");
    const result = planClaudeRules({ ...input, levels: { global: "ask", groups: {} } });

    expect(result.kind).toBe("plan");
    expect(existsSync(input.path)).toBe(false);
    expect(readFileSync(input.current.conf, "utf8")).toBe("DELIVERY=prs\n");
    if (result.kind !== "plan") throw new Error("expected a rules plan");

    expect(result.changes.every((change) => change.to === "ask")).toBe(true);
  });

  test("an equal confirmed list applies weakening at a terminal", () => {
    const input = fixture("DELIVERY=prs\nAGENT_RULES=ask\n");
    input.stdin.isTTY = true;
    input.stdout.isTTY = true;
    writeFileSync(input.path, '{"permissions":{"deny":["Bash(gh pr merge:*)"]}}');

    const preview = planClaudeRules(input);
    if (preview.kind !== "plan") throw new Error("expected a rules plan");

    const output = applyClaudeRules({ ...input, confirmed: structuredClone(preview.changes) });

    expect(output).toContain("rules  merge move 1 from deny to ask, add 1 to ask");
    expect(output.some((line) => line.startsWith("left   "))).toBe(false);
    const permissions = JSON.parse(readFileSync(input.path, "utf8")).permissions;

    expect(permissions.deny).toEqual([]);
    expect(permissions.ask).toContain("Bash(gh pr merge:*)");
  });

  test("a weakening that changed after the preview is left", () => {
    const input = fixture("DELIVERY=prs\nAGENT_RULES=ask\n");
    input.stdin.isTTY = true;
    input.stdout.isTTY = true;
    writeFileSync(input.path, '{"permissions":{"deny":["Bash(gh pr merge:*)"]}}');

    const preview = planClaudeRules(input);
    if (preview.kind !== "plan") throw new Error("expected a rules plan");

    writeFileSync(
      input.path,
      '{"permissions":{"deny":["Bash(gh pr merge:*)"],"ask":["Bash(gh pr merge:*)"]}}',
    );

    const output = applyClaudeRules({ ...input, confirmed: preview.changes });

    expect(output).toContain(
      `left   merge move 1 from deny to ask (weakening, the rule plan changed after the preview; edit ${input.path} by hand to apply it)`,
    );

    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.deny).toEqual([
      "Bash(gh pr merge:*)",
    ]);
  });

  test.each(["stdin", "stdout", "CI"])("a confirmation does not bypass %s", (failure) => {
    const input = fixture("DELIVERY=prs\nAGENT_RULES=ask\n");
    input.stdin.isTTY = failure !== "stdin";
    input.stdout.isTTY = failure !== "stdout";
    if (failure === "CI") input.env.CI = "";

    writeFileSync(input.path, '{"permissions":{"deny":["Bash(gh pr merge:*)"]}}');
    const preview = planClaudeRules(input);
    if (preview.kind !== "plan") throw new Error("expected a rules plan");

    const output = applyClaudeRules({ ...input, confirmed: preview.changes });

    expect(output.some((line) => line.startsWith("left   merge"))).toBe(true);
    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.deny).toEqual([
      "Bash(gh pr merge:*)",
    ]);
  });

  test("confirmed release removes owned denies at off and leaves personal entries", () => {
    const input = fixture("AGENT_RULES=off\n");
    input.stdin.isTTY = true;
    input.stdout.isTTY = true;
    writeFileSync(
      input.path,
      '{"permissions":{"deny":["Bash(gh pr merge:*)","Bash(personal *)"]}}',
    );

    const preview = planClaudeRules({ ...input, release: true });
    if (preview.kind !== "plan") throw new Error("expected a rules plan");

    expect(applyClaudeRules({ ...input, release: true, confirmed: preview.changes })).toContain(
      "rules  merge remove 1 from deny",
    );

    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.deny).toEqual([
      "Bash(personal *)",
    ]);
  });

  test("managed warnings do not stop a write and print on fallback", () => {
    const input = fixture();
    const managed = join(input.home, "managed.json");
    writeFileSync(managed, '{"allowManagedPermissionRulesOnly":true}');
    input.managedPaths = [managed];
    const warning = `warn   ${managed} (allowManagedPermissionRulesOnly is true, user permission rules do not apply)`;

    expect(applyClaudeRules(input)).toContain(warning);
    expect(existsSync(input.path)).toBe(true);

    writeFileSync(input.path, "{invalid");
    const fallback = applyClaudeRules(input);

    expect(fallback).toContain(warning);
    expect(fallback.some((line) => line.includes("not written"))).toBe(true);
    expect(fallback.some((line) => line.startsWith("rules  "))).toBe(false);
  });

  test.each([
    "{invalid",
    '{"permissions":null}',
    '{"permissions":{"deny":true}}',
    '{"permissions":{},"permissions":{}}',
  ])("refused settings %s remain untouched and print the set", (text) => {
    const input = fixture();
    writeFileSync(input.path, text);
    const before = statSync(input.path);

    const output = applyClaudeRules(input);

    expect(output.some((line) => line.includes("not written"))).toBe(true);
    expect(output.some((line) => line.includes('"deny": ['))).toBe(true);
    expect(output.some((line) => line.startsWith("rules  "))).toBe(false);
    expect(readFileSync(input.path, "utf8")).toBe(text);
    expect(statSync(input.path).ino).toBe(before.ino);
  });

  test("a refused write prints no applied rules lines", () => {
    const input = fixture();
    writeFileSync(input.path, "{}\n");
    chmodSync(input.path, 0o444);
    const output = applyClaudeRules(input);

    expect(output[0]).toContain(`${input.path}: is not writable`);
    expect(output.some((line) => line.startsWith("rules  "))).toBe(false);
    expect(readFileSync(input.path, "utf8")).toBe("{}\n");
  });

  test("an invalid config is unmanaged even with a parsed level", () => {
    const input = fixture("DELIVERY=invalid\nAGENT_RULES=off\n");
    const output = applyClaudeRules(input);

    expect(output[0]).toContain(`${input.current.conf} is invalid`);
    expect(output[1]).toContain('"deny": [');
    expect(existsSync(input.path)).toBe(false);
  });

  test("unmanaged fallback follows actual guard wiring", () => {
    const input = fixture("DELIVERY=prs\n");
    writeFileSync(input.path, JSON.stringify(guard()));
    const output = applyClaudeRules(input);

    expect(output[1]).not.toContain("Bash(gh pr comment:*)");
    expect(output.some((line) => line.startsWith("rules  "))).toBe(false);
  });

  test("a terminal run still leaves weakening unconfirmed", () => {
    const input = fixture("DELIVERY=prs\nAGENT_RULES=ask\n");
    input.stdin.isTTY = true;
    input.stdout.isTTY = true;
    writeFileSync(input.path, '{"permissions":{"deny":["Bash(gh pr merge:*)"]}}');
    const output = applyClaudeRules(input);

    expect(output).toContain(
      `left   merge move 1 from deny to ask (weakening, not confirmed; edit ${input.path} by hand to apply it)`,
    );

    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.deny).toEqual([
      "Bash(gh pr merge:*)",
    ]);
  });

  test("personal dead allows and off blockers are noted without edits", () => {
    const input = fixture("DELIVERY=prs\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=off\n");
    writeFileSync(
      input.path,
      JSON.stringify({
        permissions: { allow: ["Bash(gh pr merge --auto *)"], deny: ["Bash(git push:*)"] },
      }),
    );

    const output = applyClaudeRules(input);

    expect(output).toContain(
      "note   allow Bash(gh pr merge --auto *) never applies, Bash(gh pr merge:*) from merge matches first",
    );

    expect(output).toContain(
      "note   deny Bash(git push:*) blocks Bash(git push:*), which prs mode needs (group publishing is off)",
    );

    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.allow).toEqual([
      "Bash(gh pr merge --auto *)",
    ]);
  });

  test("off preserves bytes and inode without a header", () => {
    const input = fixture("AGENT_RULES=off\n");
    const text = '{"personal":true}\n';
    writeFileSync(input.path, text);
    const before = statSync(input.path);

    expect(applyClaudeRules(input)).toEqual([]);
    expect(readFileSync(input.path, "utf8")).toBe(text);
    expect(statSync(input.path).ino).toBe(before.ino);
  });

  test("off with a refused file still names the reason", () => {
    const input = fixture("AGENT_RULES=off\n");
    writeFileSync(input.path, "{invalid");

    expect(applyClaudeRules(input)).toEqual([
      expect.stringMatching(new RegExp(`^note   ${input.path}: invalid JSON`)),
    ]);
  });

  test("a managed run with nothing to add creates no settings file", () => {
    const input = fixture("AGENT_RULES=off\n");
    expect(applyClaudeRules(input)).toEqual([]);
    expect(existsSync(input.path)).toBe(false);
  });

  test("default placeholder spellings are adopted using absolute defaults", () => {
    const input = fixture();
    const customRoot = join(input.home, "checkout/skills");
    mkdirSync(join(customRoot, "playbook/references"), { recursive: true });
    writeFileSync(
      join(customRoot, "playbook/references/delivery.md"),
      "## Rule groups\n| id | label | entries | hands-off | prs |\n| --- | --- | --- | --- | --- |\n| `path` | Path | `Edit({agents})` | deny | deny |\n",
    );

    input.root = customRoot;
    input.current.agents = "/outside/skills";
    writeFileSync(input.path, '{"permissions":{"deny":["Edit(~/.agents/skills)"]}}');

    expect(applyClaudeRules(input)).toContain(
      `left   path rewrite 1 in deny (weakening, stdin is not a terminal and stdout is not a terminal; edit ${input.path} by hand to apply it)`,
    );

    expect(JSON.parse(readFileSync(input.path, "utf8")).permissions.deny).toEqual([
      "Edit(~/.agents/skills)",
    ]);
  });

  test("metadata copy errors still throw", () => {
    const input = fixture();
    const bin = join(input.home, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    writeFileSync(input.path, "{}\n");

    const previous = process.env.PATH;
    process.env.PATH = bin;

    try {
      expect(() => applyClaudeRules(input)).toThrow(MetadataCopyError);
      expect(readFileSync(input.path, "utf8")).toBe("{}\n");
    } finally {
      process.env.PATH = previous;
    }
  });

  test("a concurrent writer keeps its bytes and prints no applied lines", () => {
    const input = fixture();
    const bin = join(input.home, "bin");
    const copy = Bun.which("cp")!;
    mkdirSync(bin);
    writeFileSync(
      join(bin, "cp"),
      `#!/bin/sh\nprintf '%s\\n' '{"concurrent":true}' > ${shellQuote(input.path)}\nexec ${shellQuote(copy)} "$@"\n`,
      { mode: 0o755 },
    );

    writeFileSync(input.path, "{}\n");
    const previous = process.env.PATH;
    process.env.PATH = bin;

    try {
      const output = applyClaudeRules(input);

      expect(output[0]).toContain("changed on disk since it was read");
      expect(output.some((line) => line.startsWith("rules  "))).toBe(false);
      expect(readFileSync(input.path, "utf8")).toBe('{"concurrent":true}\n');
    } finally {
      process.env.PATH = previous;
    }
  });

  test("JSON number shapes do not count as hooks", () => {
    const data = object(parseJson('{"hooks":123}'))!;
    expect(commitGuardWired(data, "/home/user", cli, [])).toBe(false);
  });
});
