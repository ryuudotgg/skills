import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createPlugin } from "../../../../skills/playbook/opencode/plugin.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

setDefaultTimeout(30_000);

const repo = resolve(import.meta.dir, "../../../..");
const cli = join(repo, "packages/cli/src/cli.ts");
const machine = join(import.meta.dir, "fixture/machine.sh");
const lockModule = join(repo, "packages/cli/src/lock.ts");

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

function count(sql: string): number {
  const db = new Database(join(dir, "plans/plans.db"), { readonly: true });
  try {
    return (db.query(sql).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

const recorded = () =>
  count(
    "SELECT count(*) AS n FROM events WHERE project = 'Alpha' AND type IN ('session', 'session-stats')",
  );

async function policy(...args: string[]) {
  return skills(["sessions", "policy", ...args]);
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
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CODEX_HOME;
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
      process.execPath,
      "-e",
      `const { withLock } = await import(${JSON.stringify(lockModule)});
       await withLock(${JSON.stringify(lock)}, "test", async () => {
         console.log("held");
         await Bun.sleep(30_000);
       });`,
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

test("a hook session read during one scan keeps its project in the next", async () => {
  await scan();

  const transcript = join(dirname(claudePath()), "hooked.jsonl");
  const payload = JSON.parse(readFileSync(join(dir, "hook-claude.json"), "utf8"));
  await hook(JSON.stringify({ ...payload, session_id: "hooked", transcript_path: transcript }));

  appendFileSync(
    claudePath(),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-07T12:00:00Z", message: { content: "again" } })}\n`,
  );

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const record = {
    type: "user",
    cwd: "/tmp/sessions-fixture/checkout/Alpha",
    timestamp: "2026-11-07T13:00:00Z",
    message: { content: "hello" },
  };

  writeFileSync(transcript, `${JSON.stringify(record)}\n`);
  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const hooked = (await list()).find((line) => line[1] === "hooked")!;
  expect(hooked.slice(2, 4)).toEqual(["Alpha", "001"]);
});

test("CLAUDE_CONFIG_DIR and CODEX_HOME move where the hook and the scan look", async () => {
  const claudeHome = join(temporary, "claude-config");
  const codexHome = join(temporary, "codex-home");
  renameSync(join(dir, "home/.claude"), claudeHome);
  renameSync(join(dir, "home/.codex"), codexHome);
  env = { ...env, CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome };

  const transcript = join(
    codexHome,
    "sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-fixture.jsonl",
  );

  await hook(
    JSON.stringify({
      session_id: "codex-fixture",
      transcript_path: transcript,
      cwd: join(dir, "checkout/Alpha"),
    }),
  );

  expect(await scan()).toBe("scanned 2 transcripts, 2 changed\n");

  const lines = await list();
  expect(lines.map((line) => line.slice(0, 3)).sort()).toEqual([
    ["claude", "claude-fixture", "-"],
    ["codex", "codex-fixture", "Alpha"],
  ]);
});

test("sessions policy prints the default, records a change once and refuses bad input", async () => {
  await hook(readFileSync(join(dir, "hook-claude.json"), "utf8"));

  expect(await policy("Alpha")).toEqual({
    code: 0,
    stdout: "Alpha redacted (default)\n",
    stderr: "",
  });

  expect(await policy("Alpha", "stats")).toEqual({ code: 0, stdout: "Alpha stats\n", stderr: "" });
  expect(await policy("Alpha", "stats")).toEqual({ code: 0, stdout: "Alpha stats\n", stderr: "" });
  expect((await policy("Alpha")).stdout).toBe("Alpha stats\n");
  expect(count("SELECT count(*) AS n FROM events WHERE type = 'policy'")).toBe(1);
  expect((await list("Alpha"))[0]!.at(-1)).toBe("stats");

  const loud = await policy("Alpha", "loud");
  expect(loud.code).toBe(2);
  expect(loud.stderr).toContain("off, stats, redacted, full");

  for (const project of ["Nowhere", "alpha", "-", ".."]) {
    const refused = await policy(project, "stats");
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(`no project ${project} in`);
  }

  expect((await policy("alpha")).stderr).toContain("did you mean Alpha");
  expect((await policy()).code).toBe(2);
  expect((await policy("Alpha", "off", "extra")).code).toBe(2);
  expect(count("SELECT count(*) AS n FROM events WHERE type = 'policy'")).toBe(1);

  const log = join(dir, "plans/log.tsv");
  expect(existsSync(log) ? readFileSync(log, "utf8") : "").not.toContain("policy");
});

test("off withholds the hook and the scan until a looser policy records again", async () => {
  const payload = readFileSync(join(dir, "hook-claude.json"), "utf8");
  await hook(payload);
  await scan();

  const before = recorded();
  expect((await policy("Alpha", "off")).stdout).toBe("Alpha off\n");

  await hook(payload.replace("startup", "resume"));
  await hook(payload.replaceAll("claude-fixture", "claude-fresh"));
  appendFileSync(
    claudePath(),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-07T12:00:00Z", message: { content: "again" } })}\n`,
  );

  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");
  expect(recorded()).toBe(before);
  expect(await list("Alpha")).toEqual([]);

  const [codex, ...rest] = await list();
  expect(rest).toEqual([]);
  expect([codex![1], codex![2], codex!.at(-1)]).toEqual(["codex-fixture", "-", "off"]);

  await policy("Alpha", "redacted");
  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");
  expect(recorded()).toBe(before + 1);

  const [claude, ...others] = await list("Alpha");
  expect(others).toEqual([]);
  expect([claude![1], claude![7], claude!.at(-1)]).toEqual([
    "claude-fixture",
    "2026-11-07T12:00:00Z",
    "redacted",
  ]);
});

test("a session takes the strictest policy of every project it was linked to", async () => {
  await scan();
  await policy("Alpha", "full");
  await hook(readFileSync(join(dir, "hook-claude.json"), "utf8"));

  const claude = (await list("Alpha")).find((line) => line[1] === "claude-fixture")!;
  expect(claude.at(-1)).toBe("off");

  await hook(
    readFileSync(join(dir, "hook-codex.json"), "utf8").replaceAll("codex-fixture", "codex-new"),
  );

  const fresh = (await list("Alpha")).find((line) => line[1] === "codex-new")!;
  expect(fresh.at(-1)).toBe("full");
});

test("a policy event with a malformed payload reads as no policy", async () => {
  await policy("Alpha", "off");

  const db = new Database(join(dir, "plans/plans.db"));
  try {
    db.run("UPDATE events SET payload = 'null' WHERE type = 'policy'");
  } finally {
    db.close();
  }

  expect((await policy("Alpha")).stdout).toBe("Alpha redacted (default)\n");
  expect((await policy("Alpha", "stats")).stdout).toBe("Alpha stats\n");
  expect((await policy("Alpha")).stdout).toBe("Alpha stats\n");
});

test("a session resumed into a project set off stops recording under its first project too", async () => {
  const payload = readFileSync(join(dir, "hook-claude.json"), "utf8");
  await hook(payload);
  await scan();

  mkdirSync(join(dir, "plans/Beta"));
  writeFileSync(
    join(dir, "plans/Beta/index.tsv"),
    readFileSync(join(dir, "plans/Alpha/index.tsv"), "utf8").split("\n")[0] + "\n",
  );

  const beta = join(dir, "checkout/Beta");
  const init = await runCommand(["git", "init", "-q", "-b", "feat/two", beta], { cwd: dir });
  expect(init.code).toBe(0);

  await policy("Beta", "off");
  await hook(payload.replaceAll(join(dir, "checkout/Alpha"), beta).replace("startup", "resume"));

  const before = recorded();
  appendFileSync(
    claudePath(),
    `${JSON.stringify({ type: "user", timestamp: "2026-11-07T12:00:00Z", message: { content: "again" } })}\n`,
  );

  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");
  expect(recorded()).toBe(before);
  expect(await list("Alpha")).toEqual([]);

  await hook(payload.replace("startup", "resume"));
  expect(recorded()).toBe(before);

  await policy("Beta", "stats");
  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const [claude] = await list("Alpha");
  expect([claude![1], claude![7], claude!.at(-1)]).toEqual([
    "claude-fixture",
    "2026-11-07T12:00:00Z",
    "stats",
  ]);
});

test("a quarantined session event in a project set off silences nothing", async () => {
  const payload = readFileSync(join(dir, "hook-claude.json"), "utf8");
  await hook(payload);
  await scan();
  await hook(payload.replace("startup", "resume"));

  const db = new Database(join(dir, "plans/plans.db"));
  try {
    db.run(
      `UPDATE events SET project = 'Gamma', quarantined = 'revoked'
       WHERE type = 'session' AND json_extract(payload, '$.source') = 'resume'`,
    );
  } finally {
    db.close();
  }

  mkdirSync(join(dir, "plans/Gamma"));
  await policy("Gamma", "off");

  const [claude] = (await list("Alpha")).filter((line) => line[1] === "claude-fixture");
  expect(claude!.at(-1)).toBe("redacted");
});

test("a session the scan withheld for a project set off stays withheld when resumed elsewhere", async () => {
  const transcript = join(dirname(claudePath()), "scanned.jsonl");
  const alpha = join(dir, "checkout/Alpha");
  writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", cwd: alpha, timestamp: "2026-11-07T13:00:00Z", message: { content: "hi" } })}\n`,
  );

  await policy("Alpha", "off");
  await scan();

  mkdirSync(join(dir, "plans/Beta"));
  const beta = join(dir, "checkout/Beta");
  const init = await runCommand(["git", "init", "-q", "-b", "feat/two", beta], { cwd: dir });
  expect(init.code).toBe(0);

  const payload = JSON.parse(readFileSync(join(dir, "hook-claude.json"), "utf8"));
  await hook(
    JSON.stringify({ ...payload, session_id: "scanned", transcript_path: transcript, cwd: beta }),
  );

  expect(count("SELECT count(*) AS n FROM events WHERE payload LIKE '%\"scanned\"%'")).toBe(0);
  expect((await list()).filter((line) => line[1] === "scanned")).toEqual([]);
});

test("a silenced transcript is not read again until its policy loosens", async () => {
  await scan();
  rmSync(subagentPath());
  await policy("Alpha", "off");
  await hook(
    readFileSync(join(dir, "hook-codex.json"), "utf8").replaceAll("codex-fixture", "codex-parent"),
  );

  const alpha = join(dir, "checkout/Alpha");
  const fresh = join(dirname(claudePath()), "fresh.jsonl");
  const said = (at: string) => ({
    type: "user",
    cwd: alpha,
    sessionId: "fresh",
    timestamp: at,
    message: { content: "hi" },
  });

  writeFileSync(fresh, `${JSON.stringify(said("2026-11-07T13:00:00Z"))}\n`);

  const child = codexPath().replace("10-00-00-codex-fixture", "11-00-00-child-thread");
  const meta = {
    timestamp: "2026-11-07T11:00:00Z",
    type: "session_meta",
    payload: {
      id: "child-thread",
      session_id: "codex-parent",
      parent_thread_id: "codex-parent",
      source: { subagent: "review" },
      cwd: alpha,
    },
  };

  const tokens = (input: number, output: number) => ({
    timestamp: "2026-11-07T11:00:05Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: input,
          output_tokens: output,
          total_tokens: input + output,
        },
      },
    },
  });

  writeFileSync(child, `${JSON.stringify(meta)}\n${JSON.stringify(tokens(400, 50))}\n`);

  expect(await scan()).toBe("scanned 1 transcripts, 0 changed\n");
  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");

  appendFileSync(fresh, `${JSON.stringify(said("2026-11-07T14:00:00Z"))}\n`);
  appendFileSync(child, `${JSON.stringify(tokens(800, 100))}\n`);
  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");

  chmodSync(fresh, 0o000);
  expect(await scan()).toBe("scanned 0 transcripts, 0 changed\n");
  chmodSync(fresh, 0o644);
  expect(recorded()).toBe(0);

  await policy("Alpha", "redacted");
  expect(await scan()).toBe("scanned 2 transcripts, 2 changed\n");

  const lines = (await list("Alpha")).sort((left, right) => (left[1]! < right[1]! ? -1 : 1));
  expect(lines.map((line) => [line[0], line[1], line[6], line[7], line[9]])).toEqual([
    ["codex", "codex-parent", "2026-11-07T11:00:00Z", "2026-11-07T11:00:05Z", "900"],
    ["claude", "fresh", "2026-11-07T13:00:00Z", "2026-11-07T14:00:00Z", "0"],
  ]);
});

