import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPlugin } from "../../../../skills/playbook/opencode/plugin.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

setDefaultTimeout(30_000);

const repo = resolve(import.meta.dir, "../../../..");
const cli = join(repo, "packages/cli/src/cli.ts");
const machine = join(import.meta.dir, "fixture/machine.sh");

let temporary: string;
let dir: string;
let env: NodeJS.ProcessEnv;

const claudePath = () =>
  join(dir, "home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl");

const subagentPath = () =>
  join(
    dir,
    "home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture/subagents/agent-one.jsonl",
  );

const codexPath = () =>
  join(dir, "home/.codex/sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-fixture.jsonl");

type Line = Record<string, unknown>;

function records(path: string): Line[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Line);
}

function claudeTokens(path: string): number {
  return records(path)
    .filter((record) => record.type === "assistant")
    .map((record) => (record.message as { usage: Record<string, number> }).usage)
    .reduce((sum, usage) => sum + usage.input_tokens! + usage.output_tokens!, 0);
}

function codexTokens(path: string): number {
  const counts = records(path).filter(
    (record) => (record.payload as Line).type === "token_count" && (record.payload as Line).info,
  );

  const info = (counts.at(-1)!.payload as { info: { total_token_usage: Record<string, number> } })
    .info.total_token_usage;

  return info.input_tokens! + info.output_tokens!;
}

async function skills(args: readonly string[], payload?: string) {
  const proc = Bun.spawn([process.execPath, cli, ...args], {
    cwd: repo,
    env,
    stdin: payload === undefined ? "ignore" : new Blob([payload]),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { code, stdout, stderr };
}

async function list(...args: string[]): Promise<string[][]> {
  const result = await skills(["sessions", "list", ...args]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);

  return result.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\t"));
}

async function scan(): Promise<string> {
  const result = await skills(["sessions", "scan"]);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);

  return result.stdout;
}

async function hook(payload: string) {
  const result = await skills(["hook", "session-start"], payload);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).hookSpecificOutput.hookEventName).toBe("SessionStart");
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-sessions-")));
  dir = join(temporary, "machine");

  const built = await runCommand([machine, dir], { cwd: temporary });
  expect(built.stderr).toBe("");
  expect(built.code).toBe(0);
  expect(built.stdout).toBe(`export HOME='${dir}/home' PLANS_DIR='${dir}/plans'\n`);

  const conf = join(temporary, "skills.conf");
  writeFileSync(conf, "");
  env = {
    ...suiteEnvironment(),
    HOME: join(dir, "home"),
    PLANS_DIR: join(dir, "plans"),
    SKILLS_CONF: conf,
    AGENT_HOOKS: "1",
    SKILLS_AUTO_UPDATE: "0",
    SKILLS_MACHINE_REFRESH: "0",
  };

  delete env.CLAUDE_PROJECT_DIR;
  delete env.AGENTS_DIR;
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("the Claude Code hook records one session that a resume folds into", async () => {
  const payload = readFileSync(join(dir, "hook-claude.json"), "utf8");
  await hook(payload);

  const [line, ...rest] = await list("Alpha");
  expect(rest).toEqual([]);
  expect(line!.slice(0, 5)).toEqual(["claude", "claude-fixture", "Alpha", "001", "feat/one"]);

  await hook(payload.replace("startup", "resume"));
  expect(await list("Alpha")).toHaveLength(1);
});

test("the Codex hook and the OpenCode plugin record their own hosts", async () => {
  await hook(readFileSync(join(dir, "hook-codex.json"), "utf8"));

  const plugin = createPlugin({ env, cli: join(repo, "skills/playbook/bin/skills") });
  let context: ((event: { sessionID: string; system: unknown[] }) => Promise<void>) | undefined;
  const cleanup = await plugin.setup({
    location: { directory: join(dir, "checkout/Alpha") },
    tool: { async hook() {} },
    session: {
      async hook(_name, callback) {
        context = callback as typeof context;
      },
      async get() {
        return {};
      },
      async context() {
        return [];
      },
      async prompt() {},
    },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  });

  try {
    await context!({ sessionID: "opencode-fixture", system: [] });
  } finally {
    cleanup();
  }

  const hosts = (await list("--plan", "Alpha/001")).map((line) => line.slice(0, 2)).sort();
  expect(hosts).toEqual([
    ["codex", "codex-fixture"],
    ["opencode", "opencode-fixture"],
  ]);
});

