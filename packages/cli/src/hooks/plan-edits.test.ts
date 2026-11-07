import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { createPlugin } from "../../../../skills/playbook/opencode/plugin.ts";
import { importStore } from "../plans/import.ts";
import { recordWorkingCopies } from "../plans/commit.ts";
import {
  latestRevision,
  openStore,
  recordRevision,
  sha256,
  SPOOL,
  spoolRevision,
} from "../plans/store.ts";
import { suiteEnvironment } from "../test/process.ts";

setDefaultTimeout(60_000);

const cli = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
const temporary: string[] = [];
const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Fixture = { root: string; env: NodeJS.ProcessEnv; plan: string; elsewhere: string };

async function fixture(withStore = true): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "skills-plan-edits-"));
  temporary.push(home);

  const root = join(home, "Plans");
  mkdirSync(join(root, "Skills", "done"), { recursive: true });
  mkdirSync(join(root, "Skills", "evidence"), { recursive: true });

  const row = ["007", "seven", "TODO", "P1", "S", "-", "-", "-", "2026-10-31", "-"].join("\t");
  writeFileSync(join(root, "Skills", "index.tsv"), `${COLUMNS.join("\t")}\n${row}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  const plan = join(root, "Skills", "007-seven.md");
  writeFileSync(plan, "# 007 seven\n");

  mkdirSync(join(home, "repo"));
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    HOME: home,
    PLANS_DIR: root,
    AGENT_HOOKS: "1",
  };

  delete env.AGENT_HOOKS_SKIP;

  if (withStore) await importStore(env);

  return { root, env, plan, elsewhere: join(home, "repo") };
}

async function hook(payload: object, env: NodeJS.ProcessEnv) {
  const started = performance.now();
  const child = Bun.spawn([cli, "hook", "post-tool-use"], {
    env,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, stdout, elapsed: performance.now() - started };
}

async function history(env: NodeJS.ProcessEnv): Promise<string[][]> {
  const child = Bun.spawn([cli, "plans", "history", "Skills", "007"], { env, stdout: "pipe" });
  const [code, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

  expect(code).toBe(0);
  return stdout
    .trim()
    .split("\n")
    .map((line) => line.split("\t"));
}

type Host = { name: string; edit: (path: string, text: string, cwd: string) => Promise<void> };

function claude(tool: "Edit" | "Write" | "MultiEdit", env: NodeJS.ProcessEnv): Host {
  return {
    name: `Claude Code ${tool}`,
    async edit(path, text, cwd) {
      writeFileSync(path, text);
      const input =
        tool === "Edit"
          ? { file_path: path, old_string: "x", new_string: text }
          : tool === "Write"
            ? { file_path: path, content: text }
            : { file_path: path, edits: [{ old_string: "x", new_string: text }] };

      const result = await hook({ tool_name: tool, tool_input: input, cwd }, env);
      expect(result.code).toBe(0);
    },
  };
}

function patch(path: string, text: string): string {
  return `*** Begin Patch\n*** Add File: ${path}\n+${text.trimEnd()}\n*** End Patch`;
}

function codex(through: "apply_patch" | "Bash", env: NodeJS.ProcessEnv): Host {
  return {
    name: `Codex ${through}`,
    async edit(path, text, cwd) {
      writeFileSync(path, text);
      const command =
        through === "apply_patch"
          ? patch(path, text)
          : `apply_patch <<'EOF'\n${patch(path, text)}\nEOF`;

      const result = await hook({ tool_name: through, tool_input: { command }, cwd }, env);
      expect(result.code).toBe(0);
    },
  };
}

type Callback = (event: object) => Promise<void>;

async function opencode(tool: "edit" | "write" | "patch", env: NodeJS.ProcessEnv): Promise<Host> {
  const hooks = new Map<string, Callback>();
  const context = {
    location: { directory: env.HOME! },
    tool: { hook: async (name: string, callback: Callback) => void hooks.set(name, callback) },
    session: {
      hook: async () => {},
      get: async () => ({}),
      context: async () => [],
      prompt: async () => {},
    },
    event: { subscribe: () => ({ async *[Symbol.asyncIterator]() {} }) },
  };

  const cleanup = await createPlugin({ env }).setup(
    context as unknown as Parameters<ReturnType<typeof createPlugin>["setup"]>[0],
  );

  cleanups.push(cleanup);

  const inputs = {
    edit: (path: string, text: string) => ({ path, oldString: "x", newString: text }),
    write: (path: string, text: string) => ({ path, content: text }),
    patch: (path: string, text: string) => ({ patchText: patch(path, text) }),
  };

  return {
    name: `OpenCode ${tool}`,
    async edit(path, text) {
      writeFileSync(path, text);
      await hooks.get("execute.after")!({
        tool,
        input: inputs[tool](path, text),
        status: "completed",
        result: { output: "" },
      });
    },
  };
}

async function hosts(env: NodeJS.ProcessEnv): Promise<Host[]> {
  return [
    claude("Edit", env),
    claude("Write", env),
    claude("MultiEdit", env),
    codex("apply_patch", env),
    codex("Bash", env),
    await opencode("edit", env),
    await opencode("write", env),
    await opencode("patch", env),
  ];
}

test("every guarded edit of a plan file adds one revision in each host", async () => {
  const { env, plan, root } = await fixture();
  const texts: string[] = [];
  for (const host of await hosts(env)) {
    const text = `# 007 seven, edited through ${host.name}\n`;
    await host.edit(plan, text, root);
    texts.push(text);

    expect((await history(env)).length, host.name).toBe(texts.length + 1);
  }

  const lines = await history(env);
  expect(lines.slice(1).map((line) => line[1])).toEqual(texts.map((text) => sha256(text)));
});