function scannedPaths(): string[] {
  const db = new Database(join(dir, "plans/sessions-scan.db"), { readonly: true });
  try {
    return (db.query("SELECT path FROM files ORDER BY path").all() as { path: string }[]).map(
      (row) => row.path,
    );
  } finally {
    db.close();
  }
}

function generationOf(path: string): number {
  const db = new Database(join(dir, "plans/sessions-scan.db"), { readonly: true });
  try {
    const row = db.query("SELECT state FROM files WHERE path = ?").get(path) as { state: string };
    return (JSON.parse(row.state) as { generation?: number }).generation ?? 0;
  } finally {
    db.close();
  }
}

const statsEvents = () => count("SELECT count(*) AS n FROM events WHERE type = 'session-stats'");

async function tokensOf(session: string): Promise<number> {
  return Number((await list()).find((line) => line[1] === session)![9]);
}

function assistant(id: string, input: number, output: number): string {
  const record = {
    type: "assistant",
    sessionId: "claude-fixture",
    timestamp: "2026-11-07T14:00:00Z",
    message: {
      id,
      model: "claude-opus-5-5",
      content: [{ type: "text", text: "after" }],
      usage: { input_tokens: input, output_tokens: output },
    },
  };

  return `${JSON.stringify(record)}\n`;
}

