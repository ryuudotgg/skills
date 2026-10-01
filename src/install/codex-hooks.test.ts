import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addEntries,
  missingEntries,
  ownedEntries,
  skipHooks,
  writeCodexHooks,
  type HookOptions,
} from "./codex-hooks.ts";
import { commandFor, hookTable } from "./hook-table.ts";
import { JsonNumber, parseJson, stringifyJson, type JsonObject } from "./json.ts";

const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-hooks-"));
  directories.push(directory);

  const path = join(directory, "hooks.json");
  const hooks = join(directory, "copies");
  const agents = join(directory, "skills");
  const write = (options?: HookOptions) => writeCodexHooks(path, hooks, agents, options);
  return { directory, path, hooks, agents, write };
}

afterEach(() => {
  for (const path of directories.splice(0)) {
    chmodSync(path, 0o700);
    rmSync(path, { recursive: true, force: true });
  }
});

test("owned retired duplicates stay scoped to their event", () => {
  const value = fixture();
  const old = join(value.hooks, "session-brief.sh");
  const entry = { type: "command", command: old };
  const seed = {
    hooks: {
      SessionStart: [
        {
          matcher: "custom",
          groupKey: "kept",
          hooks: [{ ...entry, timeout: 17 }, { ...entry }, { type: "command", command: "/mine" }],
        },
        { matcher: "empty", hooks: [{ ...entry }] },
      ],
      Stop: [{ hooks: [{ ...entry }] }],
    },
  };

  writeFileSync(value.path, JSON.stringify(seed));
  const output = value.write();
  const result = JSON.parse(readFileSync(value.path, "utf8"));

  expect(result.hooks.SessionStart).toEqual([
    {
      matcher: "custom",
      groupKey: "kept",
      hooks: [
        { type: "command", command: commandFor("hook session-start", value.agents), timeout: 17 },
        { type: "command", command: "/mine" },
      ],
    },
  ]);

  expect(result.hooks.Stop[0]).toEqual(seed.hooks.Stop[0]);
  expect(output.split(`codex  replace SessionStart ${old} with `)).toHaveLength(2);
  expect(output.split(`codex  drop SessionStart ${old}`)).toHaveLength(3);

  for (const order of [
    ["no-comments.sh", "no-em-dash.sh"],
    ["no-em-dash.sh", "no-comments.sh"],
  ]) {
    const commands = order.map((name) => join(value.hooks, name));
    const seed: JsonObject = { hooks: {} };
    addEntries(seed, missingEntries(seed, value.agents));
    const post: JsonObject[] = [
      {
        matcher: "custom",
        groupKey: "kept",
        hooks: [
          { type: "command", command: commands[0]!, timeout: new JsonNumber("17") },
          { type: "command", command: commands[1]! },
        ],
      },
      { matcher: "empty", hooks: [{ type: "command", command: commands[0]! }] },
    ];

    const hooks = seed.hooks as JsonObject;
    hooks.PostToolUse = post;

    expect(ownedEntries(seed, value.hooks, []).map((entry) => entry.old)).toEqual([
      commands[0]!,
      commands[1]!,
      commands[0]!,
    ]);

    expect(missingEntries(seed, value.agents).map((entry) => entry.event)).toEqual(["PostToolUse"]);
    writeFileSync(value.path, stringifyJson(seed));
    value.write();
    expect(JSON.parse(readFileSync(value.path, "utf8")).hooks.PostToolUse).toEqual([
      {
        matcher: "^(Bash|apply_patch)$",
        hooks: [{ type: "command", command: commandFor("hook post-tool-use", value.agents) }],
      },
    ]);

    post[0]!.matcher = "Bash|apply_patch|Edit";
    writeFileSync(value.path, stringifyJson(seed));
    value.write();
    expect(JSON.parse(readFileSync(value.path, "utf8")).hooks.PostToolUse).toEqual([
      {
        matcher: "Bash|apply_patch|Edit",
        groupKey: "kept",
        hooks: [
          { type: "command", command: commandFor("hook post-tool-use", value.agents), timeout: 17 },
        ],
      },
    ]);

    const before = readFileSync(value.path);
    value.write();
    expect(readFileSync(value.path)).toEqual(before);

    for (const personal of [[], [order[0]!], [order[1]!]]) {
      writeFileSync(value.path, stringifyJson(seed));
      const before = readFileSync(value.path);
      value.write({ personal, noCli: !personal.length });
      expect(readFileSync(value.path)).toEqual(before);
    }
  }
});

