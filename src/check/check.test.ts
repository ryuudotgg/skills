import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { areas } from "../cli.ts";
import { splitlines } from "../hooks/python-text.ts";
import { check, checkCommands, commandHead } from "./check.ts";
import { shlex } from "./shlex.ts";

const checkout = resolve(import.meta.dir, "../..");
const registry = { verbs: areas.flatMap((area) => area.verbs) };
const temporary = mkdtempSync(join(tmpdir(), "skills-check-"));
const clean = join(temporary, "clean");
const roots: string[] = [];

beforeAll(() => {
  const listed = Bun.spawnSync(["git", "ls-files", "-z", "-co", "--exclude-standard"], { cwd: checkout });
  expect(listed.exitCode).toBe(0);

  for (const file of new Set(listed.stdout.toString().split("\0").filter(Boolean))) {
    if (file.startsWith("src/check/fixtures/") || file.startsWith("scripts/fixtures/") || !existsSync(join(checkout, file))) continue;
    mkdirSync(dirname(join(clean, file)), { recursive: true });
    cpSync(join(checkout, file), join(clean, file));
  }
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(temporary, { recursive: true, force: true });
});

function fixture(overlay?: string): string {
  const root = mkdtempSync(join(temporary, "case-"));
  roots.push(root);
  cpSync(clean, root, { recursive: true });
  if (overlay) cpSync(join(import.meta.dir, "fixtures", overlay), root, { recursive: true });

  return root;
}

function ownerFixture(): { root: string; line: number } {
  const root = fixture("delivery-restatement");
  const path = join(root, "skills/plans/SKILL.md");
  const original = readFileSync(path, "utf8");
  const text = `${original.replace(/(^## \/plans do[^\n]*\n)/m, "$1Never commit it.\n")}Never commit it.\n`;
  writeFileSync(path, text);

  return { root, line: text.split("\n").length - 1 };
}

function runCheck(root: string) {
  const result = Bun.spawnSync([join(checkout, "skills/playbook/bin/skills"), "check", root], { cwd: checkout, stdout: "pipe", stderr: "pipe" });
  expect(result.stderr.toString()).toBe("");
  return { code: result.exitCode, lines: splitlines(result.stdout.toString()) };
}

test("owner restatement fixture", () => {
  const { root, line } = ownerFixture();
  const result = runCheck(root);
  expect(result.code).toBe(1);
  expect(result.lines.sort()).toEqual([
    "skills/fixture-owner/SKILL.md:6: restates the owner delivery rule, point at references/delivery.md",
    "skills/fixture-owner/SKILL.md:8: restates the owner delivery rule, point at references/delivery.md",
    `skills/plans/SKILL.md:${line}: restates the owner delivery rule, point at references/delivery.md`,
    "3 error(s)",
  ].sort());
});

test("shared model effort fixture", () => {
  expect(runCheck(fixture("codex-effort"))).toEqual({ code: 1, lines: [
    "skills/fixture-effort/SKILL.md:9: codex exec invocation pins low, but model-b requires high or medium",
    "skills/fixture-effort/SKILL.md:10: codex exec invocation pins high, but model-a requires low",
    "2 error(s)",
  ] });
});

test("codex hooks prefix fixture", () => {
  expect(runCheck(fixture("codex-hooks"))).toEqual({ code: 1, lines: [
    "skills/fixture-hooks/SKILL.md:8: codex exec read-only invocation lacks the AGENT_HOOKS=0 prefix",
    "skills/fixture-hooks/SKILL.md:10: codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off",
    "skills/fixture-hooks/SKILL.md:13: codex exec read-only invocation lacks the AGENT_HOOKS=0 prefix",
    "skills/fixture-hooks/SKILL.md:15: codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off",
    "skills/fixture-hooks/SKILL.md:16: codex exec invocation does not pin its sandbox with -s",
    "skills/fixture-hooks/SKILL.md:17: codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off",
    "skills/fixture-hooks/SKILL.md:17: codex exec read-only invocation lacks the AGENT_HOOKS=0 prefix",
    "skills/fixture-hooks/SKILL.md:18: codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off",
    "skills/fixture-hooks/SKILL.md:19: codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off",
    "skills/fixture-hooks/SKILL.md:19: codex exec read-only invocation lacks the AGENT_HOOKS=0 prefix",
    "10 error(s)",
  ] });
});

