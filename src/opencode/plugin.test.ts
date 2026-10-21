import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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
let cleanups: (() => void)[] = [];

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
  for (const cleanup of cleanups.splice(0)) cleanup();
  rmSync(temporary, { recursive: true, force: true });
});

type Message = Awaited<ReturnType<Context["session"]["context"]>>[number];
type Execution = { type: string; data: { sessionID: string } };
type System = { type: "text"; text: string }[];

function stream() {
  const queued: Execution[] = [];
  let wake: (() => void) | undefined;
  let idle: (() => void) | undefined;

  return {
    push(event: Execution) {
      queued.push(event);
      wake?.();
    },
    settled: () =>
      new Promise<void>((accept) => {
        idle = accept;
        if (!queued.length && wake) accept();
      }),
    async *iterate(signal: AbortSignal): AsyncIterable<Execution> {
      while (!signal.aborted) {
        if (!queued.length) {
          idle?.();
          await new Promise<void>((accept) => {
            wake = accept;
            signal.addEventListener("abort", () => accept(), { once: true });
          });

          wake = undefined;
          continue;
        }

        yield queued.shift()!;
      }
    },
  };
}

async function hooks(options: Parameters<typeof createPlugin>[0] = {}) {
  const captured = new Map<string, Callback>();
  const events = stream();

  const replies = new Map<string, Message[]>();
  const interrupting = new Set<string>();
  const parents = new Map<string, string>();
  const prompts: { sessionID: string; text: string }[] = [];
  let context: ((event: { sessionID: string; system: System }) => Promise<void>) | undefined;

  const cleanup = await createPlugin({ env, ...options }).setup({
    location: { directory },
    tool: {
      async hook(name, callback) {
        captured.set(name, callback as Callback);
      },
    },
    session: {
      async hook(_name, callback) {
        context = callback;
      },
      async get({ sessionID }) {
        return { parentID: parents.get(sessionID) };
      },
      async context({ sessionID }) {
        const messages = replies.get(sessionID) ?? [];
        if (interrupting.delete(sessionID))
          replies.set(sessionID, [...messages, { id: "newer", type: "user" }]);

        return messages;
      },
      async prompt(input) {
        prompts.push(input);
      },
    },
    event: { subscribe: ({ signal }) => events.iterate(signal) },
  });

  cleanups.push(cleanup);

  return {
    before: captured.get("execute.before")!,
    after: captured.get("execute.after")!,
    async request(sessionID: string) {
      const event = { sessionID, system: [{ type: "text", text: "base" }] as System };
      await context!(event);
      return event.system;
    },
    async finish(sessionID: string, type: string, reply?: string | Message[]) {
      if (typeof reply === "string")
        replies.set(sessionID, [
          { id: "question", type: "user" },
          {
            id: `reply-${randomUUID()}`,
            type: "assistant",
            time: { completed: 1 },
            content: [
              { type: "text", text: "Checking." },
              { type: "reasoning", text: "thinking" },
              { type: "text", text: reply },
            ],
          },
          { id: `idle-${randomUUID()}`, type: "idle", outcome: "succeeded" },
        ]);
      else if (reply) replies.set(sessionID, reply);

      events.push({ type, data: { sessionID } });
      await events.settled();
    },
    interrupting,
    parents,
    prompts,
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

const bin = join(repo, "skills/playbook/bin/skills");
const dashed = "Done \u2014 the counter works.";

function recording(): string {
  return cli(
    `input=$(cat)\nprintf '%s %s\\n' "$2" "$input" >> "$HOME/calls"\nprintf '%s' "$input" | exec '${bin}' "$@"`,
  );
}

function calls(verb: string): Record<string, unknown>[] {
  let text = "";
  try {
    text = readFileSync(join(temporary, "calls"), "utf8");
  } catch {}

  return text
    .split("\n")
    .filter((line) => line.startsWith(verb + " "))
    .map((line) => JSON.parse(line.slice(verb.length + 1)));
}

function session(): string {
  const id = `ses_test_${randomUUID()}`;
  cleanups.push(() => rmSync(`/tmp/reply-guard-${id}.json`, { force: true }));
  return id;
}

test("the brief lands in system on every request, read once per session", async () => {
  const captured = await hooks({ cli: recording() });
  const first = session();
  const second = session();

  const systems = [
    ...(await Promise.all([captured.request(first), captured.request(first)])),
    await captured.request(first),
    await captured.request(second),
  ];

  for (const system of systems) {
    expect(system).toHaveLength(2);
    expect(system[0]).toEqual({ type: "text", text: "base" });
    expect(system[1]!.text).toStartWith("Delivery: prs");
  }

  expect(calls("session-start")).toHaveLength(2);
});

test("AGENT_HOOKS=0 adds no brief", async () => {
  env.AGENT_HOOKS = "0";
  const captured = await hooks({ cli: bin });
  expect(await captured.request(session())).toEqual([{ type: "text", text: "base" }]);
});

test("a failing brief adds nothing and is not retried", async () => {
  const captured = await hooks({ cli: cli('echo x >> "$HOME/calls"; exit 1') });
  const id = session();

  expect(await captured.request(id)).toHaveLength(1);
  expect(await captured.request(id)).toHaveLength(1);
  expect(readFileSync(join(temporary, "calls"), "utf8")).toBe("x\n");
});

test("three dashed replies prompt twice, then the stop cap ends the loop", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();
  for (let turn = 0; turn < 3; turn++)
    await captured.finish(id, "session.execution.succeeded", dashed);

  expect(captured.prompts).toHaveLength(2);

  for (const prompt of captured.prompts) {
    expect(prompt.sessionID).toBe(id);
    expect(prompt.text).toContain("a dash used as punctuation");
  }

  expect(calls("stop").map((payload) => payload.stop_hook_active)).toEqual([false, true, true]);
  expect(calls("stop")[0]).toMatchObject({
    session_id: id,
    last_assistant_message: "Checking.\n" + dashed,
    cwd: directory,
  });
});

test("a clean rewrite prompts nothing more", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();

  await captured.finish(id, "session.execution.succeeded", dashed);
  await captured.finish(id, "session.execution.succeeded", "Done. The counter works.");

  expect(captured.prompts).toHaveLength(1);
  expect(calls("stop").map((payload) => payload.stop_hook_active)).toEqual([false, true]);
});

