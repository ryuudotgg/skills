import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  canonical,
  expandEntry,
  readRuleGroups,
  type Cell,
  type Placeholder,
} from "../deny-set.ts";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { rulesHeader } from "./codex-rules.ts";
import { claudeBlock, commandFor, hookTable } from "./hook-table.ts";

const repo = resolve(import.meta.dir, "../..");
const cli = join(repo, "src/cli.ts");
const directories: string[] = [];
function installHome() {
  const home = mkdtempSync(join(tmpdir(), "skills-install-"));
  directories.push(home);

  const agents = join(home, ".agents/skills");
  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const conf = join(home, ".agents/skills.conf");

  const tools = join(home, "tools");
  mkdirSync(claude);
  mkdirSync(codex);
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, "bun"));

  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    AGENTS_DIR: agents,
    CLAUDE_HOME: claude,
    CODEX_HOME: codex,
    SKILLS_CONF: conf,
    SEED_DIRS: `${claude}/skills ${codex}/skills`,
    EXTRA_DIRS: "",
  };

  delete env.CLAUDE_CONFIG_DIR;
  delete env.CI;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.XDG_CONFIG_HOME;

  return { home, agents, claude, codex, conf, env };
}

async function install(
  value: ReturnType<typeof installHome>,
  args: string[] = [],
  root = join(repo, "skills"),
) {
  return runCommand([process.execPath, "--no-env-file", cli, "--root", root, "install", ...args], {
    cwd: dirname(root),
    env: value.env,
  });
}

function tableEntries(
  value: ReturnType<typeof installHome> & { root: string },
  mode?: "hands-off" | "prs",
  cells: readonly Cell[] = ["deny", "deny-until-guard"],
): string[] {
  const values: Record<Placeholder, string> = {
    claude: value.claude,
    agents: value.agents,
    conf: value.conf,
    codex: value.codex,
    checkout: dirname(value.root),
  };

  return readRuleGroups(value.root)
    .filter(
      (group) =>
        mode === undefined || (group.kind !== "retired" && cells.includes(group.cells[mode])),
    )
    .flatMap((group) => group.entries.flatMap((entry) => expandEntry(entry, values, value.home)));
}

function withoutOwned(text: string, entries: readonly string[]): string {
  const owned = new Set(entries.map(canonical));
  return text
    .replace(/,\n  "hooks": \{[\s\S]*\n  \}\n\}/, "\n}")
    .split("\n")
    .filter((line) => {
      const entry = line.trim().replace(/,$/, "");
      if (!entry.startsWith('"')) return true;

      try {
        return !owned.has(canonical(JSON.parse(entry)));
      } catch {
        return true;
      }
    })
    .join("\n")
    .replace(/,\n(\s*\])/g, "\n$1");
}

async function fixture() {
  const root = await createRepo();
  directories.push(root);
  await writeFixture(root, "install.sh", "#!/bin/sh\n");
  await writeFixture(root, "skills/playbook/bin/skills", "#!/bin/sh\n");
  await writeFixture(root, "skills/playbook/SKILL.md", "---\nname: playbook\n---\n");
  await writeFixture(
    root,
    "skills/playbook/references/delivery.md",
    readFileSync(join(repo, "skills/playbook/references/delivery.md"), "utf8"),
  );

  for (const [name, requires] of [
    ["fixture-ext", "requires: prs\n"],
    ["fixture-plain", ""],
    ["fixture-array", "requires: [prs, other]\n"],
  ])
    await writeFixture(
      root,
      `skills/${name}/SKILL.md`,
      `---\nname: ${name}\noptional: true\n${requires}---\n`,
    );

  await writeFixture(root, "agents/opus-review.md", "older opus review\n");
  await writeFixture(root, "agents/codex-sol.md", "retired codex sol\n");

  for (const name of [
    "session-brief.sh",
    "commit-guard.sh",
    "reply-guard.sh",
    "no-comments.sh",
    "no-em-dash.sh",
    "comment_scan.py",
    "reply_guard.py",
  ])
    await writeFixture(root, `hooks/${name}`, `owned ${name}\n`);

  await commitFixture(root);
  await writeFixture(root, "agents/opus-review.md", "current opus review\n");
  rmSync(join(root, "agents/codex-sol.md"));
  rmSync(join(root, "hooks"), { recursive: true });
  await commitFixture(root);

  return { ...installHome(), root: join(root, "skills") };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(removeTemporary));
});

test("CLAUDE_CONFIG_DIR supplies agents and the default skills seed", async () => {
  const value = await fixture();
  const claude = join(value.home, "alt");
  mkdirSync(claude);
  rmSync(value.claude, { recursive: true });

  value.env.CLAUDE_CONFIG_DIR = claude;
  delete value.env.CLAUDE_HOME;
  delete value.env.SEED_DIRS;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(join(claude, "agents/opus-review.md"), "utf8")).toBe("current opus review\n");
  expect(readlinkSync(join(claude, "skills/playbook"))).toBe(join(value.agents, "playbook"));
  expect(existsSync(value.claude)).toBe(false);
  expect(result.stdout).not.toContain("warn   ");
});

test("a separate CLAUDE_HOME warns once on every install", async () => {
  const value = await fixture();
  const claude = join(value.home, "other");
  mkdirSync(claude);
  value.env.CLAUDE_HOME = claude;

  for (let run = 0; run < 2; run++) {
    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(readFileSync(join(claude, "agents/opus-review.md"), "utf8")).toBe(
      "current opus review\n",
    );

    expect(result.stdout.split("\n").filter((line) => line.startsWith("warn   "))).toEqual([
      `warn   ${claude} (CLAUDE_HOME is not where Claude Code reads its config, which is ${value.claude})`,
    ]);

    expect(result.stdout).toContain(`mode   hands-off\nwarn   ${claude}`);
    expect(result.stdout).toContain(`Add it to permissions in ${value.claude}/settings.json`);
  }
});

test("managed rules go where Claude Code reads settings, not a separate CLAUDE_HOME", async () => {
  const value = await fixture();
  const claude = join(value.home, "other");
  mkdirSync(claude);
  value.env.CLAUDE_HOME = claude;

  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "AGENT_RULES=deny\n");

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(join(value.claude, "settings.json"), "utf8")).toContain(
    '"Bash(gh pr merge:*)"',
  );

  expect(existsSync(join(claude, "settings.json"))).toBe(false);
});

test.each(["equal", "symlink", "trailing slash", "default"])(
  "a %s CLAUDE_HOME matching Claude Code stays quiet",
  async (variant) => {
    const value = await fixture();
    if (variant !== "default") value.env.CLAUDE_CONFIG_DIR = value.claude;
    if (variant === "symlink") {
      const link = join(value.home, "claude-link");
      symlinkSync(value.claude, link);
      value.env.CLAUDE_HOME = link;
    }

    if (variant === "trailing slash") value.env.CLAUDE_HOME = `${value.claude}/`;

    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("warn   ");
  },
);