test("a scan after a moved project folder reads only what was appended", async () => {
  await scan();

  const from = dirname(claudePath());
  const to = join(dirname(from), "-tmp-sessions-fixture-checkout-Renamed");
  renameSync(from, to);

  const main = join(to, "claude-fixture.jsonl");
  const agent = join(to, "claude-fixture/subagents/agent-one.jsonl");
  const events = statsEvents();

  expect(await scan()).toEndWith(", 0 changed\n");
  expect(statsEvents()).toBe(events);
  expect(await tokensOf("claude-fixture")).toBe(claudeTokens(main) + claudeTokens(agent));
  expect(scannedPaths().filter((path) => path.startsWith(`${from}/`))).toEqual([]);
  expect([generationOf(main), generationOf(agent)]).toEqual([0, 0]);

  const before = await tokensOf("claude-fixture");
  appendFileSync(main, assistant("msg_moved", 11, 13));

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");
  expect(await tokensOf("claude-fixture")).toBe(before + 24);
});

test("a scan after a moved CODEX_HOME reads the rollout once", async () => {
  await scan();

  const codexHome = join(temporary, "codex-home");
  renameSync(join(dir, "home/.codex"), codexHome);
  env = { ...env, CODEX_HOME: codexHome };

  const rollout = join(
    codexHome,
    "sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-fixture.jsonl",
  );

  expect(await scan()).toEndWith(", 0 changed\n");
  expect(await tokensOf("codex-fixture")).toBe(codexTokens(rollout));
  expect(scannedPaths().filter((path) => path.endsWith("-codex-fixture.jsonl"))).toEqual([rollout]);
});

