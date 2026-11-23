import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import type { RuleGroup } from "../deny-set.ts";
import {
  applyCodexRules,
  planCodexRules,
  prefixPatterns,
  rulesHeader,
  type CodexRulesInput,
} from "./codex-rules.ts";

const directories: string[] = [];
const repo = resolve(import.meta.dir, "../../../..");
const root = join(repo, "skills");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const codexBinary = Bun.which("codex");
function execpolicy(rules: string, ...command: string[]): string {
  const result = Bun.spawnSync(
    [codexBinary!, "execpolicy", "check", "--rules", rules, "--", ...command],
    { stdout: "pipe", stderr: "pipe" },
  );

  return JSON.parse(result.stdout.toString()).decision ?? "none";
}

function fixture(content = "DELIVERY=prs\nAGENT_RULES=deny\n") {
  const home = mkdtempSync(join(tmpdir(), "skills-codex-rules-"));
  directories.push(home);

  const codex = join(home, ".codex");
  const conf = join(home, "skills.conf");
  mkdirSync(codex);
  writeFileSync(conf, content);

  return { home, codex, conf, root, rules: join(codex, "rules/skills.rules") };
}

type Fixture = ReturnType<typeof fixture>;

function input(value: Fixture): CodexRulesInput {
  const agents = join(value.home, ".agents/skills");
  const config = readDeliveryConfig({ SKILLS_CONF: value.conf });
  return {
    root: value.root,
    home: value.home,
    codex: value.codex,
    agents,
    mode: config.mode,
    current: {
      claude: join(value.home, ".claude"),
      agents,
      conf: value.conf,
      codex: value.codex,
      checkout: repo,
    },
    config,
    env: {},
    stdin: {},
    stdout: {},
    // install.ts writes the Codex hooks before the rules, so the commit guard counts as wired.
    hooksPending: true,
  };
}

function apply(value: Fixture): string {
  return applyCodexRules(input(value))
    .map((line) => `${line}\n`)
    .join("");
}

function synthetic(value: Fixture, rows: string[]): Fixture {
  const table = join(value.home, "table/playbook/references");
  mkdirSync(table, { recursive: true });
  writeFileSync(
    join(table, "rule-groups.md"),
    [
      "## Rule groups",
      "| id | label | entries | hands-off | prs |",
      "| --- | --- | --- | --- | --- |",
      ...rows,
    ].join("\n"),
  );

  return { ...value, root: join(value.home, "table") };
}

test("an invalid skills.conf names the conf path", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-codex-rules-"));
  directories.push(home);

  const codex = join(home, ".codex");
  const conf = join(home, "skills.conf");
  mkdirSync(conf);

  const output = applyCodexRules({
    root,
    home,
    codex,
    agents: join(home, ".agents/skills"),
    mode: "prs",
    current: {
      claude: join(home, ".claude"),
      agents: join(home, ".agents/skills"),
      conf,
      codex,
      checkout: "/checkout",
    },
    config: readDeliveryConfig({ SKILLS_CONF: conf }),
    env: {},
    stdin: {},
    stdout: {},
  });

  expect(output).toEqual([`skip   ${join(codex, "rules/skills.rules")} (${conf} is invalid)`]);
});

test("ask level and an off group shape the Codex rules", () => {
  const value = fixture("DELIVERY=hands-off\nAGENT_RULES=ask\nAGENT_RULES_MERGE=off\n");

  apply(value);
  const text = readFileSync(value.rules, "utf8");

  expect(text).not.toContain("# merge:");
  expect(text).not.toContain('"forbidden"');
  expect(text).toContain(
    'prefix_rule(pattern = ["git", ["commit", "push"]], decision = "prompt", justification = "Commit, push or open a PR")\n',
  );

  if (codexBinary)
    expect(execpolicy(value.rules, "git", "push", "origin", "feat/x")).toBe("prompt");
});

test("a skills.rules without the skills header stays byte identical", () => {
  const value = fixture();
  mkdirSync(dirname(value.rules));
  const mine = '# mine\nprefix_rule(pattern = ["rm"], decision = "forbidden")\n';
  writeFileSync(value.rules, mine);

  const output = apply(value);

  expect(readFileSync(value.rules, "utf8")).toBe(mine);
  expect(output).toContain(
    `skip   ${value.rules} (its first line is not "${rulesHeader}", so skills does not own it)\n`,
  );
});

test("unset AGENT_RULES writes no Codex rules", () => {
  const value = fixture("DELIVERY=prs\n");

  const output = apply(value);

  expect(existsSync(dirname(value.rules))).toBe(false);
  expect(output).not.toContain("skip   codex ");
});

test("hand edits: an added owned prefix is held, a stray line is replaced", () => {
  const value = fixture();
  apply(value);
  const owned = readFileSync(value.rules, "utf8");
  const added =
    'prefix_rule(pattern = ["gh", "pr", "lock"], decision = "forbidden", justification = "x")';

  const edited = owned.replace(
    'justification = "Merge a PR")\n',
    `justification = "Merge a PR")\n${added}\n`,
  );

  writeFileSync(value.rules, edited);
  const held = apply(value);
  const afterHeld = readFileSync(value.rules, "utf8");
  writeFileSync(value.rules, owned.replace("\n\n", "\nlocal = 1\n\n"));
  const replaced = apply(value);

  expect(held).toContain("left   codex merge rewrite forbidden (weakening, ");
  expect(held).not.toContain("restart Codex");
  expect(held).not.toContain("already holds every skills rule");

  expect(readFileSync(value.rules, "utf8")).toBe(owned);
  expect(replaced).toContain("codex  hand edits remove\n");
  expect(afterHeld).toBe(edited);
});

