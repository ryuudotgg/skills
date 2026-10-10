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
import { commitFixture, createRepo, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { commandFor, hookTable } from "./hook-table.ts";

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

  mkdirSync(claude);
  mkdirSync(codex);
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    HOME: home,
    AGENTS_DIR: agents,
    CLAUDE_HOME: claude,
    CODEX_HOME: codex,
    SKILLS_CONF: conf,
    SEED_DIRS: `${claude}/skills ${codex}/skills`,
    EXTRA_DIRS: "",
  };

  delete env.CLAUDE_CONFIG_DIR;

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
  }
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

test("array requires is never linked", async () => {
  const value = await fixture();
  const result = await install(value, ["--with", "prs"], value.root);

  expect(result.code).toBe(0);

  for (const directory of [value.agents, join(value.claude, "skills"), join(value.codex, "skills")])
    expect(existsSync(join(directory, "fixture-array"))).toBe(false);

  expect(result.stdout).toContain("off    fixture-array");
});

test("fresh HOME needs only bun, git and gh runtime tools and prints the Claude agent page block", async () => {
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
  expect(result.stdout).toContain(`\n${block}\n`);
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

test("unowned and symlink hook copies stay, no Claude settings are edited", async () => {
  const value = await fixture();
  const copies = join(value.claude, "hooks");
  mkdirSync(copies);
  writeFileSync(join(copies, "comment_scan.py"), "personal helper\n");
  symlinkSync(join(value.home, "missing"), join(copies, "session-brief.sh"));

  const settings = '{"permissions":{"deny":[]}}\n';
  writeFileSync(join(value.claude, "settings.json"), settings);
  const result = await install(value, [], value.root);

  expect(result.stdout).toContain(
    `skip   comment_scan.py (${copies}/comment_scan.py matches no version this repo committed, left in place)\n`,
  );

  expect(result.stdout).toContain(
    `skip   session-brief.sh (${copies}/session-brief.sh is a link, left in place)\n`,
  );

  expect(readFileSync(join(value.claude, "settings.json"), "utf8")).toBe(settings);
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
  [["--with"], 2, "usage: install.sh [--with <name>]... [--without <name>]...\n"],
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