test("real repository", () => {
  expect(runCheck(checkout)).toEqual({ code: 0, lines: ["ok"] });
});

test("reviewer module fixture", () => {
  const { root } = ownerFixture();
  rmSync(join(root, "skills/coderabbit/reviewer.ts"));
  const result = runCheck(root);
  expect(result.code).toBe(1);
  expect(result.lines).toContain("skills/coderabbit/reviewer.conf: no reviewer.ts");
});

test("reviewer TypeScript fixture", () => {
  const root = fixture();
  expect(runCheck(root)).toEqual({ code: 0, lines: ["ok"] });

  rmSync(join(root, "skills/greptile/reviewer.ts"));
  const result = runCheck(root);
  expect(result.code).toBe(1);
  expect(result.lines).toContain("skills/greptile/reviewer.conf: no reviewer.ts");
});

test.each([
  ["cli-flag", "skills/fixture-flag/SKILL.md:6: skills plans frontier does not accept --bogus"],
  ["cli-verb", "skills/fixture-verb/SKILL.md:6: unknown verb skills nosuchverb"],
  ["script-path", "skills/fixture-script/SKILL.md:6: script <skill>/scripts/frontier.sh does not exist"],
])("acceptance 2 %s fixture", (overlay, message) => {
  expect(runCheck(fixture(overlay))).toEqual({ code: 1, lines: [message, "1 error(s)"] });
});

describe("shlex", () => {
  test("unclosed quote", () => {
    expect(() => shlex("one 'two")).toThrow("No closing quotation");
    expect(() => shlex('one "two')).toThrow("No closing quotation");
  });

  test("trailing backslash", () => {
    expect(() => shlex("one \\")).toThrow("No escaped character");
    expect(() => shlex('"one\\')).toThrow("No escaped character");
  });

  test("double quote escapes", () => {
    expect(shlex(String.raw`"a\"b\\c\$d\qe"`)).toEqual(['a"b\\c\\$d\\qe']);
    expect(shlex('"a\\\nb"')).toEqual(["a\\\nb"]);
    expect(shlex("one\\ two 'three\\four' \"\" a'b'c # literal")).toEqual(["one two", "three\\four", "", "abc", "#", "literal"]);
  });
});