test("project hook registrations follow CLAUDE_CONFIG_DIR state", async () => {
  const value = await fixture();
  const claude = join(value.home, "alt");
  const copies = join(claude, "hooks");
  const project = join(value.home, "project");

  mkdirSync(copies, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
  writeFileSync(
    join(project, ".claude/settings.json"),
    JSON.stringify({ hooks: { Stop: [{ command: join(copies, "comment_scan.py") }] } }),
  );

  writeFileSync(join(claude, ".claude.json"), JSON.stringify({ projects: { [project]: {} } }));
  writeFileSync(join(value.home, ".claude.json"), JSON.stringify({ projects: {} }));

  value.env.CLAUDE_CONFIG_DIR = claude;
  delete value.env.CLAUDE_HOME;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test.each([
  ["a separate CLAUDE_HOME", "other", "", ".claude.json"],
  ["CLAUDE_CONFIG_DIR at ~/.claude", ".claude", ".claude", ".claude/.claude.json"],
])("project state Claude Code reads keeps copies under %s", async (_label, home, config, state) => {
  const value = await fixture();
  const claude = join(value.home, home);
  const copies = join(claude, "hooks");
  const project = join(value.home, "project");

  mkdirSync(copies, { recursive: true });
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
  writeFileSync(
    join(project, ".claude/settings.json"),
    JSON.stringify({ hooks: { Stop: [{ command: join(copies, "comment_scan.py") }] } }),
  );

  writeFileSync(join(value.home, state), JSON.stringify({ projects: { [project]: {} } }));

  value.env.CLAUDE_HOME = claude;
  if (config) value.env.CLAUDE_CONFIG_DIR = join(value.home, config);

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test("a CLAUDE_CONFIG_DIR with a space gets the default skills seed", async () => {
  const value = await fixture();
  const claude = join(value.home, "Claude Config");
  mkdirSync(claude);

  value.env.CLAUDE_CONFIG_DIR = claude;
  delete value.env.CLAUDE_HOME;
  delete value.env.SEED_DIRS;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readlinkSync(join(claude, "skills/playbook"))).toBe(join(value.agents, "playbook"));
  expect(existsSync(join(value.home, "Claude"))).toBe(false);
});

test("an unreadable CLAUDE_CONFIG_DIR state keeps every copy", async () => {
  const value = await fixture();
  const claude = join(value.home, "alt");
  const copies = join(claude, "hooks");

  mkdirSync(copies, { recursive: true });
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
  writeFileSync(join(claude, ".claude.json"), "{invalid");

  value.env.CLAUDE_CONFIG_DIR = claude;
  delete value.env.CLAUDE_HOME;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test("CLAUDE_CONFIG_DIR state ignores unreadable home state", async () => {
  const value = await fixture();
  const claude = join(value.home, "alt");
  const copies = join(claude, "hooks");

  mkdirSync(copies, { recursive: true });
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
  writeFileSync(join(claude, ".claude.json"), JSON.stringify({ projects: {} }));
  writeFileSync(join(value.home, ".claude.json"), "{invalid");

  value.env.CLAUDE_CONFIG_DIR = claude;
  delete value.env.CLAUDE_HOME;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(existsSync(join(copies, "comment_scan.py"))).toBe(false);
  expect(result.stdout).toContain("prune  comment_scan.py");
});

test("printed deny lists stay byte stable in both modes", async () => {
  const value = installHome();
  const installer = [
    '  "Bash(./install.sh *)",',
    '  "Bash(sh install.sh *)",',
    '  "Bash(sh ./install.sh *)",',
    '  "Bash(bash install.sh *)",',
    '  "Bash(bash ./install.sh *)",',
    `  "Bash(${repo}/install.sh *)",`,
    '  "Bash(./skills/playbook/bin/skills install *)",',
    `  "Bash(${repo}/skills/playbook/bin/skills install *)",`,
    `  "Bash(${value.agents}/playbook/bin/skills install *)",`,
    '  "Bash(~/.agents/skills/playbook/bin/skills install *)",',
    `  "Bash(${value.claude}/skills/playbook/bin/skills install *)",`,
    '  "Bash(~/.claude/skills/playbook/bin/skills install *)",',
    '  "Bash(skills install *)",',
    '  "Bash(./skills/playbook/bin/skills --root * install)",',
    '  "Bash(./skills/playbook/bin/skills --root * install *)",',
    `  "Bash(${repo}/skills/playbook/bin/skills --root * install)",`,
    `  "Bash(${repo}/skills/playbook/bin/skills --root * install *)",`,
    `  "Bash(${value.agents}/playbook/bin/skills --root * install)",`,
    '  "Bash(~/.agents/skills/playbook/bin/skills --root * install)",',
    `  "Bash(${value.claude}/skills/playbook/bin/skills --root * install)",`,
    '  "Bash(~/.claude/skills/playbook/bin/skills --root * install)",',
    `  "Bash(${value.agents}/playbook/bin/skills --root * install *)",`,
    '  "Bash(~/.agents/skills/playbook/bin/skills --root * install *)",',
    `  "Bash(${value.claude}/skills/playbook/bin/skills --root * install *)",`,
    '  "Bash(~/.claude/skills/playbook/bin/skills --root * install *)",',
    '  "Bash(skills --root * install)",',
    '  "Bash(skills --root * install *)",',
  ];

  const handsOff = [
    '"deny": [',
    '  "Bash(gh pr merge:*)",',
    '  "Bash(gh stack merge:*)",',
    '  "Bash(git push --force *)",',
    '  "Bash(git push * --force)",',
    '  "Bash(git push * --force *)",',
    '  "Bash(git push -f *)",',
    '  "Bash(git push * -f)",',
    '  "Bash(git push * -f *)",',
    '  "Bash(git push -fu *)",',
    '  "Bash(git push * -fu)",',
    '  "Bash(git push * -fu *)",',
    '  "Bash(git push -uf *)",',
    '  "Bash(git push * -uf)",',
    '  "Bash(git push * -uf *)",',
    '  "Bash(git push --mirror *)",',
    '  "Bash(git push * --mirror)",',
    '  "Bash(git push * --mirror *)",',
    '  "Bash(git push * +*)",',
    '  "Bash(gh pr review:*)",',
    '  "Bash(gh issue comment:*)",',
    '  "Bash(gh pr comment:*)",',
    '  "Edit(~/.agents/skills.conf)",',
    ...installer,
    '  "Bash(git config skills.*)",',
    '  "Bash(git config * skills.*)",',
    '  "Bash(git commit:*)",',
    '  "Bash(git push:*)",',
    '  "Bash(gh pr create:*)",',
    '  "Bash(gh pr edit:*)",',
    '  "Bash(gh pr ready:*)",',
    '  "Bash(gh pr close:*)",',
    '  "Bash(gh stack submit:*)",',
    '  "Bash(gh stack sync:*)",',
    '  "Bash(gh stack push:*)"',
    "]",
  ].join("\n");

  const prs = [
    '"deny": [',
    '  "Bash(gh pr merge:*)",',
    '  "Bash(gh stack merge:*)",',
    '  "Bash(git push --force *)",',
    '  "Bash(git push * --force)",',
    '  "Bash(git push * --force *)",',
    '  "Bash(git push -f *)",',
    '  "Bash(git push * -f)",',
    '  "Bash(git push * -f *)",',
    '  "Bash(git push -fu *)",',
    '  "Bash(git push * -fu)",',
    '  "Bash(git push * -fu *)",',
    '  "Bash(git push -uf *)",',
    '  "Bash(git push * -uf)",',
    '  "Bash(git push * -uf *)",',
    '  "Bash(git push --mirror *)",',
    '  "Bash(git push * --mirror)",',
    '  "Bash(git push * --mirror *)",',
    '  "Bash(git push * +*)",',
    '  "Bash(gh pr review:*)",',
    '  "Bash(gh issue comment:*)",',
    '  "Bash(gh pr comment:*)",',
    '  "Edit(~/.agents/skills.conf)",',
    ...installer,
    '  "Bash(git config skills.*)",',
    '  "Bash(git config * skills.*)"',
    "]",
  ].join("\n");

  const defaultResult = await install(value);

  expect(defaultResult.code).toBe(0);
  expect(defaultResult.stderr).toBe("");
  expect(defaultResult.stdout.match(/"deny": \[\n[\s\S]*?\n\]/)?.[0]).toBe(handsOff);

  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\n");
  const prsResult = await install(value);

  expect(prsResult.code).toBe(0);
  expect(prsResult.stderr).toBe("");
  expect(prsResult.stdout.match(/"deny": \[\n[\s\S]*?\n\]/)?.[0]).toBe(
    prs.replace('  "Bash(gh pr comment:*)",\n', ""),
  );

  expect(defaultResult.stdout).toContain('"ask": [\n  "Edit(~/.claude/settings.json)"\n]');
  expect(prsResult.stdout).toContain('"ask": [\n  "Edit(~/.claude/settings.json)"\n]');
});

function editTable(value: { root: string }, from: string, to: string): void {
  const path = join(value.root, "playbook/references/delivery.md");
  const content = readFileSync(path, "utf8");
  if (!content.includes(from)) throw new Error(`fixture table lacks ${from}`);

  writeFileSync(path, content.replace(from, to));
}

test("a live allow cell prints an allow block and exits successfully", async () => {
  const value = await fixture();
  editTable(
    value,
    "| deny | absent |\n",
    "| deny | absent |\n| `extra` | Extra | `Bash(true:*)` | absent | allow |\n",
  );

  const handsOff = await install(value, [], value.root);

  expect(handsOff.stderr).toBe("");
  expect(handsOff.code).toBe(0);

  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\n");
  const prs = await install(value, [], value.root);

  expect(prs.code).toBe(0);
  expect(prs.stderr).toBe("");
  const allow = prs.stdout.match(/"allow": \[\n[\s\S]*?\n\]/)?.[0];

  expect(allow).toBeDefined();
  expect(JSON.parse(`{${allow}}`).allow).toContain("Bash(true:*)");
  expect(JSON.parse(`{${allow}}`).allow).toEqual(tableEntries(value, "prs", ["allow"]));
});

test("managed prs adopts pasted rules, keeps personal bytes and leaves publishing on every run", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");

  const path = join(value.claude, "settings.json");
  const merge = new Set(readRuleGroups(value.root).find((group) => group.id === "merge")!.entries);
  const pasted = tableEntries(value, "hands-off").filter((entry) => !merge.has(entry));
  const personal = {
    model: "personal-model",
    enabled: true,
    numeric: "NUMBER",
    permissions: {
      deny: ["Bash(personal *)"],
      ask: ["Read(~/private/**)"],
      allow: ["Bash(personal-allowed *)"],
      personalKey: "kept",
    },
    trailing: { personal: true },
  };

  const format = (data: unknown) =>
    `${JSON.stringify(data, null, 2).replace('"NUMBER"', "1.2300")}\n`;

  const text = format({
    ...personal,
    permissions: {
      ...personal.permissions,
      deny: [...personal.permissions.deny, ...pasted, "Write(~/.agents/skills.conf)"],
    },
  });

  writeFileSync(path, text);

  const first = await install(value, [], value.root);
  const written = readFileSync(path, "utf8");
  const beforeRerun = statSync(path);

  const left = `left   publishing remove 9 from deny (weakening, stdin is not a terminal and stdout is not a terminal; edit ${path} by hand to apply it)`;
  const allowLeft = `left   skills-cli add ${tableEntries(value, "prs", ["allow"]).length} to allow (weakening, stdin is not a terminal and stdout is not a terminal; edit ${path} by hand to apply it)`;
  const commentLeft = `left   pr-comment remove 1 from deny (weakening, stdin is not a terminal and stdout is not a terminal; edit ${path} by hand to apply it)`;

  expect(first.code).toBe(0);
  expect(first.stderr).toBe("");
  expect(first.stdout).toContain("rules  merge add 2 to deny\n");
  expect(first.stdout).toContain("rules  skills-conf-write remove 1 from deny\n");
  expect(first.stdout.split("\n").filter((line) => line.startsWith("left   "))).toEqual([
    commentLeft,
    left,
    allowLeft,
  ]);

  expect(first.stdout.indexOf("agent  opus-review")).toBeLessThan(
    first.stdout.indexOf("rules  merge"),
  );

  expect(first.stdout.indexOf("rules  merge")).toBeLessThan(first.stdout.indexOf("codex  add"));
  expect(written).not.toContain("Write(~/.agents/skills.conf)");
  expect(JSON.parse(written).permissions.deny).toEqual([
    ...personal.permissions.deny,
    ...pasted,
    ...merge,
  ]);

  expect(withoutOwned(written, tableEntries(value))).toBe(format(personal));

  for (const key of [
    '  "model": "personal-model",',
    '  "enabled": true,',
    '  "numeric": 1.2300,',
    '    "personalKey": "kept"',
    '  "trailing": {\n    "personal": true\n  }',
  ])
    expect(written).toContain(key);

  const second = await install(value, [], value.root);

  expect(second.code).toBe(0);
  expect(second.stderr).toBe("");
  expect(second.stdout).not.toContain("rules  ");
  expect(second.stdout.split("\n").filter((line) => line.startsWith("left   "))).toEqual([
    commentLeft,
    left,
    allowLeft,
  ]);

  expect(readFileSync(path, "utf8")).toBe(written);
  expect(statSync(path).ino).toBe(beforeRerun.ino);
  expect(statSync(path).mtimeMs).toBe(beforeRerun.mtimeMs);
});

test("publishing allow is skipped, noted on stdout and writes no allow entry", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=allow\n");

  const result = await install(value, [], value.root);
  const settings = JSON.parse(readFileSync(join(value.claude, "settings.json"), "utf8"));

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain(
    `note   ${value.conf}: AGENT_RULES_PUBLISHING=allow is not deny, ask or off, skipped\n`,
  );

  expect(settings.permissions.allow).toBeUndefined();
  expect(settings.permissions.deny).not.toContain("Bash(git push:*)");
});

test("switching managed prs to hands-off adds publishing back after the config rewrite", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\r\nAGENT_RULES=deny\r\n");
  expect((await install(value, [], value.root)).code).toBe(0);

  const result = await install(value, ["--without", "prs"], value.root);

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toContain("rules  publishing add 9 to deny\n");
  expect(result.stdout.split("\n").filter((line) => line.startsWith("left   "))).toEqual([
    `left   skills-cli add 120 to allow (weakening, stdin is not a terminal and stdout is not a terminal; edit ${join(value.claude, "settings.json")} by hand to apply it)`,
  ]);

  expect(
    JSON.parse(
      readFileSync(join(value.claude, "settings.json"), "utf8"),
    ).permissions.deny.toSorted(),
  ).toEqual(tableEntries(value, "hands-off").toSorted());

  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=hands-off\nAGENT_RULES=deny\nWITH=\n");
});

test.each([
  ["{invalid", "invalid JSON"],
  ['{"personal":true,"permissions":null}\n', "permissions is not an object"],
])(
  "managed refused rules %s fall back while valid settings still get hooks",
  async (text, reason) => {
    const value = await fixture();
    mkdirSync(dirname(value.conf), { recursive: true });
    writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");

    const path = join(value.claude, "settings.json");
    writeFileSync(path, text);
    const before = statSync(path);

    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");

    expect(result.stdout).toContain("Rule set for prs mode, not written (");
    expect(result.stdout).toContain(reason);
    expect(result.stdout).toContain(`Add it to permissions in ${path} yourself:`);
    expect(result.stdout).toContain('"deny": [\n  "Bash(gh pr merge:*)"');
    expect(result.stdout).not.toContain("rules  ");

    if (reason === "invalid JSON") {
      expect(result.stdout).toContain(
        "Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code",
      );

      expect(result.stdout).toContain(claudeBlock("~/.agents/skills"));
      expect(readFileSync(path, "utf8")).toBe(text);
      expect(statSync(path).ino).toBe(before.ino);
      expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
    } else {
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        ...JSON.parse(text),
        ...JSON.parse(claudeBlock("~/.agents/skills")),
      });

      expect(result.stdout).not.toContain("Paste the Claude Code hooks block");
    }
  },
);

test("managed rules create missing settings", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain("rules  merge add 2 to deny\n");
  expect(JSON.parse(readFileSync(join(value.claude, "settings.json"), "utf8"))).toEqual({
    ...JSON.parse(claudeBlock("~/.agents/skills")),
    permissions: {
      deny: tableEntries(value, "prs", ["deny"]),
      ask: ["Edit(~/.claude/settings.json)"],
    },
  });
});