test("skip output without missing entries", () => {
  expect(
    skipHooks(
      "/hooks.json",
      "is not writable",
      [],
      [
        {
          event: "SessionStart",
          target: "hook session-start",
          group: {},
          entry: {},
          old: "/hooks/session-brief.sh",
        },
      ],
    ),
  ).toBe("skip   /hooks.json (is not writable)\n");
});

test("fresh Codex hooks file and fresh Codex hooks rerun", () => {
  const value = fixture();
  const output = value.write();
  const content = readFileSync(value.path, "utf8");
  const before = statSync(value.path);
  const data = JSON.parse(content);

  expect(data.description).toBeUndefined();

  for (const { event, target } of hookTable) {
    expect(data.hooks[event][0].hooks).toEqual([
      { type: "command", command: commandFor(target, value.agents) },
    ]);

    expect(output).toContain(`codex  add ${event} ${commandFor(target, value.agents)}\n`);
  }

  expect(value.write()).toBe(`codex  ${value.path} already holds every skills hook\n`);
  expect(readFileSync(value.path, "utf8")).toBe(content);
  expect(statSync(value.path).ino).toBe(before.ino);
  expect(statSync(value.path).mtimeMs).toBe(before.mtimeMs);
});

test("hand formatted Codex hooks", () => {
  const value = fixture();
  const seed: JsonObject = { hooks: {} };
  addEntries(seed, missingEntries(seed, value.agents));

  const content = JSON.stringify(JSON.parse(stringifyJson(seed)));
  writeFileSync(value.path, content);
  const before = statSync(value.path);
  value.write();

  expect(readFileSync(value.path, "utf8")).toBe(content);
  expect(statSync(value.path).ino).toBe(before.ino);
  expect(statSync(value.path).mtimeMs).toBe(before.mtimeMs);
});

test("personal Codex hooks and personal retired hook is preserved", () => {
  const value = fixture();
  const old = join(value.hooks, "no-comments.sh");
  const seed = {
    mine: { x: 1 },
    hooks: {
      Stop: [{ hooks: [{ type: "command", command: "/mine/stop" }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: "/mine/prompt" }] }],
      PostToolUse: [
        {
          matcher: "personal",
          hooks: [
            { type: "command", command: old },
            { type: "command", command: "/mine/post", timeout: 5 },
          ],
        },
      ],
    },
  };

  writeFileSync(value.path, JSON.stringify(seed));
  value.write({ personal: ["no-comments.sh"] });
  const result = JSON.parse(readFileSync(value.path, "utf8"));

  expect(result.mine).toEqual(seed.mine);
  expect(result.hooks.PostToolUse).toEqual(seed.hooks.PostToolUse);
  expect(result.hooks.Stop[0]).toEqual(seed.hooks.Stop[0]);
  expect(result.hooks.UserPromptSubmit).toEqual(seed.hooks.UserPromptSubmit);

  const before = readFileSync(value.path);
  value.write({ personal: ["no-comments.sh"] });
  expect(readFileSync(value.path)).toEqual(before);
});

test.each([
  [
    "invalid Codex hooks JSON",
    '{ "hooks": ',
    "invalid JSON: Expecting value: line 1 column 12 (char 11)",
  ],
  ["NaN in Codex hooks", '{"mine": NaN, "hooks": {}}', "NaN is not JSON"],
  ["Infinity in Codex hooks", '{"mine": Infinity}', "Infinity is not JSON"],
  ["duplicate Codex hook key", '{"hooks":{"Stop":[],"Stop":[]}}', "duplicate key: Stop"],
  ["float whose repr would change", '{"mine":1e1}', "number 1e1 would change on a rewrite"],
  ["top level shape", "[]", "top level is not an object"],
  ["hooks shape", '{"hooks":[]}', "hooks is not an object"],
  ["event shape", '{"hooks":{"Stop":{}}}', "Stop is not a list"],
  ["too deeply nested", "[".repeat(1001) + "]".repeat(1001), "nested too deeply to parse"],
])("%s", (_name, content, reason) => {
  const value = fixture();
  writeFileSync(value.path, content);
  const before = statSync(value.path);
  const output = value.write();

  expect(output).toStartWith(`skip   ${value.path} (${reason})`);
  for (const { target } of hookTable) expect(output).toContain(commandFor(target, value.agents));
  expect(readFileSync(value.path, "utf8")).toBe(content);
  expect(statSync(value.path).mtimeMs).toBe(before.mtimeMs);
});