test("failed and interrupted executions get no prompt and end the rewrite", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();

  await captured.finish(id, "session.execution.succeeded", dashed);
  await captured.finish(id, "session.execution.started");
  await captured.finish(id, "session.execution.interrupted");
  await captured.finish(id, "session.execution.failed", dashed);
  await captured.finish(id, "session.execution.succeeded", dashed);

  expect(captured.prompts).toHaveLength(2);
  expect(calls("stop").map((payload) => payload.stop_hook_active)).toEqual([false, false]);
});

test("subagent sessions run no reply guard", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();
  captured.parents.set(id, "ses_parent");

  await captured.finish(id, "session.execution.succeeded", dashed);

  expect(captured.prompts).toEqual([]);
  expect(calls("stop")).toEqual([]);
});

test("subagent sessions get no brief", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();
  captured.parents.set(id, "ses_parent");

  expect(await captured.request(id)).toHaveLength(1);
  expect(calls("session-start")).toEqual([]);
});

test.each([
  ["no assistant reply", [{ id: "compacted", type: "compaction" }]],
  [
    "an unfinished reply",
    [{ id: "partial", type: "assistant", content: [{ type: "text", text: dashed }] }],
  ],
  [
    "a failed execution after the reply",
    [
      {
        id: "failed",
        type: "assistant",
        time: { completed: 1 },
        content: [{ type: "text", text: dashed }],
      },
      { id: "idle", type: "idle", outcome: "failed" },
    ],
  ],
  [
    "a reply that errored",
    [
      {
        id: "errored",
        type: "assistant",
        time: { completed: 1 },
        error: { message: "boom" },
        content: [{ type: "text", text: dashed }],
      },
      { id: "idle", type: "idle", outcome: "succeeded" },
    ],
  ],
  [
    "a reply older than the last prompt",
    [
      {
        id: "old",
        type: "assistant",
        time: { completed: 1 },
        content: [{ type: "text", text: dashed }],
      },
      { id: "shell", type: "shell" },
    ],
  ],
])("an execution ending with %s runs no reply guard", async (_label, messages) => {
  const captured = await hooks({ cli: recording() });

  await captured.finish(session(), "session.execution.succeeded", messages);

  expect(calls("stop")).toEqual([]);
  expect(captured.prompts).toEqual([]);
});

test("a rewrite prompt never lands in a newer turn", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();
  captured.interrupting.add(id);

  await captured.finish(id, "session.execution.succeeded", dashed);
  await captured.finish(id, "session.execution.succeeded", dashed);

  expect(captured.prompts).toHaveLength(1);
  expect(calls("stop").map((payload) => payload.stop_hook_active)).toEqual([false, false]);
});

test("a reply already checked is not checked again", async () => {
  const captured = await hooks({ cli: recording() });
  const id = session();

  await captured.finish(id, "session.execution.succeeded", dashed);
  await captured.finish(id, "session.execution.succeeded");

  expect(calls("stop")).toHaveLength(1);
  expect(captured.prompts).toHaveLength(1);
});