test("edits outside plan and ctx files open no store and record nothing", async () => {
  const { env, root, elsewhere } = await fixture(false);
  const targets = [
    join(elsewhere, "007-seven.md"),
    join(root, "Skills", "evidence", "007-seven.md"),
    join(root, "Skills", "notes.md"),
    join(root, ".hidden", "ctx-batch.md"),
  ];

  for (const target of targets) mkdirSync(join(target, ".."), { recursive: true });

  for (const host of await hosts(env))
    for (const target of targets) await host.edit(target, `# ${host.name}\n`, elsewhere);

  expect(existsSync(join(root, "plans.db"))).toBe(false);
  expect(existsSync(join(root, SPOOL))).toBe(false);
});

test("a busy store spools each edit fast, and the next open records them in order", async () => {
  const { env, plan, root } = await fixture();
  const holder = new Database(join(root, "plans.db"));
  holder.run("BEGIN IMMEDIATE");

  const texts = ["# 007 seven, first spooled edit\n", "# 007 seven, second spooled edit\n"];
  for (const text of texts) {
    writeFileSync(plan, text);
    const result = await hook(
      { tool_name: "Write", tool_input: { file_path: plan, content: text }, cwd: root },
      env,
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.elapsed).toBeLessThan(500);
  }

  expect(readdirSync(join(root, SPOOL)).filter((name) => name.endsWith(".json"))).toHaveLength(2);

  holder.run("ROLLBACK");
  holder.close();

  const lines = await history(env);
  expect(lines.slice(1).map((line) => line[1])).toEqual(texts.map((text) => sha256(text)));
  expect(lines[1]![0]! < lines[2]![0]!).toBe(true);
  expect(readdirSync(join(root, SPOOL))).toEqual([]);
});

test("a spooled entry whose bytes a verb already recorded adds nothing", async () => {
  const { env, plan, root } = await fixture();
  const text = "# 007 seven, edited\n";
  writeFileSync(plan, text);
  await recordWorkingCopies(root, [plan]);

  const before = await history(env);
  spoolRevision(
    root,
    join("Skills", "007-seven.md"),
    Buffer.from(text),
    "2000-01-01T00:00:00.000Z",
  );

  expect(await history(env)).toEqual(before);
  expect(readdirSync(join(root, SPOOL))).toEqual([]);
});