test("symlinked Codex hooks", () => {
  const value = fixture();
  const target = join(value.directory, "target.json");
  writeFileSync(
    target,
    '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"/mine/stop"}]}]}}',
  );

  chmodSync(target, 0o640);
  symlinkSync(target, value.path);
  value.write();

  expect(JSON.parse(readFileSync(target, "utf8")).hooks.Stop[0].hooks[0].command).toBe(
    "/mine/stop",
  );

  expect(statSync(target).mode & 0o777).toBe(0o640);
  expect(missingEntries(parseJson(readFileSync(target, "utf8")), value.agents)).toEqual([]);
});

test("number lexemes and Unicode survive a rewrite", () => {
  const value = fixture();
  writeFileSync(value.path, '{"mine":[1.0,9007199254740993,1e-07,-0.0,"雪😀"],"hooks":{}}');
  value.write();

  expect(readFileSync(value.path, "utf8")).toContain(
    '1.0,\n    9007199254740993,\n    1e-07,\n    -0.0,\n    "雪😀"',
  );
});

test("numeric object keys keep their written order", () => {
  expect(stringifyJson(parseJson('{"20":1,"3":2,"0":3}'))).toBe(
    '{\n  "20": 1,\n  "3": 2,\n  "0": 3\n}',
  );
});

test("unpaired surrogates refuse a rewrite without confusing escaped text", () => {
  const value = fixture();
  const content = '{"mine":"\\ud800"}';
  writeFileSync(value.path, content);

  expect(value.write()).toContain("cannot encode as UTF-8");
  expect(readFileSync(value.path, "utf8")).toBe(content);
  expect(stringifyJson(parseJson('{"mine":"\\\\ud800"}'))).toBe('{\n  "mine": "\\\\ud800"\n}');
});

test("readonly file with owned retired entry", () => {
  const value = fixture();
  const old = join(value.hooks, "session-brief.sh");
  const content = JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: old }] }] },
  });

  writeFileSync(value.path, content);
  chmodSync(value.path, 0o444);
  const output = value.write();

  expect(output).toContain(`codex  remove SessionStart ${old} by hand\n`);
  expect(output).toContain(commandFor("hook session-start", value.agents));
  expect(readFileSync(value.path, "utf8")).toBe(content);
});

test.each([
  "directory",
  "dangling",
  "loop",
  "unreadable",
  "hard links",
  "parent unwritable",
  "not UTF-8",
])("refuses %s", (kind) => {
  const value = fixture();
  if (kind === "directory") mkdirSync(value.path);
  else if (kind === "dangling") symlinkSync(join(value.directory, "missing"), value.path);
  else if (kind === "loop") symlinkSync(value.path, value.path);
  else {
    writeFileSync(value.path, kind === "not UTF-8" ? Buffer.from([0xff]) : "{}");
    if (kind === "unreadable") chmodSync(value.path, 0);
    if (kind === "hard links") linkSync(value.path, join(value.directory, "second"));
    if (kind === "parent unwritable") chmodSync(value.directory, 0o555);
  }

  expect(value.write()).toStartWith(`skip   ${value.path}`);
});

test.skipIf(process.platform !== "darwin")("a rewrite keeps the file's extended attributes", () => {
  const value = fixture();
  writeFileSync(value.path, JSON.stringify({ hooks: {} }));
  Bun.spawnSync(["xattr", "-w", "dev.skills.label", "kept", value.path]);

  value.write();
  const label = Bun.spawnSync(["xattr", "-p", "dev.skills.label", value.path]);

  expect(readFileSync(value.path, "utf8")).toContain("hook session-start");
  expect(label.stdout.toString()).toBe("kept\n");
});
