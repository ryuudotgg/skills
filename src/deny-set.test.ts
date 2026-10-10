import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expandEntry, readRuleGroups, type Placeholder } from "./deny-set.ts";

const directories: string[] = [];
const heading = "## Rule groups";
const header = "| id | label | entries | hands-off | prs |";
const separator = "| --- | --- | --- | --- | --- |";
const valid = "| `sample` | Sample rule | `Bash(example:*)` | deny | absent |";

function fixture(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deny-set-"));
  directories.push(root);
  mkdirSync(join(root, "playbook/references"), { recursive: true });
  writeFileSync(join(root, "playbook/references/delivery.md"), content);

  return root;
}

function table(...rows: string[]): string {
  return [heading, header, separator, ...rows].join("\n");
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("rule groups", () => {
  test("reads nine repository groups in order, including one retired group", () => {
    const groups = readRuleGroups(resolve(import.meta.dir, "../skills"));

    expect(groups).toHaveLength(9);
    expect(groups.map((group) => group.id)).toEqual([
      "merge",
      "force-push",
      "pr-review",
      "issue-comment",
      "pr-comment",
      "skills-conf",
      "skills-git-config",
      "publishing",
      "skills-conf-write",
    ]);

    expect(groups.filter((group) => group.kind === "retired")).toEqual([
      {
        kind: "retired",
        id: "skills-conf-write",
        label: "Write skills.conf",
        entries: ["Write(~/.agents/skills.conf)"],
      },
    ]);
  });

  test("reads CRLF and stops at the next heading", () => {
    const root = fixture(`${table(valid)}\n## Next\n| ignored |`.replaceAll("\n", "\r\n"));

    expect(readRuleGroups(root)).toEqual([
      {
        kind: "deny",
        id: "sample",
        label: "Sample rule",
        entries: ["Bash(example:*)"],
        cells: { "hands-off": "deny", prs: "absent" },
      },
    ]);
  });

  test.each([
    ["ask", "absent", "deny"],
    ["absent", "ask", "deny"],
    ["allow", "absent", "allow"],
    ["absent", "allow", "allow"],
    ["allow", "allow", "allow"],
    ["absent", "deny-until-guard", "deny"],
  ] as const)("classifies %s and %s as %s", (handsOff, prs, kind) => {
    const root = fixture(
      table(`| \`sample\` | Sample | \`Edit({conf})\` | ${handsOff} | ${prs} |`),
    );

    expect(readRuleGroups(root)[0]?.kind).toBe(kind);
  });

  test.each([
    ["header", "invalid header", header.replace("id", "entry"), false],
    ["separator", "invalid separator", separator.replace("---", "--"), false],
    [
      "cell count",
      "rule row must have five cells",
      "| `sample` | Sample | `entry` | deny |",
      false,
    ],
    [
      "extra cell",
      "rule row must have five cells",
      "| `sample` | Sample | `entry` | deny | deny | extra |",
      false,
    ],
    ["unquoted id", "invalid group id", valid.replace("`sample`", "sample"), false],
    ["invalid id", "invalid group id", valid.replace("`sample`", "`bad--id`"), false],
    ["duplicate id", "duplicate group id", valid.replace("example", "other"), true],
    ["empty label", "empty group label", valid.replace("Sample rule", ""), false],
    [
      "no entries",
      "invalid backticked entries",
      valid.replace("`Bash(example:*)`", "plain"),
      false,
    ],
    [
      "extra entry text",
      "invalid backticked entries",
      valid.replace("`Bash(example:*)`", "text `entry`"),
      false,
    ],
    [
      "bad entry separator",
      "invalid backticked entries",
      valid.replace("`Bash(example:*)`", "`first`,  `second`"),
      false,
    ],
    ["hands-off cell", "invalid mode cell", valid.replace("deny", "unknown"), false],
    ["prs cell", "invalid mode cell", valid.replace("absent", "unknown"), false],
    ["hands-off guard", "guard cell is prs only", valid.replace("deny", "deny-until-guard"), false],
    [
      "mixed allow and deny",
      "allow group mixes deny or ask",
      valid.replace("absent", "allow"),
      false,
    ],
    [
      "mixed allow and ask",
      "allow group mixes deny or ask",
      valid.replace("deny", "ask").replace("absent", "allow"),
      false,
    ],
    [
      "mixed allow and guard",
      "allow group mixes deny or ask",
      valid.replace("deny", "allow").replace("absent", "deny-until-guard"),
      false,
    ],
    ["duplicate across groups", "duplicate entry", valid.replace("`sample`", "`other`"), true],
    [
      "normalised duplicate",
      "duplicate entry",
      valid.replace("`sample`", "`other`").replace(":*)", " *)"),
      true,
    ],
    [
      "duplicate in group",
      "duplicate entry",
      valid.replace("`Bash(example:*)`", "`Bash(example:*)`, `Bash(example:*)`"),
      false,
    ],
    ["misplaced wildcard", "misplaced :*", valid.replace("example:*", "ex:*ample"), false],
    [
      "nonterminal wildcard",
      "misplaced :*",
      valid.replace("Bash(example:*)", "Bash(example:*)suffix"),
      false,
    ],
    [
      "live Write",
      "live Write rule is ignored",
      valid.replace("Bash(example:*)", "Write({conf})"),
      false,
    ],
    [
      "unknown placeholder",
      "unknown placeholder",
      valid.replace("Bash(example:*)", "Edit({unknown})"),
      false,
    ],
  ] as const)("refuses %s and names the offending line", (name, reason, line, afterValid) => {
    const content =
      name === "header"
        ? [heading, line, separator, valid].join("\n")
        : name === "separator"
          ? [heading, header, line, valid].join("\n")
          : table(...(afterValid ? [valid, line] : [line]));

    const root = fixture(content);

    expect(() => readRuleGroups(root)).toThrow(`deny-set: delivery.md ${reason}: ${line}`);
  });

  test("refuses a missing heading", () => {
    const root = fixture("## Other\n");
    expect(() => readRuleGroups(root)).toThrow(`deny-set: delivery.md missing heading: ${heading}`);
  });

  test.each([heading, table(), `${table()}\n## Next\n${valid}`])(
    "refuses an empty table: %s",
    (content) => {
      const root = fixture(content);
      expect(() => readRuleGroups(root)).toThrow(`deny-set: delivery.md no rule rows: ${heading}`);
    },
  );
});

describe("expandEntry", () => {
  const values: Record<Placeholder, string> = {
    claude: "/h/a/.claude",
    agents: "/h/a/.agents/skills",
    conf: "/h/a/.agents/skills.conf",
    checkout: "/repository",
    codex: "/h/a/.codex",
  };

  test("leaves a literal entry unchanged", () => {
    expect(expandEntry("Edit(~/.agents/skills.conf)", values, "/h/a")).toEqual([
      "Edit(~/.agents/skills.conf)",
    ]);
  });

  test("renders non Bash paths under HOME", () => {
    expect(expandEntry("Edit({conf})", values, "/h/a")).toEqual(["Edit(~/.agents/skills.conf)"]);
    expect(expandEntry("Read({claude})", { ...values, claude: "/h/a" }, "/h/a")).toEqual([
      "Read(~)",
    ]);
  });

  test("renders non Bash outside HOME with two slashes", () => {
    expect(expandEntry("Edit({checkout})", values, "/h/a")).toEqual(["Edit(//repository)"]);
  });

  test("an empty HOME keeps every path absolute", () => {
    expect(expandEntry("Edit({conf})", values, "")).toEqual(["Edit(//h/a/.agents/skills.conf)"]);
  });

  test("does not mistake a HOME prefix for a child", () => {
    expect(expandEntry("Edit({conf})", { ...values, conf: "/h/ab/x" }, "/h/a")).toEqual([
      "Edit(//h/ab/x)",
    ]);
  });

  test("renders two Bash placeholders absolute, then tilde", () => {
    expect(expandEntry("Bash(example {agents} {codex})", values, "/h/a")).toEqual([
      "Bash(example /h/a/.agents/skills /h/a/.codex)",
      "Bash(example ~/.agents/skills ~/.codex)",
    ]);
  });

  test("renders Bash outside HOME once", () => {
    expect(expandEntry("Bash(example {checkout})", values, "/h/a")).toEqual([
      "Bash(example /repository)",
    ]);
  });
});