test.each([false, true])(
  "wired prs guard leaves an existing pr-comment deny but adds none, existing: %s",
  async (existing) => {
    const value = await fixture();
    mkdirSync(dirname(value.conf), { recursive: true });
    writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
    const path = join(value.claude, "settings.json");
    const hooks = {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: commandFor("hook pre-tool-use", value.agents) }],
        },
      ],
    };

    writeFileSync(
      path,
      JSON.stringify(
        { hooks, ...(existing ? { permissions: { deny: ["Bash(gh pr comment:*)"] } } : {}) },
        null,
        2,
      ) + "\n",
    );

    const result = await install(value, [], value.root);
    const settings = JSON.parse(readFileSync(path, "utf8"));

    expect(result.code).toBe(0);
    expect(settings.hooks).toEqual({
      ...JSON.parse(claudeBlock("~/.agents/skills")).hooks,
      ...hooks,
    });

    expect(settings.permissions.deny.includes("Bash(gh pr comment:*)")).toBe(existing);
    expect(result.stdout).not.toContain("rules  pr-comment");
    expect(result.stdout.split("\n").filter((line) => line.startsWith("left   "))).toEqual([
      ...(existing
        ? [
            `left   pr-comment remove 1 from deny (weakening, stdin is not a terminal and stdout is not a terminal; edit ${path} by hand to apply it)`,
          ]
        : []),
      `left   skills-cli add 120 to allow (weakening, stdin is not a terminal and stdout is not a terminal; edit ${path} by hand to apply it)`,
    ]);
  },
);

test("CI is named alongside both failed terminal conditions", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
  const path = join(value.claude, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({ permissions: { deny: tableEntries(value, "hands-off") } }, null, 2) + "\n",
  );

  value.env.CI = "true";

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `left   publishing remove 9 from deny (weakening, stdin is not a terminal and stdout is not a terminal and CI is set; edit ${path} by hand to apply it)\n`,
  );
});

test("an expanded placeholder prints as an escaped JSON string", async () => {
  const value = await fixture();
  value.env.SKILLS_CONF = join(value.home, 'q"x\\y.conf');
  const result = await install(value, [], value.root);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`  ${JSON.stringify('Edit(~/q"x\\y.conf)')},\n`);
});

test("array requires is never linked", async () => {
  const value = await fixture();
  const result = await install(value, ["--with", "prs"], value.root);

  expect(result.code).toBe(0);

  for (const directory of [value.agents, join(value.claude, "skills"), join(value.codex, "skills")])
    expect(existsSync(join(directory, "fixture-array"))).toBe(false);

  expect(result.stdout).toContain("off    fixture-array");
});

