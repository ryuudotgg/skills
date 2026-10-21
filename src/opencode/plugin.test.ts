import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import plugin, { createPlugin } from "../../skills/playbook/opencode/plugin.ts";
import { check } from "../hooks/post-tool-use.ts";
import { guardOutput } from "../hooks/pre-tool-use.ts";
import { fixtureGit } from "../test/fixtures.ts";
import { suiteEnvironment } from "../test/process.ts";

type Context = Parameters<typeof plugin.setup>[0];
type Callback = Parameters<Context["tool"]["hook"]>[1];
type After = Parameters<Callback>[0] & {
  status: "completed";
  result: { output?: unknown; content?: string | readonly unknown[] };
};

const repo = resolve(import.meta.dir, "../..");
const original = "const counter = 0;\n";
const fresh = original + "// increment the counter\n";

let temporary: string;
let directory: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  temporary = mkdtempSync(join(tmpdir(), "skills-opencode-"));
  directory = join(temporary, "repo");
  mkdirSync(join(directory, "src"), { recursive: true });
  await fixtureGit(directory, ["init", "-q", "-b", "main"]);

  const conf = join(temporary, "skills.conf");
  writeFileSync(conf, "DELIVERY=prs\n");
  env = { ...suiteEnvironment(), HOME: temporary, SKILLS_CONF: conf, AGENT_HOOKS: "1" };
  delete env.AGENT_HOOKS_SKIP;
  delete env.AGENTS_DIR;
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

async function hooks(options: Parameters<typeof createPlugin>[0] = {}) {
  const captured = new Map<string, Callback>();
  await createPlugin({ env, ...options }).setup({
    location: { directory },
    tool: {
      async hook(name, callback) {
        captured.set(name, callback as Callback);
      },
    },
  });

  return {
    before: captured.get("execute.before")!,
    after: captured.get("execute.after")!,
  };
}

function cli(contents: string): string {
  const path = join(temporary, "cli");
  writeFileSync(path, "#!/bin/sh\n" + contents + "\n", { mode: 0o755 });
  return path;
}

test("shell and renamed shell reject with the commit guard's exact reason", async () => {
  const command = ["git", "push", "--force", "origin", "main"].join(" ");
  const expected = JSON.parse(
    await guardOutput(
      JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: directory }),
      join(repo, "skills"),
      env,
    ),
  ).hookSpecificOutput.permissionDecisionReason;

  const captured = await hooks();

  expect(expected).toBeString();

  for (const tool of ["shell", "renamed-shell"])
    await expect(captured.before({ tool, input: { command } })).rejects.toThrow(expected);
});

test.each([
  [
    "edit",
    { path: "src/a.ts", oldString: original, newString: fresh },
    "Edit",
    { old_string: original, new_string: fresh },
  ],
  ["write", { path: "src/a.ts", content: fresh }, "Write", { content: fresh }],
  [
    "patch",
    {
      patchText:
        "*** Begin Patch\n*** Update File: src/a.ts\n@@\n const counter = 0;\n+// increment the counter\n*** End Patch\n",
    },
    "apply_patch",
    {},
  ],
])("%s prepends the existing post guard's exact reason", async (tool, input, toolName, fields) => {
  writeFileSync(join(directory, "src/a.ts"), fresh);
  const payload = {
    tool_name: toolName,
    tool_input:
      tool === "patch"
        ? { command: (input as { patchText: string }).patchText }
        : { file_path: join(directory, "src/a.ts"), ...fields },
    cwd: directory,
  };

  const reason = check(payload, env);
  const event: After = { tool, input, status: "completed", result: { content: "original result" } };
  const captured = await hooks();
  await captured.after(event);

  expect(reason).toContain("increment the counter");
  expect(event.result.content).toEqual([
    { type: "text", text: reason },
    { type: "text", text: "original result" },
  ]);
});

test("read and unsuccessful edits spawn nothing", async () => {
  const captured = await hooks({ cli: cli('touch "$HOME/spawned"; exit 1') });
  await captured.before({ tool: "read", input: { path: "src/a.ts" } });
  await captured.after({ tool: "read", input: {}, status: "completed", result: {} });
  await captured.after({ tool: "edit", input: {}, status: "error" });

  expect(() => readFileSync(join(temporary, "spawned"))).toThrow();
});

test("an unrunnable CLI fails closed before shell and leaves post results alone", async () => {
  const captured = await hooks({ cli: join(temporary, "missing") });
  await expect(captured.before({ tool: "shell", input: { command: "pwd" } })).rejects.toThrow(
    "the commit guard could not run",
  );

  const event: After = {
    tool: "write",
    input: { path: "src/a.ts", content: fresh },
    status: "completed",
    result: { content: "unchanged" },
  };

  await captured.after(event);

  expect(event.result.content).toBe("unchanged");
});

