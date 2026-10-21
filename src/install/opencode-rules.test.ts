import { afterEach, expect, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { readRuleGroups } from "../deny-set.ts";
import {
  applyOpenCodeRules,
  openCodeKeys,
  openCodeMatch,
  planOpenCodeRules,
  type OpenCodeRulesInput,
} from "./opencode-rules.ts";
import { parseJsonc } from "./jsonc.ts";
import { writeOwned } from "./opencode.ts";
import * as settingsFile from "./settings-file.ts";

const directories: string[] = [];
const root = resolve(import.meta.dir, "../../skills");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture(content = "AGENT_RULES=deny\n") {
  const home = mkdtempSync(join(tmpdir(), "skills-opencode-rules-"));
  directories.push(home);

  const opencode = join(home, "opencode");
  const conf = join(home, "skills.conf");
  mkdirSync(opencode);
  writeFileSync(conf, content);

  const input: OpenCodeRulesInput = {
    root,
    home,
    opencode,
    mode: "prs",
    current: {
      claude: join(home, ".claude"),
      agents: join(home, ".agents/skills"),
      conf,
      codex: join(home, ".codex"),
      checkout: "/checkout",
    },
    config: readDeliveryConfig({ SKILLS_CONF: conf }),
    env: {},
    stdin: {},
    stdout: {},
  };

  return {
    input,
    path: join(opencode, "opencode.jsonc"),
    earlier: join(opencode, "opencode.json"),
  };
}

function plan(input: OpenCodeRulesInput, extra = {}) {
  const result = planOpenCodeRules({ ...input, ...extra });
  if (result.kind !== "plan") throw new Error(`expected plan, got ${result.kind}`);
  return result;
}

function seed(path: string, value: object) {
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function permission(resource: string, effect = "deny", extra = {}) {
  return { action: "shell", resource, effect, ...extra };
}

function policy(resource: string, effect = "deny", extra = {}) {
  return { action: "tool.use", resource: `shell:${resource}`, effect, ...extra };
}

function synthetic(input: OpenCodeRulesInput, rows: string[]) {
  const table = join(input.home, "table/playbook/references");
  mkdirSync(table, { recursive: true });
  writeFileSync(
    join(table, "delivery.md"),
    [
      "## Rule groups",
      "| id | label | entries | hands-off | prs |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n"),
  );

  return { ...input, root: join(input.home, "table") };
}

test("JSONC personal rule, comment and trailing comma survive owned entries and a byte identical rerun", () => {
  const { input, path } = fixture();
  const personal = '{ "action": "shell", "resource": "rm -rf *", "effect": "ask" }';
  const prefix =
    '{\r\n  // keep this comment\r\n  "permissions": [\r\n    ' +
    personal +
    ',\r\n  ],\r\n  "untouched": [1,],\r\n  "number": 1e+02,\r\n';

  writeFileSync(path, prefix + "}\r\n");
  expect(applyOpenCodeRules(input)).toContain(`opencode ${path}`);
  const first = readFileSync(path, "utf8");
  expect(first).toContain(
    '  // keep this comment\r\n  "permissions": [\r\n    ' + personal + ",\r\n",
  );

  expect(first).toContain('  ],\r\n  "untouched": [1,],\r\n  "number": 1e+02,\r\n');
  expect(first).toEndWith("  ],\r\n}\r\n");
  expect(plan(input).changes).toEqual([]);
  expect(applyOpenCodeRules(input).filter((line) => line.startsWith("opencode "))).toEqual([]);
  expect(readFileSync(path, "utf8")).toBe(first);
});

test("denies use policies, asks use permissions and allow groups write nothing", () => {
  const { input, path } = fixture("AGENT_RULES=deny\nAGENT_RULES_MERGE=ask\n");
  applyOpenCodeRules(input);
  const document = JSON.parse(readFileSync(path, "utf8"));
  expect(document.policies.length).toBeGreaterThan(0);
  expect(document.permissions).toContainEqual(permission("gh pr merge *", "ask"));
  expect(
    document.policies.every(
      (item: { action: string; effect: string }) =>
        item.action === "tool.use" && item.effect === "deny",
    ),
  ).toBe(true);

  expect(document.permissions.every((item: { effect: string }) => item.effect === "ask")).toBe(
    true,
  );

  expect(JSON.stringify(document)).not.toContain("plans frontier");
});

test("legacy permission denies migrate to policy and duplicate owned entries disappear", () => {
  const { input, path } = fixture();
  seed(path, {
    permissions: [
      permission("gh pr merge *"),
      permission("gh pr merge *"),
      permission("gh stack merge *"),
    ],
  });

  expect(plan(input).changes.find((change) => change.group === "merge")?.class).toBe("neutral");
  applyOpenCodeRules(input);
  const document = JSON.parse(readFileSync(path, "utf8"));
  expect(document.permissions.every((item: { action: string }) => item.action === "edit")).toBe(
    true,
  );

  expect(
    document.policies.filter(
      (item: unknown) => JSON.stringify(item) === JSON.stringify(policy("gh pr merge *")),
    ),
  ).toHaveLength(1);
});

test("allow effects, extra keys and skills-cli renderings stay personal", () => {
  const { input, path } = fixture();
  const cli = readRuleGroups(root).find((group) => group.id === "skills-cli")!;
  const cliResource = openCodeKeys(cli.entries[0]!, input.current, input.home)[0]!.resource;
  const personal = [
    permission("gh pr merge *", "allow"),
    permission("gh pr merge *", "deny", { message: "mine" }),
    permission(cliResource, "deny"),
    permission(cliResource, "ask"),
  ];

  const policies = [policy("gh pr merge *", "allow"), policy(cliResource)];
  seed(path, { permissions: personal, policies });
  expect(plan(input).entries.every((entry) => !entry.group)).toBe(true);

  applyOpenCodeRules(input);
  const document = JSON.parse(readFileSync(path, "utf8"));

  expect(document.permissions.slice(0, personal.length)).toEqual(personal);
  expect(document.policies.slice(0, policies.length)).toEqual(policies);
  expect(plan(input).changes).toEqual([]);
});

test("owned entries in the non target global file move, personal bytes stay", () => {
  const { input, path, earlier } = fixture();
  const personal = '{"action":"shell","resource":"mine","effect":"ask"}';
  writeFileSync(
    earlier,
    `{"permissions":[${personal},${JSON.stringify(permission("gh pr merge *"))}]}\n`,
  );

  writeFileSync(path, "{ // later file\n}\n");
  const output = applyOpenCodeRules(input);

  expect(output).toContain(`opencode ${earlier}`);
  expect(output).toContain(`opencode ${path}`);
  expect(readFileSync(earlier, "utf8")).toContain(personal);
  expect(JSON.parse(readFileSync(earlier, "utf8")).permissions).toEqual([JSON.parse(personal)]);
  expect(parseJsonc(readFileSync(earlier, "utf8")).data.policies).toContainEqual(
    policy("gh pr merge *"),
  );

  expect(readFileSync(path, "utf8")).toStartWith("{ // later file\n");
  expect(plan(input).changes).toEqual([]);
});

test("only json exists, new entries land there without creating jsonc", () => {
  const { input, path, earlier } = fixture();
  seed(earlier, {});
  applyOpenCodeRules(input);
  expect(existsSync(path)).toBe(false);
  expect(JSON.parse(readFileSync(earlier, "utf8")).policies).toContainEqual(
    policy("gh pr merge *"),
  );
});

test("global denies outrank personal json allows while asks use jsonc", () => {
  const { input, path, earlier } = fixture("AGENT_RULES=deny\nAGENT_RULES_FETCH=ask\n");
  const value = synthetic(input, [
    "| `merge` | Merge | `Bash(gh pr merge *)` | deny | deny |",
    "| `fetch` | Fetch | `Bash(git fetch *)` | deny | deny |",
  ]);

  const allow = policy("gh pr merge *", "allow");
  seed(earlier, { policies: [allow], permissions: [permission("git fetch *", "allow")] });
  seed(path, {});

  const output = applyOpenCodeRules(value);

  expect(JSON.parse(readFileSync(earlier, "utf8")).policies).toEqual([
    allow,
    policy("gh pr merge *"),
  ]);

  expect(JSON.parse(readFileSync(path, "utf8")).permissions).toEqual([
    permission("git fetch *", "ask"),
  ]);

  expect(output.join("\n")).toContain("allow shell gh pr merge * never applies under merge deny");
  expect(plan(value).changes).toEqual([]);
});

test("a left weakening keeps its deny in the stronger policy file", () => {
  const { input, path, earlier } = fixture();
  const value = synthetic(input, [
    "| `broad` | Broad | `Bash(git fetch *)` | deny | absent |",
    "| `narrow` | Narrow | `Bash(git fetch origin *)` | deny | deny |",
  ]);

  const allow = policy("git fetch *", "allow");
  seed(earlier, { policies: [allow, policy("git fetch *")] });
  seed(path, {});

  const output = applyOpenCodeRules(value);

  expect(output.join("\n")).toContain("left   opencode broad remove deny");
  expect(JSON.parse(readFileSync(earlier, "utf8")).policies).toEqual([
    allow,
    policy("git fetch *"),
    policy("git fetch origin *"),
  ]);

  expect(output.join("\n")).not.toContain("allow shell git fetch * blocks");
});

test("a refused second file leaves both files untouched and prints the paste set", () => {
  const { input, path, earlier } = fixture("AGENT_RULES=ask\n");
  const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | deny |"]);
  seed(earlier, { policies: [policy("gh pr merge *")] });
  seed(path, {});

  const before = [earlier, path].map((file) => readFileSync(file, "utf8"));
  const terminal = { ...value, stdin: { isTTY: true }, stdout: { isTTY: true } };
  const confirmed = plan(terminal).changes;
  chmodSync(path, 0o444);

  try {
    const output = applyOpenCodeRules({ ...terminal, confirmed }).join("\n");

    expect(output).toContain(`skip   ${path} (is not writable)`);
    expect(output).toContain("OpenCode rule set, not written.");
    expect(output).toContain('"effect": "ask"');
    expect([earlier, path].map((file) => readFileSync(file, "utf8"))).toEqual(before);
  } finally {
    chmodSync(path, 0o644);
  }
});

test("a mid-write refusal reports the gaining file and leaves the losing file intact", () => {
  const { input, path, earlier } = fixture("AGENT_RULES=ask\n");
  const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | deny |"]);
  seed(earlier, { policies: [policy("gh pr merge *")] });
  seed(path, {});

  const before = readFileSync(earlier, "utf8");
  const terminal = { ...value, stdin: { isTTY: true }, stdout: { isTTY: true } };
  const confirmed = plan(terminal).changes;

  const writeTarget = settingsFile.writeTarget;
  const written: string[] = [];
  const writer = spyOn(settingsFile, "writeTarget").mockImplementation((target, content) => {
    written.push(target.path);
    const result = writeTarget(target, content);
    if (target.path === path) chmodSync(earlier, 0o444);
    return result;
  });

  try {
    const output = applyOpenCodeRules({ ...terminal, confirmed }).join("\n");

    expect(written).toEqual([path, earlier]);
    expect(output).toContain(`opencode ${path}`);
    expect(output).toContain(`skip   ${earlier} (is not writable)`);
    expect(output).toContain('"resource": "gh pr merge *"');
    expect(readFileSync(earlier, "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(path, "utf8")).permissions).toEqual([
      permission("gh pr merge *", "ask"),
    ]);
  } finally {
    writer.mockRestore();
    chmodSync(earlier, 0o644);
  }
});

test.each([false, true])(
  "an earlier personal allow policy blocking a left deny is named with personal ask %j",
  (ask) => {
    const { input, path, earlier } = fixture();
    const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | absent |"]);
    seed(earlier, { policies: [policy("gh pr merge 7", "allow")] });
    seed(path, {
      policies: [policy("gh pr merge *")],
      ...(ask ? { permissions: [permission("gh pr merge 7", "ask")] } : {}),
    });

    const before = [earlier, path].map((file) => readFileSync(file, "utf8"));

    const output = applyOpenCodeRules(value).join("\n");

    expect(output).toContain("personal allow policy shell gh pr merge 7 blocks merge deny");
    expect(output).not.toContain("never applies");
    expect([earlier, path].map((file) => readFileSync(file, "utf8"))).toEqual(before);
  },
);

test.each([
  '"permission": { "bash": "deny" }',
  '"permission": { "bash": { "git fetch *": "deny" } }',
  '"permission": "deny"',
  '"tools": { "bash": false }',
])("legacy %s is evaluated without editing its bytes", (legacy) => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  const value = synthetic(input, ["| `fetch` | Fetch | `Bash(git fetch *)` | deny | deny |"]);
  const before = `{\n  ${legacy}, // personal legacy setting\n}\n`;
  writeFileSync(path, before);

  expect(plan(value).changes[0]?.class).toBe("weakening");
  expect(applyOpenCodeRules(value).join("\n")).toContain("left   opencode fetch add ask");
  expect(readFileSync(path, "utf8")).toBe(before);

  const terminal = { ...value, stdin: { isTTY: true }, stdout: { isTTY: true } };
  applyOpenCodeRules({ ...terminal, confirmed: plan(terminal).changes });
  expect(readFileSync(path, "utf8")).toStartWith(before.slice(0, -2));
  expect(applyOpenCodeRules(terminal).join("\n")).not.toContain("opencode fetch");
});

test("legacy tools then permission then native permissions determine the effective decision", () => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  const value = synthetic(input, ["| `fetch` | Fetch | `Bash(git fetch *)` | deny | deny |"]);
  seed(path, { tools: { bash: false }, permission: { bash: "allow" } });
  expect(plan(value).changes[0]?.class).toBe("strengthening");

  seed(path, { permission: { bash: "deny" }, permissions: [permission("*", "allow")] });
  expect(plan(value).changes[0]?.class).toBe("strengthening");
});