test("--plan lists only the sessions linked to that plan", async () => {
  await hook(readFileSync(join(dir, "hook-claude.json"), "utf8"));

  expect(await list("--plan", "Alpha/001")).toHaveLength(1);
  expect(await list("--plan", "Alpha/002")).toEqual([]);
  expect(await list("Beta")).toEqual([]);
});

test("a malformed payload, an unknown host or a cwd outside every project records nothing", async () => {
  await hook("not json");
  await hook(JSON.stringify({ session_id: "x", cwd: dir }));
  await hook(
    JSON.stringify({ session_id: "outside", cwd: temporary, transcript_path: codexPath() }),
  );

  expect(await list()).toEqual([]);
});

test("the scan reads each transcript once, from where it stopped", async () => {
  expect(await scan()).toBe("scanned 2 transcripts, 2 changed\n");

  const lines = await list();
  expect(lines).toHaveLength(2);

  const claude = lines.find((line) => line[1] === "claude-fixture")!;
  const codex = lines.find((line) => line[1] === "codex-fixture")!;

  expect(Number(claude[9])).toBe(claudeTokens(claudePath()) + claudeTokens(subagentPath()));
  expect(claude[8]).toBe("claude-opus-5-5/-,claude-sonnet-5-5/medium");

  expect(codex[2]).toBe("-");
  expect(codex[8]).toBe("gpt-6.1-sol/high,gpt-6.1-terra/medium");
  expect(Number(codex[9])).toBe(codexTokens(codexPath()));

  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");

  appendFileSync(
    claudePath(),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-07T12:00:00Z", message: { content: "again" } })}\n`,
  );

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");
  expect((await list()).find((line) => line[1] === "claude-fixture")![7]).toBe(
    "2026-11-07T12:00:00Z",
  );
});

test("Codex totals keep counting across scans", async () => {
  await scan();

  const usage = {
    input_tokens: 30000,
    cached_input_tokens: 15000,
    output_tokens: 1500,
    reasoning_output_tokens: 300,
    total_tokens: 31500,
  };

  appendFileSync(
    codexPath(),
    `${JSON.stringify({ timestamp: "2026-11-07T10:02:00Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: usage } } })}\n`,
  );

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");
  expect((await list()).find((line) => line[1] === "codex-fixture")![9]).toBe("31500");
});

test("a Codex subagent rollout folds into its parent session", async () => {
  await scan();

  const meta = {
    timestamp: "2026-11-07T10:03:00Z",
    type: "session_meta",
    payload: {
      id: "review-thread",
      session_id: "codex-fixture",
      parent_thread_id: "codex-fixture",
      source: { subagent: "review" },
      cwd: "/tmp/sessions-fixture/checkout/Alpha",
    },
  };

  const usage = { input_tokens: 400, output_tokens: 50, total_tokens: 450 };
  const tokens = {
    timestamp: "2026-11-07T10:03:05Z",
    type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: usage } },
  };

  writeFileSync(
    codexPath().replace("codex-fixture.jsonl", "review-thread.jsonl"),
    `${JSON.stringify(meta)}\n${JSON.stringify(tokens)}\n`,
  );

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const lines = await list();
  expect(lines.map((line) => line[1]).sort()).toEqual(["claude-fixture", "codex-fixture"]);
  expect(lines.find((line) => line[1] === "codex-fixture")![9]).toBe(
    String(codexTokens(codexPath()) + 450),
  );
});