test("a spool folder that refuses deletes leaves the store readable", async () => {
  const { env, root } = await fixture();
  const folder = join(root, SPOOL);
  const text = "# 007 seven, spooled\n";

  spoolRevision(root, join("Skills", "007-seven.md"), Buffer.from(text), new Date().toISOString());
  chmodSync(folder, 0o555);
  cleanups.push(() => chmodSync(folder, 0o755));

  const first = await history(env);
  expect(first.at(-1)?.[1]).toBe(sha256(text));
  expect(await history(env)).toEqual(first);
});

test("an edit back to the stored text after a spooled edit stays newest", async () => {
  const { env, plan, root } = await fixture();
  const original = "# 007 seven\n";
  const write = (text: string) =>
    hook({ tool_name: "Write", tool_input: { file_path: plan, content: text }, cwd: root }, env);

  const holder = new Database(join(root, "plans.db"));
  holder.run("BEGIN IMMEDIATE");

  writeFileSync(plan, "# 007 seven, spooled\n");
  await write("");

  holder.run("ROLLBACK");
  holder.close();

  writeFileSync(plan, original);
  await write("");

  const lines = await history(env);
  expect(lines.map((line) => line[1])).toEqual(
    [original, "# 007 seven, spooled\n", original].map((text) => sha256(text)),
  );
});

test("a hook edit records past a spool folder that refuses deletes", async () => {
  const { env, plan, root } = await fixture();
  const folder = join(root, SPOOL);
  const key = join("Skills", "007-seven.md");

  spoolRevision(root, key, Buffer.from("# 007 seven, spooled\n"), new Date().toISOString());
  chmodSync(folder, 0o555);
  cleanups.push(() => chmodSync(folder, 0o755));

  const text = "# 007 seven, after the spool\n";
  writeFileSync(plan, text);
  await hook({ tool_name: "Write", tool_input: { file_path: plan, content: "" }, cwd: root }, env);

  expect((await history(env)).at(-1)?.[1]).toBe(sha256(text));
});

test("a revision captured under an earlier clock is still the newest", async () => {
  const { root } = await fixture();
  const key = join("Skills", "007-seven.md");
  const store = openStore(join(root, "plans.db"));

  recordRevision(store, "Skills", key, Buffer.from("a"), sha256("a"), "2030-01-01T00:00:00.000Z");
  recordRevision(store, "Skills", key, Buffer.from("b"), sha256("b"), "2020-01-01T00:00:00.000Z");

  expect(latestRevision(store, key)).toBe(sha256("b"));
  store.db.close();
});

test("an edit spooled before the first import keeps its capture time", async () => {
  const { env, plan, root } = await fixture(false);
  const text = "# 007 seven, before the store\n";

  writeFileSync(plan, text);
  await hook({ tool_name: "Write", tool_input: { file_path: plan, content: "" }, cwd: root }, env);

  const [file] = readdirSync(join(root, SPOOL));
  const { captured } = JSON.parse(readFileSync(join(root, SPOOL, file!), "utf8")) as {
    captured: string;
  };

  expect(await history(env)).toEqual([
    [captured, sha256(text), expect.any(String), String(text.length)],
  ]);

  expect(readdirSync(join(root, SPOOL))).toEqual([]);
});

test("a spooled edit older than the newest revision does not replace it", async () => {
  const { env, plan, root } = await fixture();
  const newer = "# 007 seven, saved later\n";
  const earlier = new Date(Date.now() - 60_000).toISOString();

  writeFileSync(plan, newer);
  await recordWorkingCopies(root, [plan]);
  spoolRevision(
    root,
    join("Skills", "007-seven.md"),
    Buffer.from("# 007 seven, queued\n"),
    earlier,
  );

  const lines = await history(env);
  expect(lines.map((line) => line[1])).toEqual([sha256("# 007 seven\n"), sha256(newer)]);
  expect(readdirSync(join(root, SPOOL))).toEqual([]);
});