test("a repeated owned block is held as weakening, not dropped", () => {
  const value = fixture();
  apply(value);
  const owned = readFileSync(value.rules, "utf8");
  const repeated = `${owned}\n# merge: Merge a PR\nprefix_rule(pattern = ["gh", "repo", "delete"], decision = "forbidden", justification = "x")\n`;
  writeFileSync(value.rules, repeated);

  const output = apply(value);

  expect(output).toContain("left   codex merge rewrite forbidden (weakening, ");
  expect(readFileSync(value.rules, "utf8")).toContain('["gh", "repo", "delete"]');
});

test("an off group whose rules block the mode is named", () => {
  const value = fixture("DELIVERY=hands-off\nAGENT_RULES=deny\n");
  apply(value);
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=off\n");

  const output = apply(value);

  expect(output).toContain(
    `note   codex publishing is off, and its forbidden rules in ${value.rules} block what prs mode needs\n`,
  );

  expect(readFileSync(value.rules, "utf8")).toContain('["git", ["commit", "push"]]');
});

test("AGENT_RULES=off keeps hand edits, even when an override rewrites a group", () => {
  const value = fixture();
  apply(value);
  const edited = readFileSync(value.rules, "utf8").replace("\n\n", "\n# my note\n\n");
  writeFileSync(value.rules, edited);
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=off\n");

  const off = apply(value);
  const afterOff = readFileSync(value.rules, "utf8");
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=off\nAGENT_RULES_PUBLISHING=deny\n");
  const override = apply(value);

  expect(off).not.toContain("hand edits");
  expect(afterOff).toBe(edited);
  expect(override).not.toContain("hand edits");
  expect(readFileSync(value.rules, "utf8")).toContain("# my note\n");
});

test("a CODEX_HOME without search permission skips the rules with a reason", () => {
  const value = fixture();
  apply(value);
  chmodSync(value.codex, 0o600);

  let output: string;
  try {
    output = apply(value);
  } finally {
    chmodSync(value.codex, 0o700);
  }

  expect(output).toContain(`skip   ${value.rules} (cannot read its directory: `);
});

test("a codex whose execpolicy check hangs is cut off and writes nothing", () => {
  const value = fixture();
  const bin = join(value.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexec /bin/sleep 60\n", { mode: 0o755 });

  const lines = applyCodexRules({
    ...input(value),
    hooksPending: false,
    env: { PATH: `${bin}:/usr/bin:/bin` },
    timeout: 200,
  });

  expect(existsSync(value.rules)).toBe(false);
  expect(lines).toContain(
    `skip   ${value.rules} (codex execpolicy check failed: did not finish within 0.2 s, so the old file is kept)`,
  );
});

test.each([
  [
    "two token positions stay two patterns",
    "gh issue close *",
    [
      [["gh"], ["pr"], ["merge"]],
      [["gh"], ["issue"], ["close"]],
    ],
  ],
  ["one token position merge into one", "gh pr close *", [[["gh"], ["pr"], ["merge", "close"]]]],
])("entries differing in %s", (_label, second, expected) => {
  const value = fixture();
  const group: RuleGroup = {
    kind: "deny",
    id: "github",
    label: "GitHub",
    entries: ["Bash(gh pr merge *)", `Bash(${second})`],
    cells: { "hands-off": "deny", prs: "deny" },
  };

  const { patterns, skipped } = prefixPatterns(group, input(value).current, value.home);

  expect(skipped).toEqual([]);
  expect(patterns).toEqual(expected);
});

test.each([
  ["forbidden", "forbidden", "deny", "neutral"],
  ["prompt", "forbidden", "deny", "neutral"],
  ["forbidden", "prompt", "ask", "weakening"],
] as const)(
  "removing a %s rule beside a shorter %s rule at level %s is %s",
  (removed, shorter, level, expected) => {
    const value = synthetic(fixture(`DELIVERY=prs\nAGENT_RULES=${level}\n`), [
      "| `github` | GitHub | `Bash(gh *)` | deny | deny |",
    ]);

    const rule = (pattern: string, decision: string) =>
      `prefix_rule(pattern = ${pattern}, decision = "${decision}", justification = "GitHub")`;

    mkdirSync(dirname(value.rules));
    writeFileSync(
      value.rules,
      [
        rulesHeader,
        "",
        "# github: GitHub",
        rule('["gh"]', shorter),
        rule('["gh", "pr", "merge"]', removed),
        "",
      ].join("\n"),
    );

    const plan = planCodexRules(input(value));
    if (plan.kind !== "plan") throw new Error(`expected plan, got ${plan.kind}`);

    expect(plan.changes.map(({ group, class: change }) => [group, change])).toEqual([
      ["github", expected],
    ]);
  },
);