test("fresh HOME needs only bun, git and gh runtime tools and writes the Claude agent page block", async () => {
  const value = installHome();
  const path = join(value.home, "bin");
  mkdirSync(path);

  symlinkSync(process.execPath, join(path, "bun"));
  symlinkSync(Bun.which("git")!, join(path, "git"));
  writeFileSync(join(path, "gh"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  for (const tool of ["dirname", "readlink"]) symlinkSync(Bun.which(tool)!, join(path, tool));

  value.env.PATH = path;
  const result = await runCommand(["/bin/sh", join(repo, "install.sh")], {
    cwd: value.home,
    env: value.env,
  });

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(existsSync(join(value.claude, "hooks"))).toBe(false);
  expect(existsSync(value.conf)).toBe(false);

  const data = JSON.parse(readFileSync(join(value.codex, "hooks.json"), "utf8"));
  for (const { event, target } of hookTable)
    expect(data.hooks[event][0].hooks).toEqual([
      { type: "command", command: commandFor(target, value.agents) },
    ]);

  const page = readFileSync(join(repo, "docs/content/docs/agents/claude-code.mdx"), "utf8");
  const block = page.match(/```json\n([\s\S]*?)\n```/)![1]!;
  expect(JSON.parse(readFileSync(join(value.claude, "settings.json"), "utf8")).hooks).toEqual(
    JSON.parse(block).hooks,
  );

  expect(result.stdout).not.toContain("Paste the Claude Code hooks block");
});

test("first prs install writes documented Claude hooks before denying rules", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
  const path = join(value.claude, "settings.json");
  writeFileSync(path, "{}\n");

  const result = await install(value, [], value.root);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const page = readFileSync(join(repo, "docs/content/docs/agents/claude-code.mdx"), "utf8");
  const block = page.match(/```json\n([\s\S]*?)\n```/)![1]!;

  expect(result.code).toBe(0);
  expect(settings.hooks).toEqual(JSON.parse(block).hooks);
  expect(settings.permissions.deny).not.toContain("Bash(gh pr comment:*)");
  expect(result.stdout).not.toContain("Paste the Claude Code hooks block");
});

test("Claude replaces an owned session brief and preserves the personal hook bytes", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "session-brief.sh"), "owned session-brief.sh\n");
  const personal = { type: "command", command: "~/personal/session.sh", timeout: 12.5 };
  const settings = {
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "~/.claude/hooks/session-brief.sh" }, personal] },
      ],
    },
  };

  const text = JSON.stringify(settings, null, 2) + "\n";
  const personalBytes = JSON.stringify(personal, null, 2)
    .split("\n")
    .map((line, index) => `${index ? "          " : ""}${line}`)
    .join("\n");

  const path = join(value.claude, "settings.json");
  writeFileSync(path, text);

  const result = await install(value, [], value.root);
  const written = readFileSync(path, "utf8");

  expect(text).toContain(personalBytes);
  expect(result.code).toBe(0);
  expect(JSON.parse(written).hooks.SessionStart[0].hooks).toEqual([
    { type: "command", command: "~/.agents/skills/playbook/bin/skills hook session-start" },
    personal,
  ]);

  expect(written).toContain(personalBytes);
  expect(result.stdout).toContain("claude replace SessionStart");
  expect(result.stdout).not.toContain("stale  ");
});

test("Claude hook reruns leave settings bytes and metadata unchanged without hook lines", async () => {
  const value = await fixture();
  expect((await install(value, [], value.root)).code).toBe(0);
  const path = join(value.claude, "settings.json");
  const text = readFileSync(path, "utf8");
  const before = statSync(path);

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(statSync(path).ino).toBe(before.ino);
  expect(statSync(path).mtimeMs).toBe(before.mtimeMs);
  expect(result.stdout).not.toContain("claude ");
});

test("Claude skips a personal retired copy instead of duplicating its target", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "session-brief.sh"), "personal session brief\n");

  const rows = [{ hooks: [{ type: "command", command: "~/.claude/hooks/session-brief.sh" }] }];
  const path = join(value.claude, "settings.json");
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: rows } }));

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart).toEqual(rows);
  expect(result.stdout).toContain("skip   hook session-start Claude entry");
  expect(result.stdout).not.toContain("claude add SessionStart");
});

test("Claude recognises absolute CLI commands without adding duplicates", async () => {
  const value = await fixture();
  const settings = JSON.parse(claudeBlock(value.agents));
  const path = join(value.claude, "settings.json");
  const text = JSON.stringify(settings, null, 2) + "\n";
  writeFileSync(path, text);

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(result.stdout).not.toContain("claude ");
});

test.each([null, 9, { SessionStart: false }])(
  "Claude hook shape refusal %j prints a paste block but writes rules",
  async (hooks) => {
    const value = await fixture();
    mkdirSync(dirname(value.conf), { recursive: true });
    writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
    const path = join(value.claude, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks }));

    const result = await install(value, [], value.root);
    const settings = JSON.parse(readFileSync(path, "utf8"));

    expect(result.code).toBe(0);
    expect(settings.hooks).toEqual(hooks);
    expect(settings.permissions.deny).toContain("Bash(gh pr comment:*)");

    expect(result.stdout).toContain(`skip   ${path} (`);
    expect(result.stdout).toContain("Paste the Claude Code hooks block:");
    expect(result.stdout).toContain(claudeBlock("~/.agents/skills"));
  },
);

test("Claude pre-tool-use decline keeps the prs comment deny until its key is deleted", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\nCLAUDE_HOOK_PRE_TOOL_USE=off\n");
  const path = join(value.claude, "settings.json");

  expect((await install(value, [], value.root)).code).toBe(0);
  const settings = JSON.parse(readFileSync(path, "utf8"));
  expect(settings.hooks.PreToolUse).toBeUndefined();
  expect(settings.permissions.deny).toContain("Bash(gh pr comment:*)");
  expect(
    JSON.parse(readFileSync(join(value.codex, "hooks.json"), "utf8")).hooks.PreToolUse,
  ).toHaveLength(1);

  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
  expect((await install(value, [], value.root)).code).toBe(0);
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toHaveLength(1);
});

test("Claude noCli gate leaves hooks unwired and the comment deny in place", async () => {
  const value = await fixture();
  mkdirSync(join(value.agents, "playbook"), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");

  const result = await install(value, [], value.root);
  const settings = JSON.parse(readFileSync(join(value.claude, "settings.json"), "utf8"));

  expect(result.code).toBe(0);
  expect(settings.hooks).toBeUndefined();
  expect(settings.permissions.deny).toContain("Bash(gh pr comment:*)");
  expect(result.stdout).toContain(
    "skip   hook pre-tool-use Claude entry (the repo's hook pre-tool-use is not what runs, so none is added)",
  );
});

test("Claude write refusal prints rules using the guard before hook planning", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
  const path = join(value.claude, "settings.json");
  writeFileSync(path, "{}\n", { mode: 0o444 });

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("{}\n");
  expect(result.stdout).toContain(`skip   ${path} (is not writable)`);
  expect(result.stdout).toContain(claudeBlock("~/.agents/skills"));

  expect(result.stdout).toContain('"Bash(gh pr comment:*)"');
  expect(result.stdout).not.toContain("claude add");
});

test.each(["DELIVERY=prs\nAGENT_RULES=deny\n", "malformed\n"])(
  "Claude writes hooks when rules fall back with config %j",
  async (content) => {
    const value = await fixture();
    mkdirSync(dirname(value.conf), { recursive: true });
    writeFileSync(value.conf, content);
    const path = join(value.claude, "settings.json");
    writeFileSync(path, '{"permissions": false}\n');

    const result = await install(value, [], value.root);
    const settings = JSON.parse(readFileSync(path, "utf8"));

    expect(result.code).toBe(0);
    expect(settings.hooks).toEqual(JSON.parse(claudeBlock("~/.agents/skills")).hooks);
    expect(settings.permissions).toBe(false);
    expect(result.stdout).toContain("not written (");
    expect(result.stdout).not.toContain("Paste the Claude Code hooks block");
  },
);

test.each(["default", "custom relative", "custom absolute"])(
  "Claude replaces a missing retired copy with %s spelling",
  async (spelling) => {
    const value = await fixture();
    const claude = spelling === "default" ? value.claude : join(value.home, "custom-claude");
    mkdirSync(claude, { recursive: true });
    value.env.CLAUDE_HOME = claude;
    const command =
      spelling === "custom absolute"
        ? join(claude, "hooks/session-brief.sh")
        : `~/${spelling === "default" ? ".claude" : "custom-claude"}/hooks/session-brief.sh`;

    const path = join(value.claude, "settings.json");
    writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command }] }] } }));

    const result = await install(value, [], value.root);
    const settings = JSON.parse(readFileSync(path, "utf8"));

    expect(result.code).toBe(0);
    expect(settings.hooks.SessionStart).toEqual([
      { hooks: [{ command: "~/.agents/skills/playbook/bin/skills hook session-start" }] },
    ]);

    expect(result.stdout).toContain(`claude replace SessionStart ${command} with`);
    expect(result.stdout).not.toContain("stale  ");
    if (spelling !== "default") expect(existsSync(join(claude, "settings.json"))).toBe(false);
  },
);