test("changing merge to ask reports only merge and reruns byte identically", () => {
  const { input, path } = fixture();
  applyOpenCodeRules(input);
  writeFileSync(input.current.conf, "AGENT_RULES=deny\nAGENT_RULES_MERGE=ask\n");
  const terminal = {
    ...input,
    config: readDeliveryConfig({ SKILLS_CONF: input.current.conf }),
    stdin: { isTTY: true },
    stdout: { isTTY: true },
  };

  const confirmed = plan(terminal).changes;

  expect(confirmed.map((change) => change.group)).toEqual(["merge"]);
  expect(
    applyOpenCodeRules({ ...terminal, confirmed }).filter(
      (line) => line.startsWith("opencode ") && line !== `opencode ${path}`,
    ),
  ).toEqual(["opencode merge deny to ask"]);

  const before = readFileSync(path, "utf8");

  expect(plan(terminal).changes).toEqual([]);
  applyOpenCodeRules(terminal);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("default spellings skip another group's current key", () => {
  const { input, path } = fixture();
  const fixed = join(input.home, ".agents/skills.conf");
  const value = synthetic(input, [
    "| `config` | Config | `Edit({conf})` | deny | deny |",
    `| \`fixed\` | Fixed | \`Edit(${fixed})\` | deny | deny |`,
  ]);

  seed(path, { policies: [{ action: "tool.use", resource: `edit:${fixed}`, effect: "deny" }] });

  expect(plan(value).entries[0]?.group).toBe("fixed");
  expect(applyOpenCodeRules(value).join("\n")).not.toContain("skip ");
  expect(plan(value).changes).toEqual([]);
});

test("unset and off levels create no files or empty keys", () => {
  for (const content of ["", "AGENT_RULES=off\n"]) {
    const { input, path, earlier } = fixture(content);
    applyOpenCodeRules(input);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(earlier)).toBe(false);
  }
});

test.each(["deny", "ask"])(
  "a left %s group keeps its effect against another group's append",
  (effect) => {
    const { input, path } = fixture();
    const value = synthetic(input, [
      "| `broad` | Broad | `Bash(git fetch *)` | deny | absent |",
      `| \`narrow\` | Narrow | \`Bash(git fetch origin *)\` | deny | ${effect} |`,
    ]);

    const owned = JSON.stringify(permission("git fetch *", effect));
    const before = `{\n  "permissions": [\n    ${owned},\n  ],\n}\n`;
    writeFileSync(path, before);
    expect(plan(value).changes.find((change) => change.group === "broad")?.class).toBe("weakening");

    const output = applyOpenCodeRules(value);
    expect(output.some((line) => line.startsWith("left   opencode broad"))).toBe(true);

    const document = parseJsonc(readFileSync(path, "utf8")).data;
    expect(document.permissions).toEqual([
      permission("git fetch *", effect),
      ...(effect === "ask" ? [permission("git fetch origin *", "ask")] : []),
    ]);

    const appended =
      effect === "deny"
        ? '  "policies": [\n    { "action": "tool.use", "resource": "shell:git fetch origin *", "effect": "deny" }\n  ],\n'
        : '    { "action": "shell", "resource": "git fetch origin *", "effect": "ask" },\n';

    expect(readFileSync(path, "utf8")).toBe(
      effect === "deny"
        ? before.replace("}\n", appended + "}\n")
        : before.replace("  ],\n", appended + "  ],\n"),
    );

    if (effect === "deny") expect(document.policies).toContainEqual(policy("git fetch origin *"));
    else expect(document.permissions).toContainEqual(permission("git fetch origin *", "ask"));
  },
);

test("left managed ask stays before personal items when another group appends", () => {
  const { input, path } = fixture();
  const value = synthetic(input, [
    "| `first` | First | `Bash(git fetch *)` | deny | absent |",
    "| `second` | Second | `Bash(gh pr merge *)` | deny | deny |",
  ]);

  const permissions = [permission("git fetch *", "ask"), permission("gh pr merge *", "allow")];
  const before = JSON.stringify({ permissions }, null, 2) + "\n";
  writeFileSync(path, before);

  applyOpenCodeRules(value);
  const after = readFileSync(path, "utf8");
  expect(JSON.parse(after).permissions).toEqual(permissions);
  expect(after).toBe(
    before.slice(0, -3) +
      ',\n  "policies": [\n    { "action": "tool.use", "resource": "shell:gh pr merge *", "effect": "deny" }\n  ]\n}\n',
  );
});

test("classification evaluates old and candidate states instead of comparing key sets", () => {
  const { input, path } = fixture();
  const value = synthetic(input, ["| `fetch` | Fetch | `Bash(git fetch *)` | deny | absent |"]);
  seed(path, {
    permissions: [permission("git fetch *"), permission("git *", "deny", { message: "personal" })],
  });

  expect(plan(value).changes[0]?.class).toBe("neutral");
  seed(path, {
    permissions: [permission("git fetch *")],
    policies: [policy("git *", "deny", { message: "personal" })],
  });

  expect(plan(value).changes[0]?.class).toBe("neutral");
  seed(path, { permissions: [permission("git fetch *"), permission("*", "allow")] });
  expect(plan(value).changes[0]?.class).toBe("neutral");
});

test("personal resource probes catch a weakening hidden by group wildcard literals", () => {
  const { input, path } = fixture();
  const value = synthetic(input, ["| `fetch` | Fetch | `Bash(git fetch *)` | deny | ask |"]);
  seed(path, {
    permissions: [permission("git fetch *", "ask"), permission("git fetch origin feat/x", "deny")],
  });

  const before = readFileSync(path, "utf8");

  expect(plan(value).changes[0]?.class).toBe("weakening");
  expect(applyOpenCodeRules(value).some((line) => line.startsWith("left   opencode fetch"))).toBe(
    true,
  );

  expect(readFileSync(path, "utf8")).toBe(before);
});

test("bare command probes catch weakenings masked by literal wildcard permissions", () => {
  const { input, path } = fixture();
  const value = synthetic(input, ["| `fetch` | Fetch | `Bash(git fetch *)` | deny | absent |"]);
  seed(path, { permissions: [permission("git fetch *"), permission("git fetch ?*", "deny")] });
  expect(plan(value).changes[0]?.class).toBe("weakening");
});

test("policy file order is reversed while permission file order is not", () => {
  const { input, path, earlier } = fixture();
  const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | absent |"]);
  seed(earlier, { policies: [policy("gh pr merge *")] });
  seed(path, { policies: [policy("gh pr merge *", "allow")] });
  expect(plan(value).changes[0]?.class).toBe("weakening");

  seed(earlier, { permissions: [permission("gh pr merge *")] });
  seed(path, { permissions: [permission("gh pr merge *", "allow")] });
  expect(plan(value).changes[0]?.class).toBe("neutral");
});

test("confirmed terminal weakening moves deny policies to ask permissions", () => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  seed(path, { policies: [policy("gh pr merge *")] });
  const terminal = { ...input, stdin: { isTTY: true }, stdout: { isTTY: true } };
  const confirmed = plan(terminal).changes;
  expect(confirmed.find((change) => change.group === "merge")?.class).toBe("weakening");

  applyOpenCodeRules({ ...terminal, confirmed });
  const document = JSON.parse(readFileSync(path, "utf8"));

  expect(document.policies).toEqual([]);
  expect(document.permissions).toContainEqual(permission("gh pr merge *", "ask"));
});