test("a Claude message split across records counts its usage once, across scans too", async () => {
  await scan();

  const before = Number((await list()).find((line) => line[1] === "claude-fixture")![9]);
  const record = (id: string, block: string) => ({
    type: "assistant",
    timestamp: "2026-11-07T11:00:00Z",
    message: {
      id,
      model: "claude-opus-5-5",
      content: [{ type: block, name: "Read" }],
      usage: { input_tokens: 5, output_tokens: 7 },
    },
  });

  appendFileSync(claudePath(), `${JSON.stringify(record("msg_a", "thinking"))}\n`);
  await scan();

  for (const [id, block] of [
    ["msg_a", "tool_use"],
    ["msg_b", "text"],
    ["msg_a", "text"],
  ])
    appendFileSync(claudePath(), `${JSON.stringify(record(id!, block!))}\n`);

  await scan();

  expect(Number((await list()).find((line) => line[1] === "claude-fixture")![9])).toBe(before + 24);
});

test("a transcript truncated below its offset is rescanned from zero", async () => {
  await scan();

  const kept = readFileSync(claudePath(), "utf8").split("\n").slice(0, 3).join("\n") + "\n";
  writeFileSync(claudePath(), kept);

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const claude = (await list()).find((line) => line[1] === "claude-fixture")!;
  expect(Number(claude[9])).toBe(claudeTokens(claudePath()) + claudeTokens(subagentPath()));
});

test("a transcript whose first line changed is rescanned from zero", async () => {
  await scan();

  const [first, ...rest] = readFileSync(claudePath(), "utf8").split("\n");
  const renamed = JSON.stringify({ ...JSON.parse(first!), summary: "Renamed session" });
  writeFileSync(claudePath(), [renamed, ...rest.slice(0, -1), rest.at(-2), ""].join("\n"));

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const claude = (await list()).find((line) => line[1] === "claude-fixture")!;
  expect(Number(claude[9])).toBe(claudeTokens(claudePath()) + claudeTokens(subagentPath()));
});

test("a rebuilt store gets every session again from the next scan", async () => {
  await scan();

  rmSync(join(dir, "plans/plans.db"));
  expect(await scan()).toBe("scanned 2 transcripts, 2 changed\n");
  expect(await list()).toHaveLength(2);
});

test("a second scan while one runs refuses", async () => {
  const lock = join(dir, "plans/.sessions.lock");
  writeFileSync(lock, "");

  const holder = Bun.spawn(
    [
      "/usr/bin/env",
      "perl",
      "-MFcntl=:flock",
      "-e",
      `open(F, ">>", "${lock}") or die; flock(F, LOCK_EX) or die; print "held\\n"; $| = 1; sleep 30`,
    ],
    { stdout: "pipe" },
  );

  try {
    const reader = holder.stdout.getReader();
    await reader.read();

    const result = await skills(["sessions", "scan"]);
    expect([result.code, result.stderr]).toEqual([
      1,
      "sessions scan: another sessions scan is running\n",
    ]);
  } finally {
    holder.kill();
  }
});

test("tool and model names that shadow object keys count like any other", async () => {
  const record = {
    type: "assistant",
    timestamp: "2026-11-07T11:00:00Z",
    message: {
      model: "constructor",
      content: [
        { type: "tool_use", name: "mcp__odd__constructor" },
        { type: "tool_use", name: "__proto__" },
      ],
      usage: { input_tokens: 3, output_tokens: 4 },
    },
  };

  appendFileSync(claudePath(), `${JSON.stringify(record)}\n`);
  expect(await scan()).toBe("scanned 2 transcripts, 2 changed\n");

  const claude = (await list()).find((line) => line[1] === "claude-fixture")!;
  expect(claude[8]).toBe("claude-opus-5-5/-,claude-sonnet-5-5/medium,constructor/-");
  expect(Number(claude[9])).toBe(claudeTokens(claudePath()) + claudeTokens(subagentPath()));
});