test("Claude leaves the default retired spelling alone under a custom hooks home", async () => {
  const value = await fixture();
  const claude = join(value.home, "custom-claude");
  mkdirSync(claude);
  value.env.CLAUDE_HOME = claude;

  const old = { hooks: [{ command: "~/.claude/hooks/session-brief.sh" }] };
  const path = join(value.claude, "settings.json");
  writeFileSync(path, JSON.stringify({ hooks: { SessionStart: [old] } }));

  const result = await install(value, [], value.root);
  const rows = JSON.parse(readFileSync(path, "utf8")).hooks.SessionStart;

  expect(result.code).toBe(0);
  expect(rows[0]).toEqual(old);
  expect(rows).toHaveLength(1);
  expect(result.stdout).not.toContain("claude replace SessionStart");
  expect(result.stdout).toContain(
    `skip   hook session-start Claude entry (${path} already runs ~/.claude/hooks/session-brief.sh, which this repo did not install)`,
  );
});

test("Claude stale hook warnings skip declined targets", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nCLAUDE_HOOK_STOP=off\n");

  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "reply-guard.sh"), "owned reply-guard.sh\n");

  const path = join(value.claude, "settings.json");
  const old = { hooks: [{ command: "~/.claude/hooks/reply-guard.sh" }] };
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [old] } }));

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("stale  reply-guard.sh");
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.Stop).toEqual([old]);
});

test("Claude repairs unreachable matchers but leaves Stop and personal commands alone", async () => {
  const value = await fixture();
  const settings = JSON.parse(claudeBlock("~/.agents/skills"));

  settings.hooks.SessionStart[0].matcher = "startup";
  settings.hooks.PreToolUse[0].matcher = "NotBash";
  settings.hooks.PostToolUse[0].matcher = "Edit|Write";
  settings.hooks.Stop[0].matcher = "[";

  const personal = { type: "command", command: "~/personal.sh" };
  settings.hooks.PostToolUse[0].hooks.push(personal);
  const path = join(value.claude, "settings.json");
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  const result = await install(value, [], value.root);
  const hooks = JSON.parse(readFileSync(path, "utf8")).hooks;
  const documented = JSON.parse(claudeBlock("~/.agents/skills")).hooks;

  expect(result.code).toBe(0);
  expect(hooks.SessionStart).toEqual(documented.SessionStart);
  expect(hooks.PreToolUse).toEqual(documented.PreToolUse);
  expect(hooks.Stop).toEqual(settings.hooks.Stop);

  expect(hooks.PostToolUse).toEqual([
    { matcher: "Edit|Write", hooks: [personal] },
    ...documented.PostToolUse,
  ]);

  expect(result.stdout).toContain("claude drop SessionStart");
  expect(result.stdout).toContain("claude drop PreToolUse");
  expect(result.stdout).toContain("claude drop PostToolUse");
  expect(result.stdout).not.toContain("claude drop Stop");
});

test("Claude writes quoted commands for a custom agents directory", async () => {
  const value = await fixture();
  value.agents = join(value.home, "custom skills");
  value.env.AGENTS_DIR = value.agents;

  const first = await install(value, [], value.root);
  const path = join(value.claude, "settings.json");
  const text = readFileSync(path, "utf8");
  const second = await install(value, [], value.root);

  expect(first.code).toBe(0);
  expect(JSON.parse(text).hooks).toEqual(JSON.parse(claudeBlock(value.agents)).hooks);
  expect(text).toContain(commandFor("hook session-start", value.agents));

  expect(second.code).toBe(0);
  expect(readFileSync(path, "utf8")).toBe(text);
  expect(second.stdout).not.toContain("claude ");
});

test("Claude warns when written hooks are disabled and keeps the prs comment deny", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");
  const path = join(value.claude, "settings.json");
  writeFileSync(path, '{"disableAllHooks": true}\n');

  const result = await install(value, [], value.root);
  const settings = JSON.parse(readFileSync(path, "utf8"));

  expect(result.code).toBe(0);
  expect(settings.hooks).toEqual(JSON.parse(claudeBlock("~/.agents/skills")).hooks);
  expect(settings.permissions.deny).toContain("Bash(gh pr comment:*)");
  expect(result.stdout).toContain(
    "note   Claude hooks were written but do not run because settings disable user hooks",
  );
});

test.each([false, true])("Codex installs without Claude Code, custom home: %s", async (custom) => {
  const value = installHome();
  rmSync(value.claude, { recursive: true });
  const codex = custom ? join(value.home, "custom-codex") : value.codex;
  if (custom) {
    rmSync(value.codex, { recursive: true });
    mkdirSync(codex);
    value.env.CODEX_HOME = codex;
    value.env.SEED_DIRS = `${value.claude}/skills ${codex}/skills`;
  } else delete value.env.CODEX_HOME;

  const result = await install(value);
  expect(result.code).toBe(0);
  expect(existsSync(value.claude)).toBe(false);
  expect(result.stdout).toContain("agents and the Claude hooks block were skipped");
  const data = JSON.parse(readFileSync(join(codex, "hooks.json"), "utf8"));
  for (const [event, target, matcher] of [
    ["SessionStart", "hook session-start", "startup|resume|clear|compact"],
    ["PreToolUse", "hook pre-tool-use", "^Bash$"],
    ["PostToolUse", "hook post-tool-use", "^(Bash|apply_patch)$"],
    ["Stop", "hook stop", undefined],
  ] as const)
    expect(data.hooks[event]).toEqual([
      {
        ...(matcher === undefined ? {} : { matcher }),
        hooks: [{ type: "command", command: commandFor(target, value.agents) }],
      },
    ]);
});

const codexBinary = Bun.which("codex");
function execpolicy(rules: string, ...command: string[]): string {
  const result = Bun.spawnSync(
    [codexBinary!, "execpolicy", "check", "--rules", rules, "--", ...command],
    { stdout: "pipe", stderr: "pipe" },
  );

  return JSON.parse(result.stdout.toString()).decision ?? "none";
}

async function managedCodex(mode: "prs" | "hands-off", rules = "AGENT_RULES=deny\n") {
  const value = await fixture();
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, `DELIVERY=${mode}\n${rules}`);
  return { ...value, rules: join(value.codex, "rules/skills.rules") };
}

test("managed prs writes owned Codex rules, names skipped entries and reruns byte identical", async () => {
  const value = await managedCodex("prs");

  const first = await install(value, [], value.root);
  const text = readFileSync(value.rules, "utf8");
  const second = await install(value, [], value.root);

  expect(first.code).toBe(0);
  expect(first.stderr).toBe("");
  expect(text.split("\n")[0]).toBe(rulesHeader);
  expect(text).toContain(
    'prefix_rule(pattern = ["gh", ["pr", "stack"], "merge"], decision = "forbidden", justification = "Merge a PR")\n',
  );

  expect(text).not.toContain('"commit"');
  expect(text).not.toContain('["gh", "pr", "comment"]');
  expect(first.stdout).toContain("codex  merge add forbidden\n");
  expect(first.stdout).toContain(`codex  ${value.rules} (restart Codex to load the rules)\n`);
  expect(first.stdout).toContain(
    "skip   codex skills-git-config Bash(git config skills.*), Bash(git config * skills.*) (no Codex prefix rule can express these)\n",
  );

  expect(first.stdout).toContain("skip   codex claude-settings Edit({claude}/settings.json) (");
  expect(first.stdout.indexOf("codex  add PreToolUse")).toBeLessThan(
    first.stdout.indexOf("codex  merge add forbidden"),
  );

  expect(second.code).toBe(0);
  expect(readFileSync(value.rules, "utf8")).toBe(text);
  expect(second.stdout).toContain(`codex  ${value.rules} already holds every skills rule\n`);
  if (!codexBinary) return;

  expect(execpolicy(value.rules, "gh", "pr", "merge", "7")).toBe("forbidden");
  expect(execpolicy(value.rules, "git", "push", "origin", "feat/x")).toBe("none");
  expect(execpolicy(value.rules, "gh", "pr", "comment", "7")).toBe("none");
});

test("ask level and an off group shape the Codex rules", async () => {
  const value = await managedCodex("hands-off", "AGENT_RULES=ask\nAGENT_RULES_MERGE=off\n");

  const result = await install(value, [], value.root);
  const text = readFileSync(value.rules, "utf8");

  expect(result.code).toBe(0);
  expect(text).not.toContain("# merge:");
  expect(text).not.toContain('"forbidden"');
  expect(text).toContain(
    'prefix_rule(pattern = ["git", ["commit", "push"]], decision = "prompt", justification = "Commit, push or open a PR")\n',
  );

  if (codexBinary)
    expect(execpolicy(value.rules, "git", "push", "origin", "feat/x")).toBe("prompt");
});

test("a skills.rules without the skills header stays byte identical", async () => {
  const value = await managedCodex("prs");
  mkdirSync(dirname(value.rules));
  const mine = '# mine\nprefix_rule(pattern = ["rm"], decision = "forbidden")\n';
  writeFileSync(value.rules, mine);

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(readFileSync(value.rules, "utf8")).toBe(mine);
  expect(result.stdout).toContain(
    `skip   ${value.rules} (its first line is not "${rulesHeader}", so skills does not own it)\n`,
  );
});

test("unset AGENT_RULES writes no Codex rules", async () => {
  const value = await managedCodex("prs", "");

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(existsSync(dirname(value.rules))).toBe(false);
  expect(result.stdout).not.toContain("skip   codex ");
});