test.each(["*", "shell*"])(
  "whole-resource policy %s participates in evaluation and blocker notes",
  (resource) => {
    const { input, path } = fixture();
    const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | absent |"]);
    const personal = { action: "tool.use", resource, effect: "deny" };
    seed(path, { policies: [personal], permissions: [permission("gh pr merge *")] });

    expect(plan(value).changes[0]?.class).toBe("neutral");
    const output = applyOpenCodeRules(value);

    expect(JSON.parse(readFileSync(path, "utf8")).policies).toEqual([personal]);
    expect(output.join("\n")).toContain(`personal deny tool.use ${resource} blocks`);
  },
);

test("non terminal or changed preview never authorizes weakening", () => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  seed(path, { policies: [policy("gh pr merge *")] });
  const confirmed = plan(input).changes;
  applyOpenCodeRules({ ...input, confirmed });
  expect(parseJsonc(readFileSync(path, "utf8")).data.policies).toContainEqual(
    policy("gh pr merge *"),
  );

  const terminal = { ...input, stdin: { isTTY: true }, stdout: { isTTY: true } };
  seed(path, { policies: [policy("gh pr merge *"), policy("gh pr merge *")] });
  expect(applyOpenCodeRules({ ...terminal, confirmed }).join("\n")).toContain(
    "rule plan changed after the preview",
  );
});