describe("command scanner", () => {
  test("CLI paths count only in code and spans open on even backticks", () => {
    expect(checkCommands("Run skills/playbook/bin/skills to see the verbs.\n`echo`skills nosuchverb`\n", registry.verbs)).toEqual([]);
    expect(checkCommands("```sh\nbin/skills nosuchverb\n```\n~~~sh\nbin/skills nosuchverb\n~~~\nRun bin/skills nosuchverb", registry.verbs)).toEqual([
      { line: 2, message: "unknown verb skills nosuchverb" },
      { line: 5, message: "unknown verb skills nosuchverb" },
    ]);
  });

  test("JSON hook commands stop at the closing double quote", () => {
    expect(checkCommands('"command": "~/.agents/skills/playbook/bin/skills hook nosuch" }]', registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills hook nosuch" }]);
  });

  test("backslash continuations report the first command line", () => {
    expect(checkCommands("```sh\nbin/skills plans frontier \\\n  --bogus\n```", registry.verbs)).toEqual([{ line: 2, message: "skills plans frontier does not accept --bogus" }]);
    expect(checkCommands("`skills plans frontier \\\n  --bogus`", registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --bogus" }]);
  });

  test("fenced description columns end the command", () => {
    expect(checkCommands("~~~sh\nbin/skills plans frontier  --description\n~~~", registry.verbs)).toEqual([]);
    expect(checkCommands('```sh\nbin/skills plans frontier "two  spaces" --bogus\n```', registry.verbs)).toEqual([{ line: 2, message: "skills plans frontier does not accept --bogus" }]);
  });

  test("flag alternatives, terminators and leading root assignments", () => {
    expect(checkCommands("`skills plans frontier [--next|--bogus]`", registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --bogus" }]);
    expect(checkCommands("`skills plans frontier [--next|--stacks-on <id>] -- --bogus`", registry.verbs)).toEqual([]);
    expect(checkCommands("`bin/skills --root=<root> nosuchverb`", registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills nosuchverb" }]);
  });

  test("verbs with flagless usage reject unknown flags", () => {
    expect(checkCommands("`skills check --bogus`", registry.verbs)).toEqual([{ line: 1, message: "skills check does not accept --bogus" }]);
  });

  test.each(["```", "~~~"])("bare skills invocations in %s fences check verbs and flags", (fence) => {
    expect(checkCommands(`${fence}sh\n  skills round gate <pr> --bogus\n\tskills nosuch\n${fence}\nskills nosuch`, registry.verbs)).toEqual([
      { line: 2, message: "skills round gate does not accept --bogus" },
      { line: 3, message: "unknown verb skills nosuch" },
    ]);
  });

  test.each(["bin/skills", "<playbook>/bin/skills", "../bin/skills", "../playbook/bin/skills", "skills/playbook/bin/skills", "~/.agents/skills/playbook/bin/skills", '"$root/playbook/bin/skills"', "'<skills checkout>/skills/playbook/bin/skills'"])("scans %s", (path) => {
    expect(checkCommands(`Run \`${path} nosuchverb\`.`, registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills nosuchverb" }]);
  });

  test("backticked skills spans", () => {
    expect(checkCommands("`skills nosuchverb` and `skills test --all`", registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills nosuchverb" }]);
  });

  test("namespace flags use the union of usages", () => {
    expect(checkCommands("`skills plans --help --next` and `skills round --wait`", registry.verbs)).toEqual([]);
    expect(checkCommands("`skills plans --bogus`", registry.verbs)).toEqual([{ line: 1, message: "skills plans does not accept --bogus" }]);
    expect(checkCommands("`skills plans nosuchverb`", registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills plans nosuchverb" }]);
  });

  test("--root and --help skip only leading global options", () => {
    expect(checkCommands("`bin/skills --help --root '/tmp/space root' plans frontier --help`", registry.verbs)).toEqual([]);
    expect(checkCommands("`bin/skills --root <root> --help nosuchverb`", registry.verbs)).toEqual([{ line: 1, message: "unknown verb skills nosuchverb" }]);
    expect(checkCommands("`bin/skills plans frontier --root <root>`", registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --root" }]);
    expect(checkCommands("`bin/skills --root`", registry.verbs)).toEqual([]);
  });

  test("longest verb wins and flags use token boundaries", () => {
    expect(checkCommands("`bin/skills plans frontier --bogus=value`", registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --bogus" }]);
    expect(checkCommands("`skills pr watch -m`", registry.verbs)).toEqual([{ line: 1, message: "skills pr watch does not accept -m" }]);
    expect(checkCommands("`skills pr watch [--pretty], (--allow-draft) --timeout=4 -- -`", registry.verbs)).toEqual([]);
  });

  test("bracket alternatives and quoted operators stay inside the command", () => {
    expect(checkCommands("`skills plans frontier [--next | --bogus]`", registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --bogus" }]);
    expect(checkCommands('`bin/skills plans frontier "/tmp/a;b" --bogus; echo --another`', registry.verbs)).toEqual([{ line: 1, message: "skills plans frontier does not accept --bogus" }]);
    expect(commandHead('codex exec -C "/tmp/a;b"; echo')).toBe('codex exec -C "/tmp/a;b"');
  });

  test("invalid quotes and empty commands are skipped", () => {
    expect(checkCommands('`bin/skills plans frontier "unclosed`', registry.verbs)).toEqual([]);
    expect(checkCommands("```sh\nbin/skills plans frontier \\", registry.verbs)).toEqual([]);
    expect(checkCommands("`bin/skills`", registry.verbs)).toEqual([]);
  });
});

describe("repository contracts", () => {
  test("sentence periods do not hide script paths", () => {
    const root = fixture();
    writeFileSync(join(root, "skills/playbook/SKILL.md"), "---\nname: playbook\ndescription: demo\n---\nRun <skill>/scripts/frontier.sh.\n<skill>/scripts/frontier.sh.extra <skill>/scripts/frontier.sh/child\n");
    expect(check(root, registry)).toEqual(["skills/playbook/SKILL.md:5: script <skill>/scripts/frontier.sh does not exist"]);
  });

  test("directory walks and skill listings skip symlinked directories", () => {
    const root = fixture();
    const outside = mkdtempSync(join(temporary, "linked-"));
    roots.push(outside);

    writeFileSync(join(outside, "bad.md"), "`skills nosuchverb`\n");
    symlinkSync(outside, join(root, "skills/linked"));
    symlinkSync(outside, join(root, "evals/linked"));
    symlinkSync(outside, join(root, "docs/content/linked"));

    expect(check(root, registry)).toEqual([]);
  });

  test("CRLF SKILL frontmatter passes", () => {
    const root = fixture();
    mkdirSync(join(root, "skills/demo"));
    writeFileSync(join(root, "skills/demo/SKILL.md"), "---\r\nname: demo\r\ndescription: demo\r\n---\r\n");

    expect(check(root, registry)).toEqual([]);
  });

  test("delivery restatements use Unicode word boundaries", () => {
    const root = fixture();
    writeFileSync(join(root, "README.md"), "éNever commit it.\nNever commit it.\n");
    expect(check(root, registry)).toEqual(["README.md:2: restates the owner delivery rule, point at references/delivery.md"]);
  });

  test("codex help flags printed only on stderr are known", () => {
    const root = mkdtempSync(join(temporary, "stderr-help-"));
    roots.push(root);
    mkdirSync(join(root, "skills/playbook/references"), { recursive: true });
    writeFileSync(join(root, "skills/playbook/SKILL.md"), "---\nname: playbook\ndescription: demo\n---\n");
    writeFileSync(join(root, "skills/playbook/references/codex-arms.md"), '| tier | -m | effort | use |\n| --- | --- | --- | --- |\n| small | demo | low | demo |\n\ncodex review -c model_reasoning_effort="low"\n');

    const bin = join(root, "codex-bin");

    mkdirSync(bin);
    writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s\\n" " -s <sandbox>" " -c <config>" " --stderr-only <value>" >&2\n');
    chmodSync(join(bin, "codex"), 0o755);

    writeFileSync(join(root, "README.md"), "AGENT_HOOKS=0 codex exec -s read-only -c model_reasoning_effort=low --stderr-only value\n");
    const result = Bun.spawnSync([join(checkout, "skills/playbook/bin/skills"), "check", root], { cwd: checkout, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("ok\n");
    expect(result.stderr.toString()).toBe("");
  });

  test.each([
    ["", "no frontmatter"],
    ["---\nname: demo\n", "frontmatter never closes"],
    ["---\n- name\n---\n", "frontmatter is not a mapping"],
    ["---\nnull\n---\n", "frontmatter is not a mapping"],
    ["---\nplain\n---\n", "frontmatter is not a mapping"],
  ])("frontmatter %j", (text, message) => {
    const root = fixture();
    mkdirSync(join(root, "skills/demo"));
    writeFileSync(join(root, "skills/demo/SKILL.md"), text);
    expect(check(root, registry)).toEqual([`skills/demo/SKILL.md:1: ${message}`]);
  });

  test("YAML 1.2 keeps yes as a name and renders boolean pins like Python", () => {
    const root = fixture();
    mkdirSync(join(root, "skills/yes"));
    writeFileSync(join(root, "skills/yes/SKILL.md"), "---\nname: yes\ndescription: demo\n---\n");
    expect(check(root, registry)).toEqual([]);

    writeFileSync(join(root, "skills/yes/SKILL.md"), "---\nname: true\ndescription: demo\n---\n");
    expect(check(root, registry)).toEqual(["skills/yes/SKILL.md:1: frontmatter missing name", "skills/yes/SKILL.md:1: name is True, directory says 'yes'"]);
  });

  test.each([
    [undefined, "reference file is missing"],
    ["# reference\n", "tier effort table is missing"],
    ["| tier | -m | effort | use |\n| --- | --- | --- | --- |\n| small | model | low | small |\n", "review effort is missing"],
  ])("effort reference %s", (text, message) => {
    const root = fixture();
    const path = join(root, "skills/playbook/references/codex-arms.md");
    if (text === undefined) rmSync(path);
    else writeFileSync(path, text);

    expect(check(root, registry)).toContain(`skills/playbook/references/codex-arms.md: ${message}`);
  });

  test.each(["| short |", "| short | model | low |"])("short tier effort row %s reports its line and continues checking", (row) => {
    const root = fixture();
    writeFileSync(join(root, "skills/playbook/references/codex-arms.md"), `# Codex arms\n\n| tier | -m | effort | use |\n| --- | --- | --- | --- |\n${row}\n| small | model | low | small |\n\ncodex review -c model_reasoning_effort="low"\n`);
    writeFileSync(join(root, "README.md"), '`skills nosuch`\nAGENT_HOOKS=0 codex exec -s read-only -m model -c model_reasoning_effort="high"\n');

    expect(check(root, registry)).toEqual([
      "skills/playbook/references/codex-arms.md:5: tier effort row needs four cells",
      "README.md:2: codex exec invocation pins high, but model requires low",
      "README.md:1: unknown verb skills nosuch",
    ]);
  });

  test("script placeholders resolve against the tree and report retired ports", () => {
    const root = fixture();
    const path = join(root, "skills/playbook/SKILL.md");
    const text = readFileSync(path, "utf8");
    const line = splitlines(text).length + 1;
    const plansPath = join(root, "skills/plans/SKILL.md");
    const plansText = readFileSync(plansPath, "utf8");
    const plansLine = splitlines(plansText).length + 1;

    for (const script of ["scripts/validate.py", "skills/plans/scripts/frontier.sh", "skills/playbook/scripts/frontier.sh", "skills/playbook/scripts/delivery-mode.sh", "skills/playbook/scripts/lease-rebase.sh"]) {
      rmSync(join(root, script), { force: true });
      expect(existsSync(join(root, script))).toBe(false);
    }

    writeFileSync(plansPath, `${plansText}<skill>/scripts/frontier.sh\n`);
    writeFileSync(path, `${text}<skill>/scripts/frontier.sh <repo>/scripts/validate.py <playbook>/scripts/delivery-mode.sh <playbook>/scripts/lease-rebase.sh <unknown>/no.sh ~/.claude/hooks/old.py <playbook>/no.py ~/.agents/skills/playbook/no.sh\n`);
    expect(check(root, registry).toSorted()).toEqual([
      `skills/plans/SKILL.md:${plansLine}: script <skill>/scripts/frontier.sh does not exist, ported to skills plans frontier`,
      `skills/playbook/SKILL.md:${line}: script <skill>/scripts/frontier.sh does not exist`,
      `skills/playbook/SKILL.md:${line}: script <repo>/scripts/validate.py does not exist, ported to skills check`,
      `skills/playbook/SKILL.md:${line}: script <playbook>/scripts/delivery-mode.sh does not exist, ported to skills delivery`,
      `skills/playbook/SKILL.md:${line}: script <playbook>/scripts/lease-rebase.sh does not exist, ported to skills lease-rebase`,
      `skills/playbook/SKILL.md:${line}: script <playbook>/no.py does not exist`,
      `skills/playbook/SKILL.md:${line}: script ~/.agents/skills/playbook/no.sh does not exist`,
    ].toSorted());
  });

  test("eval markdown checks commands only", () => {
    const root = fixture();
    writeFileSync(join(root, "evals/prose.md"), "`skills nosuchverb` \u2014 Never commit it. `codex-missing` `<repo>/no.sh`\n");
    expect(check(root, registry)).toEqual(["evals/prose.md:1: unknown verb skills nosuchverb"]);
  });

  test("CLI defaults to its checkout and accepts an explicit root", () => {
    const bin = join(checkout, "skills/playbook/bin/skills");
    const result = Bun.spawnSync([bin, "check"], { cwd: temporary });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("ok\n");
    expect(result.stderr.toString()).toBe("");

    expect(runCheck(fixture())).toEqual({ code: 0, lines: ["ok"] });
  });
});