test("agent runs add Codex publishing rules and hold their removal", async () => {
  const value = await managedCodex("prs");
  await install(value, [], value.root);

  const handsOff = await install(value, ["--without", "prs"], value.root);
  const strengthened = readFileSync(value.rules, "utf8");
  const prs = await install(value, ["--with", "prs"], value.root);

  expect(handsOff.stdout).toContain("codex  publishing add forbidden\n");
  expect(handsOff.stdout).not.toContain("left   codex");
  expect(strengthened).toContain('["git", ["commit", "push"]], decision = "forbidden"');
  expect(prs.stdout).toContain(
    "left   codex publishing remove forbidden (weakening, stdin is not a terminal and stdout is not a terminal; rerun ./install.sh in a terminal to apply it)\n",
  );

  expect(readFileSync(value.rules, "utf8")).toBe(strengthened);

  if (codexBinary)
    expect(execpolicy(value.rules, "git", "push", "origin", "feat/x")).toBe("forbidden");
});

test("hand edits: an added owned prefix is held, a stray line is replaced", async () => {
  const value = await managedCodex("prs");
  await install(value, [], value.root);
  const owned = readFileSync(value.rules, "utf8");
  const added =
    'prefix_rule(pattern = ["gh", "pr", "lock"], decision = "forbidden", justification = "x")';

  const edited = owned.replace(
    'justification = "Merge a PR")\n',
    `justification = "Merge a PR")\n${added}\n`,
  );

  writeFileSync(value.rules, edited);
  const held = await install(value, [], value.root);
  const afterHeld = readFileSync(value.rules, "utf8");
  writeFileSync(value.rules, owned.replace("\n\n", "\nlocal = 1\n\n"));
  const replaced = await install(value, [], value.root);

  expect(held.stdout).toContain("left   codex merge rewrite forbidden (weakening, ");
  expect(held.stdout).not.toContain("restart Codex");
  expect(readFileSync(value.rules, "utf8")).toBe(owned);
  expect(replaced.stdout).toContain("codex  hand edits remove\n");
  expect(afterHeld).toBe(edited);
});

test("a repeated owned block is held as weakening, not dropped", async () => {
  const value = await managedCodex("prs");
  await install(value, [], value.root);
  const owned = readFileSync(value.rules, "utf8");
  const repeated = `${owned}\n# merge: Merge a PR\nprefix_rule(pattern = ["gh", "repo", "delete"], decision = "forbidden", justification = "x")\n`;
  writeFileSync(value.rules, repeated);

  const result = await install(value, [], value.root);

  expect(result.stdout).toContain("left   codex merge rewrite forbidden (weakening, ");
  expect(readFileSync(value.rules, "utf8")).toContain('["gh", "repo", "delete"]');
});

test("an off group whose rules block the mode is named", async () => {
  const value = await managedCodex("hands-off");
  await install(value, [], value.root);
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=off\n");

  const result = await install(value, [], value.root);

  expect(result.stdout).toContain(
    `note   codex publishing is off, and its forbidden rules in ${value.rules} block what prs mode needs\n`,
  );

  expect(readFileSync(value.rules, "utf8")).toContain('["git", ["commit", "push"]]');
});

test("AGENT_RULES=off keeps hand edits, even when an override rewrites a group", async () => {
  const value = await managedCodex("prs");
  await install(value, [], value.root);
  const edited = readFileSync(value.rules, "utf8").replace("\n\n", "\n# my note\n\n");
  writeFileSync(value.rules, edited);
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=off\n");

  const off = await install(value, [], value.root);
  const afterOff = readFileSync(value.rules, "utf8");
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=off\nAGENT_RULES_PUBLISHING=deny\n");
  const override = await install(value, [], value.root);

  expect(off.stdout).not.toContain("hand edits");
  expect(afterOff).toBe(edited);
  expect(override.stdout).not.toContain("hand edits");
  expect(readFileSync(value.rules, "utf8")).toContain("# my note\n");
});

test("a CODEX_HOME without search permission skips the rules with a reason", async () => {
  const value = await managedCodex("prs");
  await install(value, [], value.root);
  chmodSync(value.codex, 0o600);
  value.env.SEED_DIRS = join(value.claude, "skills");

  const result = await install(value, [], value.root);
  chmodSync(value.codex, 0o700);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(result.stdout).toContain(`skip   ${value.rules} (cannot read its directory: `);
});

test("a codex whose execpolicy check hangs is cut off and writes nothing", async () => {
  const value = await managedCodex("prs");
  const bin = join(value.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 });
  value.env.PATH = `${bin}:${value.env.PATH}`;

  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(existsSync(value.rules)).toBe(false);
  expect(result.stdout).toContain(
    `skip   ${value.rules} (codex execpolicy check failed: did not finish within 10 s, so the old file is kept)\n`,
  );
}, 30_000);

test("a codex whose execpolicy check disagrees keeps the old file", async () => {
  const value = await managedCodex("prs");
  const bin = join(value.home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\necho '{\"matchedRules\":[]}'\n", { mode: 0o755 });
  value.env.PATH = `${bin}:${value.env.PATH}`;

  const result = await install(value, [], value.root);

  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  expect(existsSync(value.rules)).toBe(false);
  expect(result.stdout).toContain(
    `skip   ${value.rules} (codex execpolicy check found no forbidden match for gh pr merge, so the old file is kept)\n`,
  );
});

test.each([false, true])("skills.conf rewrites atomically, symlink: %s", async (linked) => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));

  const target = linked ? join(value.home, "delivery.conf") : value.conf;
  writeFileSync(target, "DELIVERY=prs\nWITH=\n", { mode: 0o640 });
  if (linked) symlinkSync(target, value.conf);

  const before = statSync(target);

  const result = await install(value, ["--without", "prs"], value.root);
  expect(result.code).toBe(0);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=hands-off\nWITH=\n");

  expect(statSync(target).ino).not.toBe(before.ino);
  expect(statSync(target).mode & 0o7777).toBe(0o640);
  if (linked) expect(readlinkSync(value.conf)).toBe(target);
});

test("skills.conf with a hard link refuses before any write", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=\n");
  linkSync(value.conf, join(value.home, "other.conf"));

  const result = await install(value, ["--without", "prs"], value.root);
  expect(result.code).toBe(1);
  expect(result.stderr).toContain(`${value.conf} has hard links a rewrite would split`);
  expect(readFileSync(join(value.home, "other.conf"), "utf8")).toBe("DELIVERY=prs\nWITH=\n");
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\n");
});

test("skills.conf in a read only directory refuses before any write", async () => {
  const value = await fixture();
  const directory = join(value.home, "locked");
  const conf = join(directory, "skills.conf");

  mkdirSync(directory);
  writeFileSync(conf, "DELIVERY=prs\nWITH=\n");
  chmodSync(directory, 0o555);
  value.env.SKILLS_CONF = conf;

  try {
    const result = await install(value, ["--without", "prs"], value.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`${directory} is not writable`);
    expect(readFileSync(conf, "utf8")).toBe("DELIVERY=prs\nWITH=\n");
  } finally {
    chmodSync(directory, 0o755);
  }
});

test("owned agents update and prune, mode kept, read only owned agent updates", async () => {
  const value = await fixture();
  const dest = join(value.claude, "agents/opus-review.md");
  const retired = join(value.claude, "agents/codex-sol.md");
  mkdirSync(dirname(dest));
  writeFileSync(retired, "retired codex sol\n");

  for (const mode of [0o600, 0o444]) {
    writeFileSync(dest, "older opus review\n");
    chmodSync(dest, mode);
    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe("current opus review\n");
    expect(statSync(dest).mode & 0o777).toBe(mode);
    expect(existsSync(retired)).toBe(false);
    chmodSync(dest, 0o600);
  }
});

test("owned agent through symlink, dangling agent symlink, clean agents rerun", async () => {
  const value = await fixture();
  const dest = join(value.claude, "agents/opus-review.md");
  const target = join(value.home, "opus-target.md");

  mkdirSync(dirname(dest));
  writeFileSync(target, "older opus review\n");
  symlinkSync("../../opus-target.md", dest);

  expect((await install(value, [], value.root)).code).toBe(0);
  expect(readlinkSync(dest)).toBe("../../opus-target.md");
  expect(readFileSync(target, "utf8")).toBe("current opus review\n");

  rmSync(dest);
  symlinkSync(join(value.home, "missing/opus-review.md"), dest);

  const dangling = await install(value, [], value.root);
  expect(dangling.stdout).toContain("could not be written");
  expect(readlinkSync(dest)).toBe(join(value.home, "missing/opus-review.md"));

  rmSync(dest);
  await install(value, [], value.root);

  const before = statSync(dest);
  await install(value, [], value.root);
  expect(statSync(dest).ino).toBe(before.ino);
  expect(statSync(dest).mtimeMs).toBe(before.mtimeMs);
});