test("a terminal decline says not confirmed rather than changed after preview", () => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  const value = synthetic(input, ["| `merge` | Merge | `Bash(gh pr merge *)` | deny | deny |"]);
  seed(path, { policies: [policy("gh pr merge *")] });
  const before = readFileSync(path, "utf8");

  const output = applyOpenCodeRules({
    ...value,
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    confirmed: [],
  }).join("\n");

  expect(output).toContain("weakening, not confirmed;");
  expect(output).not.toContain("changed after the preview");
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("removing a retired item reports no rewrite for groups whose indices shift", () => {
  const { input, path } = fixture();
  const value = synthetic(input, [
    "| `retired` | Retired | `Bash(old *)` | absent | absent |",
    "| `merge` | Merge | `Bash(gh pr merge *)` | deny | deny |",
    "| `review` | Review | `Bash(gh pr review *)` | deny | deny |",
  ]);

  seed(path, { policies: [policy("old *"), policy("gh pr merge *"), policy("gh pr review *")] });

  expect(plan(value).changes.map((change) => change.group)).toEqual(["retired"]);
  expect(applyOpenCodeRules(value).filter((line) => line.startsWith("opencode "))).toEqual([
    "opencode retired remove deny",
    `opencode ${path}`,
  ]);

  expect(plan(value).changes).toEqual([]);
});

test("OpenCode does not repeat shared skills.conf parse notes", () => {
  const { input } = fixture("AGENT_RULES=deny\nAGENT_RULES_UNKNOWN=deny\n");
  expect(applyOpenCodeRules(input).join("\n")).not.toContain("AGENT_RULES_UNKNOWN");
});

test("300 personal rules still plan the managed asks", () => {
  const { input, path } = fixture("AGENT_RULES=ask\n");
  seed(path, {
    permissions: Array.from({ length: 300 }, (_, index) =>
      permission(`tool${index} *`, index % 2 ? "allow" : "deny"),
    ),
  });

  expect(plan(input).changes.length).toBeGreaterThan(0);
});

test("retired removal is neutral and off keeps owned entries byte for byte", () => {
  const { input, path } = fixture("AGENT_RULES=off\n");
  const value = synthetic(input, [
    "| `retired` | Retired | `Bash(old *)` | absent | absent |",
    "| `live` | Live | `Bash(git fetch *)` | deny | deny |",
  ]);

  const text =
    '{"permissions": [ { "resource": "git fetch *", "effect": "deny", "action": "shell" } ]}\n';

  writeFileSync(path, text);
  applyOpenCodeRules(value);
  expect(readFileSync(path, "utf8")).toBe(text);

  seed(path, { permissions: [permission("old *")] });
  expect(plan(value, { levels: { global: "deny", groups: {} } }).changes[0]?.class).toBe("neutral");

  applyOpenCodeRules({ ...value, levels: { global: "deny", groups: {} } });
  expect(JSON.parse(readFileSync(path, "utf8")).permissions).toEqual([]);
});

test("edit renderings include absolute and relative paths, with tilde and default ownership", () => {
  const { input, path } = fixture();
  expect(openCodeKeys("Edit({conf})", input.current, input.home)).toEqual([
    { action: "edit", resource: input.current.conf },
    { action: "edit", resource: "skills.conf" },
    { action: "edit", resource: "*/skills.conf" },
  ]);

  expect(openCodeKeys("Edit({checkout}/a)", input.current, input.home)).toEqual([
    { action: "edit", resource: "/checkout/a" },
  ]);

  const value = synthetic(input, ["| `config` | Config | `Edit({conf})` | deny | deny |"]);
  seed(path, {
    permissions: [
      { action: "edit", resource: "~/skills.conf", effect: "ask" },
      { action: "edit", resource: "$HOME/skills.conf", effect: "deny" },
      { action: "edit", resource: "~/.agents/skills.conf", effect: "deny" },
    ],
  });

  expect(plan(value).entries.every((entry) => entry.group === "config")).toBe(true);
  applyOpenCodeRules(value);
  expect(JSON.parse(readFileSync(path, "utf8")).policies).toContainEqual({
    action: "tool.use",
    resource: `edit:${input.current.conf}`,
    effect: "deny",
  });
});

test("shell keys include canonical, absolute and tilde spellings", () => {
  const { input } = fixture();
  expect(openCodeKeys("Bash({agents}/playbook/bin/skills:*)", input.current, input.home)).toEqual([
    { action: "shell", resource: `${input.current.agents}/playbook/bin/skills *` },
    { action: "shell", resource: "~/.agents/skills/playbook/bin/skills *" },
  ]);

  expect(openCodeKeys("Write({conf})", input.current, input.home)).toEqual([]);
});

test.each([
  ["git fetch", "git fetch *", true],
  ["git fetch\norigin", "git *", true],
  ["a/b/c", "a*c", true],
  ["abc", "a?c", true],
  ["abbc", "a?c", false],
  ["a\\b", "a/b", true],
  ["Git fetch", "git *", process.platform === "win32"],
  ["gh pr mergeevil", "gh pr merge *", false],
  ["file.ts", "*.ts", true],
  ["a[b]", "a[b]", true],
  ["a.b", "a.b", true],
  ["axb", "a.b", false],
])("OpenCode wildcard %s against %s is %s", (resource, pattern, expected) => {
  expect(openCodeMatch(resource, pattern)).toBe(expected);
});

test.each(["missing", "owned", "personal", "noCli", "noBun", "disabled", "preview"])(
  "commit guard %s changes the deny-until-guard cell",
  (state) => {
    const { input, path } = fixture();
    if (["owned", "noCli", "noBun", "disabled"].includes(state))
      writeOwned(input.opencode, "plugins/skills.ts", "owned");

    if (state === "personal") {
      mkdirSync(join(input.opencode, "plugins"));
      writeFileSync(join(input.opencode, "plugins/skills.ts"), "mine");
    }

    if (state === "disabled") seed(path, { plugins: ["-skills-guard"] });
    const result = plan(input, {
      noCli: state === "noCli",
      noBun: state === "noBun",
      hooksPending: state === "preview",
    });

    expect(result.slots.find((slot) => slot.group.id === "pr-comment")?.rules.length === 0).toBe(
      ["owned", "preview"].includes(state),
    );
  },
);

test.each(["plugin", "plugins"])(
  "commit guard removal reads %s using OpenCode selectors",
  (key) => {
    const { input, path } = fixture();
    writeOwned(input.opencode, "plugins/skills.ts", "owned");

    for (const [selector, removed] of [
      ["*", true],
      ["skills-guard", true],
      ["skills.*", false],
      ["skills-guard.*", false],
      ["skills-*", false],
      ["skills-guar?", false],
    ] as const) {
      seed(path, { [key]: [`-${selector}`] });
      const slot = plan(input).slots.find((slot) => slot.group.id === "pr-comment")!;
      expect({ selector, denied: slot.rules.length > 0 }).toEqual({ selector, denied: removed });
    }
  },
);

test("notes name personal guardrail conflicts, off blockers and ask approval gaps", () => {
  const { input, path } = fixture("AGENT_RULES=ask\nAGENT_RULES_PUBLISHING=off\n");
  seed(path, {
    permissions: [
      permission("gh pr merge 7", "allow"),
      permission("gh pr merge 9"),
      permission("gh pr create *"),
    ],
    policies: [policy("gh pr merge 8", "allow")],
  });

  const terminal = { ...input, stdin: { isTTY: true }, stdout: { isTTY: true } };
  const output = applyOpenCodeRules({ ...terminal, confirmed: plan(terminal).changes }).join("\n");
  expect(output).toContain("allow shell gh pr merge 7 never applies");
  expect(output).toContain("allow shell gh pr merge 8 never applies");
  expect(output).toContain(
    "personal deny shell gh pr merge 9 is overridden by merge ask; set the group to deny or off",
  );

  expect(output).toContain(
    "publishing is off, and its deny shell gh pr create * blocks what prs mode needs",
  );

  expect(output).toContain('saved "always" approvals and --auto approve asks; only deny holds');
});

test.each([
  "\uFEFF{}",
  "{",
  "[]",
  '{"x":1,"x":2}',
  '{"x":{"y":1,"y":2}}',
  '{"permissions":{}}',
  '{"policies":null}',
])("invalid config %s is refused with both paste destinations", (text) => {
  const { input, path } = fixture();
  writeFileSync(path, text);
  const output = applyOpenCodeRules(input).join("\n");

  expect(output).toContain(`skip   ${path}`);
  expect(output).toContain("denies at the end of policies and asks at the end of permissions");
  expect(output).toContain('"action": "tool.use"');
  expect(readFileSync(path, "utf8")).toBe(text);
});

test.each(["utf8", "directory", "hardlink", "readonly", "dangling"])(
  "unsafe target %s refuses without creating the other file",
  (state) => {
    const { input, path, earlier } = fixture();
    if (state === "utf8") writeFileSync(path, Buffer.from([0xff]));
    if (state === "directory") mkdirSync(path);
    if (state === "dangling") symlinkSync(join(input.home, "gone"), path);
    if (state === "hardlink") {
      writeFileSync(path, "{}");
      linkSync(path, join(input.home, "linked"));
    }

    if (state === "readonly") {
      writeFileSync(path, "{}");
      chmodSync(path, 0o444);
    }

    try {
      expect(applyOpenCodeRules(input).join("\n")).toContain(`skip   ${path}`);
      expect(existsSync(earlier)).toBe(false);
    } finally {
      if (state === "readonly") chmodSync(path, 0o644);
    }
  },
);

test("symlinked target is updated without replacing the link", () => {
  const { input, path } = fixture();
  const target = join(input.home, "target.jsonc");
  writeFileSync(target, "{}\n");
  symlinkSync(target, path);

  applyOpenCodeRules(input);

  expect(JSON.parse(readFileSync(target, "utf8")).policies).toContainEqual(policy("gh pr merge *"));
});

test("unsupported rules are named without writing empty arrays", () => {
  const { input, path } = fixture();
  const value = synthetic(input, ["| `unsupported` | Unsupported | `Read(file)` | deny | deny |"]);
  expect(applyOpenCodeRules(value)).toContain(
    "skip   opencode unsupported Read(file) (no OpenCode rule can express this)",
  );

  expect(existsSync(path)).toBe(false);
});