test("a moved transcript whose first line changed is read from zero once", async () => {
  await scan();

  const from = dirname(claudePath());
  const to = join(dirname(from), "-tmp-sessions-fixture-checkout-Renamed");
  renameSync(from, to);

  const main = join(to, "claude-fixture.jsonl");
  const [first, ...rest] = readFileSync(main, "utf8").split("\n");
  const renamed = JSON.stringify({ ...JSON.parse(first!), summary: "Renamed session" });
  const body = rest.join("\n").replace('"input_tokens":30,', '"input_tokens":1030,');
  writeFileSync(main, `${renamed}\n${body}`);

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");

  const agent = join(to, "claude-fixture/subagents/agent-one.jsonl");
  expect(await tokensOf("claude-fixture")).toBe(claudeTokens(main) + claudeTokens(agent));
  expect(generationOf(main)).toBe(1);
  expect(scannedPaths().filter((path) => path.startsWith(`${from}/`))).toEqual([]);
});

test("a deleted transcript that recorded no session id keeps counting", async () => {
  const alpha = "/tmp/sessions-fixture/checkout/Alpha";
  const usage = (input: number, output: number, extra: Record<string, unknown>) =>
    `${JSON.stringify({
      ...extra,
      type: "assistant",
      cwd: alpha,
      timestamp: "2026-11-07T15:00:00Z",
      message: { model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: output } },
    })}\n`;

  const ghost = join(dirname(claudePath()), "ghost.jsonl");
  writeFileSync(ghost, usage(5, 7, {}));
  await scan();
  rmSync(ghost);

  const elsewhere = join(dirname(dirname(claudePath())), "-tmp-elsewhere");
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, "ghost.jsonl"), usage(100, 200, { sessionId: "ghost" }));

  await scan();
  expect(await tokensOf("ghost")).toBe(12 + 300);
});

test("a deleted subagent transcript still counts toward its session", async () => {
  await scan();

  const agent = claudeTokens(subagentPath());
  rmSync(subagentPath());
  appendFileSync(claudePath(), assistant("msg_after", 5, 7));

  expect(await scan()).toBe("scanned 1 transcripts, 1 changed\n");
  expect(await tokensOf("claude-fixture")).toBe(claudeTokens(claudePath()) + agent);
});
