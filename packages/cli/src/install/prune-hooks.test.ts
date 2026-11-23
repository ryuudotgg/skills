import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshot } from "./files.ts";
import { pruneHooks } from "./prune-hooks.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const shipped = new Map(
  [
    "session-brief.sh",
    "commit-guard.sh",
    "reply-guard.sh",
    "no-comments.sh",
    "no-em-dash.sh",
    "comment_scan.py",
    "reply_guard.py",
  ].map((name) => [`hooks/${name}`, `owned ${name}\n`]),
);

const versions = {
  unmatched: "matches no version this repo committed",
  shipped: async (path: string, file: string) => {
    const judged = snapshot(file);
    return judged?.bytes?.toString() === shipped.get(path) ? judged : undefined;
  },
  deleted: async () => [...shipped.keys()].sort(),
};

function homes() {
  const home = mkdtempSync(join(tmpdir(), "skills-prune-hooks-"));
  directories.push(home);

  const claude = join(home, ".claude");
  const codex = join(home, ".codex");
  const copies = join(claude, "hooks");
  mkdirSync(copies, { recursive: true });
  mkdirSync(codex);

  const env = { claude, claudeConfig: claude, claudeState: join(home, ".claude.json"), codex };
  return { home, repo: join(home, "repo"), copies, env };
}

type Homes = ReturnType<typeof homes>;

function copy(value: Homes, name: string, text = `owned ${name}\n`) {
  writeFileSync(join(value.copies, name), text);
}

function register(path: string, command: string) {
  writeFileSync(path, JSON.stringify({ hooks: { Stop: [{ hooks: [{ command }] }] } }));
}

async function prune(value: Homes) {
  const lines: string[] = [];
  await pruneHooks(value.repo, value.env, versions, (line) => lines.push(line));
  return lines;
}

function expectKept(value: Homes, names: readonly string[]) {
  for (const name of names)
    expect(readFileSync(join(value.copies, name), "utf8")).toBe(`owned ${name}\n`);
}

test.each(["settings.json", "settings.local.json", "codex"])(
  "a retired hook wired in %s keeps every copy",
  async (location) => {
    const value = homes();
    copy(value, "reply-guard.sh");
    copy(value, "comment_scan.py");
    copy(value, "commit-guard.sh", "personal commit guard\n");

    const path =
      location === "codex" ? join(value.env.codex, "hooks.json") : join(value.env.claude, location);

    const command =
      location === "codex"
        ? join(value.copies, "commit-guard.sh")
        : "~/.claude/hooks/reply-guard.sh";

    writeFileSync(path, JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ command }] }] } }));

    expect(await prune(value)).toEqual([]);
    expectKept(value, ["reply-guard.sh", "comment_scan.py"]);
    expect(readFileSync(join(value.copies, "commit-guard.sh"), "utf8")).toBe(
      "personal commit guard\n",
    );
  },
);

test.each([
  ["a doubled slash after HOME", (home: string) => `${home}//.claude/hooks/gone.sh`],
  ["a doubled slash inside the hooks path", (home: string) => `${home}/.claude//hooks/gone.sh`],
  ["a cd into the hooks directory", () => "cd ~/.claude/hooks && ./gone.sh"],
  ["a bare copy name", () => "sh reply-guard.sh"],
])("a registration spelled with %s keeps every copy", async (_name, spell) => {
  const value = homes();
  copy(value, "reply-guard.sh");
  copy(value, "comment_scan.py");
  register(join(value.env.claude, "settings.json"), spell(value.home));

  expect(await prune(value)).toEqual([]);
  expectKept(value, ["reply-guard.sh", "comment_scan.py"]);
});

test.each([
  ["settings.json", "registered"],
  ["settings.local.json", "registered"],
  ["settings.json", "invalid"],
])("a project %s that is %s keeps every copy", async (file, state) => {
  const value = homes();
  copy(value, "reply-guard.sh");
  copy(value, "comment_scan.py");

  const project = join(value.home, "project");
  mkdirSync(join(project, ".claude"), { recursive: true });

  if (state === "invalid") writeFileSync(join(project, ".claude", file), "{invalid");
  else register(join(project, ".claude", file), "~/.claude/hooks/reply-guard.sh");

  writeFileSync(value.env.claudeState, JSON.stringify({ projects: { [project]: {} } }));

  expect(await prune(value)).toEqual([]);
  expectKept(value, ["reply-guard.sh", "comment_scan.py"]);
});

test("a registration naming a never shipped copy keeps every copy", async () => {
  const value = homes();
  copy(value, "notes.txt", "my notes\n");
  copy(value, "comment_scan.py");
  register(join(value.env.claude, "settings.json"), "sh notes.txt");

  expect(await prune(value)).toEqual([]);
  expectKept(value, ["comment_scan.py"]);
});

test("an unreadable state file keeps every copy", async () => {
  const value = homes();
  copy(value, "comment_scan.py");
  writeFileSync(value.env.claudeState, "{invalid");

  expect(await prune(value)).toEqual([]);
  expectKept(value, ["comment_scan.py"]);
});

test.each(["settings.json", "settings.local.json", "codex"])(
  "unreadable or invalid %s forbids hook pruning",
  async (location) => {
    const value = homes();
    copy(value, "comment_scan.py");

    const path =
      location === "codex" ? join(value.env.codex, "hooks.json") : join(value.env.claude, location);

    writeFileSync(path, "{invalid");

    expect(await prune(value)).toEqual([]);
    expectKept(value, ["comment_scan.py"]);
  },
);

test.each(['{"hooks":{},"hooks":{}}', '{"number":01}', Buffer.from([0xff])])(
  "unparseable registration %j prevents every hook prune",
  async (content) => {
    const value = homes();
    copy(value, "comment_scan.py");
    writeFileSync(join(value.env.claude, "settings.local.json"), content);

    expect(await prune(value)).toEqual([]);
    expectKept(value, ["comment_scan.py"]);
  },
);

test("an unregistered directory prunes only shipped copies", async () => {
  const value = homes();
  copy(value, "no-em-dash.sh");
  copy(value, "comment_scan.py", "personal helper\n");
  symlinkSync(join(value.home, "missing"), join(value.copies, "session-brief.sh"));

  copy(value, "notes.txt", "my notes\n");
  symlinkSync(join(value.home, "missing"), join(value.copies, "own.sh"));
  mkdirSync(join(value.copies, "mine"));

  expect(await prune(value)).toEqual([
    `skip   comment_scan.py (${value.copies}/comment_scan.py matches no version this repo committed, left in place)`,
    "prune  no-em-dash.sh",
    `skip   session-brief.sh (${value.copies}/session-brief.sh is a link, left in place)`,
  ]);

  expect(existsSync(join(value.copies, "no-em-dash.sh"))).toBe(false);
  expect(readFileSync(join(value.copies, "comment_scan.py"), "utf8")).toBe("personal helper\n");

  for (const name of ["session-brief.sh", "notes.txt", "own.sh", "mine"])
    expect(lstatSync(join(value.copies, name), { throwIfNoEntry: false })).toBeDefined();
});