test("old Codex hooks file now prunes unused shipped copies after rewiring", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);

  for (const name of [
    "session-brief.sh",
    "commit-guard.sh",
    "reply-guard.sh",
    "no-comments.sh",
    "no-em-dash.sh",
    "comment_scan.py",
    "reply_guard.py",
  ])
    writeFileSync(join(copies, name), `owned ${name}\n`);

  const data = {
    description: `Installed by ryuudotgg/skills install.sh. Scripts live in ${copies}.`,
    hooks: {
      SessionStart: [
        {
          matcher: "owned custom matcher",
          groupKey: "kept",
          hooks: [
            {
              type: "command",
              command: join(copies, "session-brief.sh"),
              timeout: 17,
              entryKey: "kept",
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "^Bash$",
          groupKey: "kept",
          hooks: [
            {
              type: "command",
              command: join(copies, "commit-guard.sh"),
              timeout: 17,
              entryKey: "kept",
            },
          ],
        },
      ],
      PostToolUse: [
        {
          matcher: "^(Edit|MultiEdit|Write)$",
          hooks: [
            { type: "command", command: join(copies, "no-em-dash.sh") },
            { type: "command", command: join(copies, "no-comments.sh") },
          ],
        },
      ],
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: join(copies, "reply-guard.sh"),
              timeout: 17,
              entryKey: "kept",
            },
          ],
        },
      ],
    },
  };

  writeFileSync(join(value.codex, "hooks.json"), JSON.stringify(data));
  const result = await install(value, [], value.root);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `codex  replace Stop ${copies}/reply-guard.sh with ${value.agents}/playbook/bin/skills hook stop\n`,
  );

  expect(result.stdout).toContain("prune  comment_scan.py\n");
  expect(existsSync(copies)).toBe(true);
  expect(existsSync(join(copies, "session-brief.sh"))).toBe(false);
  const after = JSON.parse(readFileSync(join(value.codex, "hooks.json"), "utf8"));
  expect(after.hooks.SessionStart[0]).toEqual({
    matcher: "startup|resume|clear|compact",
    hooks: [
      {
        type: "command",
        command: commandFor("hook session-start", value.agents),
      },
    ],
  });

  expect(after.hooks.PostToolUse).toEqual([
    {
      matcher: "^(Bash|apply_patch)$",
      hooks: [{ type: "command", command: commandFor("hook post-tool-use", value.agents) }],
    },
  ]);
});

test.each(["settings.json", "settings.local.json", "codex"])(
  "retired hook still wired in Claude settings: %s keeps every helper",
  async (location) => {
    const value = await fixture();
    const copies = join(value.claude, "hooks");
    mkdirSync(copies);

    writeFileSync(join(copies, "reply-guard.sh"), "owned reply-guard.sh\n");
    writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
    writeFileSync(join(copies, "commit-guard.sh"), "personal commit guard\n");
    const path =
      location === "codex" ? join(value.codex, "hooks.json") : join(value.claude, location);

    const command =
      location === "codex" ? join(copies, "commit-guard.sh") : "~/.claude/hooks/reply-guard.sh";

    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command }] }] } }));
    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
    expect(readFileSync(join(copies, "reply-guard.sh"), "utf8")).toBe("owned reply-guard.sh\n");
    expect(readFileSync(join(copies, "commit-guard.sh"), "utf8")).toBe("personal commit guard\n");

    if (location === "settings.json") {
      expect(result.stdout).toContain(
        `stale  reply-guard.sh still runs from ${path}. Replace it with its skills hook command:`,
      );

      expect(result.stdout).not.toContain("stale  commit-guard.sh");
    }
  },
);

test.each([
  ["a doubled slash after HOME", (home: string) => `${home}//.claude/hooks/reply-guard.sh`],
  ["a cd into the hooks directory", () => "cd ~/.claude/hooks && ./reply-guard.sh"],
  ["a bare copy name", () => "sh reply-guard.sh"],
])("a registration spelled with %s keeps every copy", async (_name, spell) => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "reply-guard.sh"), "owned reply-guard.sh\n");
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");

  const command = spell(value.home);
  writeFileSync(
    join(value.claude, "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } }),
  );

  value.env.HOME = `${value.home}/`;
  expect((await install(value, [], value.root)).code).toBe(0);
  expect(readFileSync(join(copies, "reply-guard.sh"), "utf8")).toBe("owned reply-guard.sh\n");
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test("a trailing slash on AGENTS_DIR keeps tool links owned on reruns", async () => {
  const value = await fixture();
  value.env.AGENTS_DIR = `${value.agents}/`;

  expect((await install(value, [], value.root)).code).toBe(0);
  const rerun = await install(value, [], value.root);

  expect(rerun.code).toBe(0);
  expect(rerun.stdout).not.toContain("is not a link to this repository's store");
  expect(rerun.stdout).toContain("skill  playbook");
});

test.each([
  ["settings.json", "registered"],
  ["settings.local.json", "registered"],
  ["settings.json", "invalid"],
])("a project %s that is %s keeps every copy", async (file, state) => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "reply-guard.sh"), "owned reply-guard.sh\n");
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");

  const project = join(value.home, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });
  writeFileSync(
    join(project, ".claude", file),
    state === "invalid"
      ? "{invalid"
      : JSON.stringify({
          hooks: { Stop: [{ hooks: [{ command: "~/.claude/hooks/reply-guard.sh" }] }] },
        }),
  );

  writeFileSync(join(value.home, ".claude.json"), JSON.stringify({ projects: { [project]: {} } }));
  expect((await install(value, [], value.root)).code).toBe(0);
  expect(readFileSync(join(copies, "reply-guard.sh"), "utf8")).toBe("owned reply-guard.sh\n");
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test("an unreadable ~/.claude.json keeps every copy", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
  writeFileSync(join(value.home, ".claude.json"), "{invalid");

  expect((await install(value, [], value.root)).code).toBe(0);
  expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
});

test.each(["settings.json", "settings.local.json", "codex"])(
  "unreadable or invalid %s forbids hook pruning",
  async (location) => {
    const value = await fixture();
    const copies = join(value.claude, "hooks");
    mkdirSync(copies);
    writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
    const path =
      location === "codex" ? join(value.codex, "hooks.json") : join(value.claude, location);

    writeFileSync(path, "{invalid");
    expect((await install(value, [], value.root)).code).toBe(0);
    expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
  },
);

test("unowned and symlink hook copies stay, managed rules keep personal bytes", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "comment_scan.py"), "personal helper\n");
  symlinkSync(join(value.home, "missing"), join(copies, "session-brief.sh"));

  const settings =
    JSON.stringify(
      {
        personal: "kept",
        permissions: { deny: ["Bash(personal *)"], ask: ["Bash(personal-ask *)"] },
      },
      null,
      2,
    ) + "\n";

  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, "AGENT_RULES=deny\n");
  writeFileSync(join(value.claude, "settings.json"), settings);
  const result = await install(value, [], value.root);

  expect(result.stdout).toContain(
    `skip   comment_scan.py (${copies}/comment_scan.py matches no version this repo committed, left in place)\n`,
  );

  expect(result.stdout).toContain(
    `skip   session-brief.sh (${copies}/session-brief.sh is a link, left in place)\n`,
  );

  expect(result.code).toBe(0);
  expect(
    withoutOwned(readFileSync(join(value.claude, "settings.json"), "utf8"), tableEntries(value)),
  ).toBe(settings);
});

test("hand edited CRLF config, reviewer setting survives rewrite, stale name removal", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(
    value.conf,
    "# my comment\r\nDELIVERY=prs\r\nWITH=fixture-ext\r\nGREPTILE_REREVIEWS=3\r\n",
  );

  expect((await install(value, ["--without", "fixture-ext"], value.root)).code).toBe(0);
  expect(readFileSync(value.conf, "utf8")).toBe(
    "# my comment\nDELIVERY=prs\nWITH=\nGREPTILE_REREVIEWS=3\n",
  );

  writeFileSync(value.conf, "DELIVERY=prs\nWITH=malformed\n");
  expect((await install(value, ["--without", "malformed"], value.root)).code).toBe(0);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\n");
});

test.each([
  [
    ["--with"],
    2,
    "usage: install.sh [--with <name>]... [--without <name>]... [--arms <value>] [--verbose]\n",
  ],
  [["--with=nosuch"], 1, "install.sh: no optional skill named nosuch\n"],
  [["--with", "prs", "--without", "prs"], 1, "install.sh: prs is in both --with and --without\n"],
  [
    ["--with", "fixture-ext", "--without", "prs"],
    1,
    "install.sh: fixture-ext requires prs mode, so hands-off needs --without fixture-ext too\n",
  ],
] as const)("flag errors stay byte stable: %j", async (args, code, stderr) => {
  const value = await fixture();
  const result = await install(value, [...args], value.root);

  expect(result.code).toBe(code);
  expect(result.stderr).toBe(stderr);
  expect(result.stdout).toBe("");
  expect(existsSync(value.agents)).toBe(false);
  expect(existsSync(value.conf)).toBe(false);
});