test.each(["exit 1", "printf 'garbage'", "printf '{}'", "printf ' '", "kill -TERM $$"])(
  "pre fails closed on %s",
  async (script) => {
    const captured = await hooks({ cli: cli(script) });

    await expect(captured.before({ tool: "shell", input: { command: "pwd" } })).rejects.toThrow(
      "the commit guard could not run",
    );
  },
);

test("only an empty successful pre output allows shell", async () => {
  const captured = await hooks({ cli: cli("exit 0") });

  await expect(
    captured.before({ tool: "shell", input: { command: "pwd" } }),
  ).resolves.toBeUndefined();
});

test("a valid denial retains its reason even on nonzero exit", async () => {
  const captured = await hooks({
    cli: cli(
      'printf \'%s\' \'{"hookSpecificOutput":{"permissionDecision":"deny","permissionDecisionReason":"exact denial"}}\'; exit 1',
    ),
  });

  await expect(captured.before({ tool: "shell", input: { command: "pwd" } })).rejects.toThrow(
    "exact denial",
  );
});

test("timeouts fail closed before shell and never throw after writes", async () => {
  const captured = await hooks({ cli: cli("sleep 10"), timeout: 30 });
  await expect(captured.before({ tool: "shell", input: { command: "pwd" } })).rejects.toThrow(
    "the commit guard could not run",
  );

  const event: After = {
    tool: "write",
    input: { path: "src/a.ts", content: fresh },
    status: "completed",
    result: { output: { ok: true } },
  };

  await captured.after(event);

  expect(event.result).toEqual({ output: { ok: true } });
});

test.each([[undefined], [[]], [""], [[{ type: "file", uri: "file:///example" }]]])(
  "post preserves and normalizes content %j",
  async (value) => {
    const captured = await hooks({
      cli: cli('printf \'%s\' \'{"decision":"block","reason":"guard reason"}\''),
    });

    const event: After = {
      tool: "write",
      input: { path: "src/a.ts", content: fresh },
      status: "completed",
      result: { output: { ok: true }, content: value },
    };

    await captured.after(event);

    const previous =
      typeof value === "string"
        ? [{ type: "text", text: value }]
        : value?.length
          ? value
          : [{ type: "text", text: '{"ok":true}' }];

    expect(event.result.content).toEqual([{ type: "text", text: "guard reason" }, ...previous]);
  },
);

test.each([
  ["plain output", "plain output"],
  [undefined, "undefined"],
  [1n, "1"],
])("post normalizes output %s like OpenCode", async (output, expected) => {
  const captured = await hooks({
    cli: cli('printf \'%s\' \'{"decision":"block","reason":"guard reason"}\''),
  });

  const event: After = {
    tool: "write",
    input: { path: "src/a.ts", content: fresh },
    status: "completed",
    result: { output },
  };

  await captured.after(event);

  expect(event.result.content).toEqual([
    { type: "text", text: "guard reason" },
    { type: "text", text: expected },
  ]);
});

test("paths expand home and patch headers normalize before the CLI", async () => {
  const captured = await hooks({ cli: cli('cat > "$HOME/payload"') });
  await captured.before({ tool: "shell", input: { command: "pwd", workdir: "~/repo" } });
  expect(JSON.parse(readFileSync(join(temporary, "payload"), "utf8")).cwd).toBe(directory);

  await captured.after({
    tool: "edit",
    input: { path: "~/repo/src/a.ts", oldString: original, newString: fresh },
    status: "completed",
    result: {},
  });

  expect(JSON.parse(readFileSync(join(temporary, "payload"), "utf8")).tool_input.file_path).toBe(
    join(directory, "src/a.ts"),
  );

  await captured.after({
    tool: "patch",
    input: {
      patchText: [
        "  *** Begin Patch  ",
        "*** Add File:  ~/repo/note.md ",
        "+text",
        "*** Update File: src/a.ts",
        "*** Move to:  ~/moved.ts",
        "*** End Patch ",
        "",
      ].join("\r\n"),
    },
    status: "completed",
    result: {},
  });

  expect(JSON.parse(readFileSync(join(temporary, "payload"), "utf8")).tool_input.command).toBe(
    [
      "*** Begin Patch",
      `*** Add File: ${join(directory, "note.md")}`,
      "+text",
      `*** Update File: ${join(directory, "src/a.ts")}`,
      `*** Move to: ${join(temporary, "moved.ts")}`,
      "*** End Patch",
      "",
    ].join("\n"),
  );
});