function opencodeCatalog(value: ReturnType<typeof installHome>) {
  const bin = join(value.home, "bin");
  mkdirSync(bin);
  const path = join(bin, "opencode");
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
models) printf 'vendor/main\\nvendor/plain\\n' ;;
'api model.list') printf '%s\\n' '{"data":[{"providerID":"vendor","id":"main","variants":[{"id":"high"}]},{"providerID":"vendor","id":"plain","variants":[]}]}' ;;
*) exit 1 ;;
esac
`,
  );

  chmodSync(path, 0o755);
  value.env.PATH = `${bin}:${value.env.PATH}`;
}

test("non-terminal install preserves the saved roster without reading a catalog", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));
  const saved =
    "# keep\nDELIVERY=hands-off\nWITH=\nARMS_ROSTER=claude opencode sol=vendor/old#high\n";

  writeFileSync(value.conf, saved);

  const result = await install(value, [], value.root);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("Arms for delegated work");
  expect(readFileSync(value.conf, "utf8")).toBe(saved);
});

test.each(["--arms", "--arms="])("%s replaces the roster without a prompt", async (flag) => {
  const value = await fixture();
  opencodeCatalog(value);
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "# keep\nARMS_ROSTER=codex\nARMS_ROSTER=claude\n");

  const roster = "opencode claude sol=vendor/main#high luna=vendor/plain";
  const args = flag === "--arms" ? [flag, roster] : [`${flag}${roster}`];
  const result = await install(value, args, value.root);

  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("Arms for delegated work");
  expect(readFileSync(value.conf, "utf8")).toContain("# keep\n");
  expect(readFileSync(value.conf, "utf8").match(/^ARMS_ROSTER=.*$/gm)).toEqual([
    "ARMS_ROSTER=claude opencode luna=vendor/plain sol=vendor/main#high",
  ]);
});

test("an explicit default roster leaves an absent roster key absent", async () => {
  const value = await fixture();
  const result = await install(value, ["--arms", "codex claude"], value.root);
  expect(result.code).toBe(0);
  expect(existsSync(value.conf)).toBe(false);
});

test.each([false, true])(
  "unknown OpenCode model writes nothing with saved conf %j",
  async (saved) => {
    const value = await fixture();
    opencodeCatalog(value);
    const content = "# keep\nDELIVERY=prs\nWITH=fixture-ext\nARMS_ROSTER=codex\n";
    if (saved) {
      mkdirSync(dirname(value.conf));
      writeFileSync(value.conf, content);
    }

    const result = await install(value, ["--arms", "opencode sol=vendor/missing#high"], value.root);
    expect(result.code).toBe(1);
    expect(result.stderr).toBe(
      "install.sh: OpenCode sol model vendor/missing is not in the catalog\n",
    );

    expect(result.stdout).toBe("");
    expect(existsSync(value.agents)).toBe(false);
    expect(existsSync(value.conf)).toBe(saved);

    if (saved) expect(readFileSync(value.conf, "utf8")).toBe(content);
  },
);

test.each([
  "unknown",
  "claude sol=vendor/main",
  "opencode astra=vendor/main",
  "opencode sol=vendor/main#missing",
])("invalid roster %s fails before creating the store or config", async (roster) => {
  const value = await fixture();
  opencodeCatalog(value);
  const result = await install(value, ["--arms", roster], value.root);

  expect(result.code).toBe(1);
  expect(result.stderr).toStartWith("install.sh: ");
  expect(existsSync(value.agents)).toBe(false);
  expect(existsSync(value.conf)).toBe(false);
});

test("flag roster errors fail without claiming anything was skipped", async () => {
  const value = await fixture();
  const result = await install(value, ["--arms", "opencode"], value.root);

  expect(result.code).toBe(1);
  expect(result.stderr).toBe(
    "install.sh: --arms opencode requires a sol model; no arm families selected\n",
  );

  expect(existsSync(value.agents)).toBe(false);
  expect(existsSync(value.conf)).toBe(false);
});

test("OpenCode flag requires its executable before creating anything", async () => {
  const value = await fixture();
  const result = await install(value, ["--arms", "opencode sol=vendor/main"], value.root);

  expect(result.code).toBe(1);
  expect(result.stderr).toBe("install.sh: opencode is not on PATH\n");
  expect(existsSync(value.agents)).toBe(false);
  expect(existsSync(value.conf)).toBe(false);
});

test.each([
  { args: ["--arms"] },
  { args: ["--arms="] },
  { args: ["--arms", " "] },
  { args: ["--arms", "--with", "prs"] },
  { args: ["--arms", "claude", "--arms=codex"] },
])("empty or repeated arms flags are usage errors: %j", async ({ args }) => {
  const value = await fixture();
  const result = await install(value, [...args], value.root);

  expect(result.code).toBe(2);
  expect(result.stderr).toContain("usage: install.sh");
  expect(existsSync(value.agents)).toBe(false);
  expect(existsSync(value.conf)).toBe(false);
});

test("store that cannot be created leaves config untouched", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=\n");
  writeFileSync(value.agents, "not a directory\n");
  const result = await install(value, ["--without", "prs"], value.root);

  expect(result.code).toBe(1);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\n");
});

test("malformed config does not hide invalid names or contradictory flags", async () => {
  const value = await fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=invalid\n");
  const badName = await install(value, ["--with", "NOT-valid"], value.root);
  const contradictory = await install(value, ["--with", "prs", "--without", "prs"], value.root);

  expect(badName.stderr).toBe("install.sh: no optional skill named NOT-valid\n");
  expect(contradictory.stderr).toBe("install.sh: prs is in both --with and --without\n");
  expect(existsSync(value.agents)).toBe(false);
});

test.each(['{"hooks":{},"hooks":{}}', '{"number":01}', Buffer.from([0xff])])(
  "unparseable registration %j prevents every hook prune",
  async (content) => {
    const value = await fixture();
    const copies = join(value.claude, "hooks");
    mkdirSync(copies);

    writeFileSync(join(copies, "comment_scan.py"), "owned comment_scan.py\n");
    writeFileSync(join(value.claude, "settings.local.json"), content);

    const result = await install(value, [], value.root);

    expect(result.code).toBe(0);
    expect(readFileSync(join(copies, "comment_scan.py"), "utf8")).toBe("owned comment_scan.py\n");
  },
);

test("noninteractive source clone without node_modules installs without fetching dependencies", async () => {
  const value = installHome();
  const clone = join(value.home, "clone");
  mkdirSync(clone);
  cpSync(join(repo, "src"), join(clone, "src"), { recursive: true });
  cpSync(join(repo, "package.json"), join(clone, "package.json"));
  const result = await runCommand(
    [
      process.execPath,
      "--no-env-file",
      join(clone, "src/cli.ts"),
      "--root",
      join(repo, "skills"),
      "install",
    ],
    { cwd: clone, env: value.env },
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(existsSync(join(clone, "node_modules"))).toBe(false);
  expect(existsSync(join(value.codex, "hooks.json"))).toBe(true);
});

test("bootstrap missing Bun diagnostic and home fallback", async () => {
  const value = installHome();
  const path = join(value.home, "bin");
  mkdirSync(path);
  symlinkSync(Bun.which("dirname")!, join(path, "dirname"));
  value.env.PATH = path;
  const missing = await runCommand(["/bin/sh", join(repo, "install.sh")], {
    cwd: repo,
    env: value.env,
  });

  expect(missing.code).toBe(1);
  expect(missing.stdout).toBe("");
  expect(missing.stderr).toBe(
    "install.sh: Bun 1.4.0 or newer is required: curl -fsSL https://bun.sh/install | bash\n",
  );

  mkdirSync(join(value.home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(value.home, ".bun/bin/bun"));
  symlinkSync(Bun.which("readlink")!, join(path, "readlink"));
  const fallback = await runCommand(["/bin/sh", join(repo, "install.sh")], {
    cwd: repo,
    env: value.env,
  });

  expect(fallback.code).toBe(0);
  expect(fallback.stderr).toBe("");
  expect(fallback.stdout).toContain("mode   hands-off\n");
});

test("checkout markers recognise both current and older skill links", async () => {
  const value = await fixture();
  const older = await createRepo();
  directories.push(older);

  await writeFixture(older, "install.sh", "#!/bin/sh\n");
  await writeFixture(older, "skills/playbook/scripts/delivery-mode.sh", "#!/bin/sh\n");
  await writeFixture(older, "skills/playbook/SKILL.md", "---\n---\n");

  mkdirSync(value.agents, { recursive: true });
  symlinkSync(join(older, "skills/playbook"), join(value.agents, "playbook"));

  expect((await install(value, [], value.root)).code).toBe(0);
  expect(readlinkSync(join(value.agents, "playbook"))).toBe(join(resolve(value.root), "playbook"));
  expect(await fixtureGit(dirname(value.root), ["status", "--porcelain"])).toBe("");
});
