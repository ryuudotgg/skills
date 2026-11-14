import { afterEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  COLUMNS,
  HEARTBEAT,
  LOG_HEADER,
  POLICY_EVENT,
  secondStamp,
  SESSION_EVENT,
} from "skills-core";
import { importStore } from "../plans/import.ts";
import * as store from "../plans/store.ts";
import { appendEvent, openStore, projectPulses, sha256, write } from "../plans/store.ts";
import { fixtureGit } from "../test/fixtures.ts";
import { settleViews, viewsDeleted } from "../test/plans-views.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { beat } from "./heartbeat.ts";

setDefaultTimeout(60_000);

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Fixture = { home: string; root: string; repo: string; state: string; env: NodeJS.ProcessEnv };

async function fixture(status = "DOING"): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "skills-heartbeat-"));
  temporary.push(home);

  const root = join(home, "Plans");
  mkdirSync(join(root, "Demo", "done"), { recursive: true });

  const row = ["001", "beat", status, "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"];
  writeFileSync(join(root, "Demo", "index.tsv"), `${COLUMNS.join("\t")}\n${row.join("\t")}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  const env: NodeJS.ProcessEnv = { ...suiteEnvironment(), HOME: home, PLANS_DIR: root };
  await importStore(env);
  await settleViews(env);

  const repo = join(home, "Demo");
  mkdirSync(repo);
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);

  await fixtureGit(repo, ["checkout", "-q", "-b", "feat/beat"]);

  return { home, root, repo, state: join(home, "state"), env };
}

function payload(fixture: Fixture, session?: string, cwd = fixture.repo): Record<string, unknown> {
  return { cwd, scratchpad_dir: fixture.state, ...(session ? { session_id: session } : {}) };
}

function heartbeats(root: string): Record<string, unknown>[] {
  const db = new Database(join(root, "plans.db"), { readonly: true });
  try {
    const rows = db
      .query("SELECT payload FROM events WHERE type = 'heartbeat' ORDER BY seq")
      .all() as { payload: string }[];

    return rows.map((row) => JSON.parse(row.payload) as Record<string, unknown>);
  } finally {
    db.close();
  }
}

test("a DOING row's branch gets one heartbeat per session every five minutes, never in the trail", async () => {
  const fix = await fixture();

  expect(await beat(payload(fix, "one"), fix.env)).toBe("written");
  expect(await beat(payload(fix, "one"), fix.env)).toBeUndefined();
  expect(await beat(payload(fix, "two"), fix.env)).toBe("written");
  expect(await beat(payload(fix), fix.env)).toBe("written");

  expect(heartbeats(fix.root)).toEqual([
    { branch: "feat/beat", environment: null, session: "one" },
    { branch: "feat/beat", environment: null, session: "two" },
    { branch: "feat/beat", environment: null },
  ]);

  const trail = join(fix.root, "log.tsv");
  expect(existsSync(trail) ? readFileSync(trail, "utf8") : undefined).toBe(
    viewsDeleted ? undefined : LOG_HEADER,
  );

  rmSync(join(fix.state, "heartbeat-one.json"));
  expect(await beat(payload(fix, "one"), fix.env)).toBe("idle");
  expect(heartbeats(fix.root)).toHaveLength(3);
});

function append(root: string, draft: Parameters<typeof appendEvent>[1]): void {
  const store = openStore(join(root, "plans.db"));
  try {
    write(store, () => appendEvent(store, draft));
  } finally {
    store.db.close();
  }
}

test("a session withheld under an off project stays out of a heartbeat elsewhere", async () => {
  const fix = await fixture();
  const at = Date.now();
  append(fix.root, {
    kind: "stored",
    type: POLICY_EVENT,
    at,
    project: "Other",
    plan: "-",
    payload: { policy: "off" },
  });

  append(fix.root, {
    kind: "stored",
    type: SESSION_EVENT,
    at,
    project: "Other",
    plan: "-",
    payload: {
      host: "claude",
      session: "secret",
      branch: "-",
      plans: [],
      source: "-",
      started: secondStamp(at),
    },
  });

  expect(await beat(payload(fix, "secret"), fix.env)).toBe("written");
  expect(heartbeats(fix.root)).toEqual([{ branch: "feat/beat", environment: null }]);
});

test("every DOING row on the branch beats, and anonymous checkouts throttle apart", async () => {
  const fix = await fixture();
  const rows = [
    ["001", "beat", "DOING", "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"],
    ["002", "also", "DOING", "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"],
  ];

  writeFileSync(
    join(fix.root, "Demo", "index.tsv"),
    `${COLUMNS.join("\t")}\n${rows.map((row) => row.join("\t")).join("\n")}\n`,
  );

  await importStore(fix.env);
  await settleViews(fix.env);

  const other = join(fix.home, "other");
  mkdirSync(other);

  expect(await beat(payload(fix), fix.env)).toBe("written");
  const anonymous = `heartbeat-anon-${sha256(resolve(fix.repo)).slice(0, 16)}.json`;
  expect(existsSync(join(fix.state, anonymous))).toBe(true);
  expect(await beat(payload(fix, undefined, other), fix.env)).toBe("idle");
  expect(await beat(payload(fix), fix.env)).toBeUndefined();

  const db = new Database(join(fix.root, "plans.db"), { readonly: true });
  try {
    expect(
      db.query("SELECT plan FROM events WHERE type = 'heartbeat' ORDER BY plan").all(),
    ).toEqual([{ plan: "001" }, { plan: "002" }]);
  } finally {
    db.close();
  }
});

test("a throttle that cannot be written records no heartbeat", async () => {
  const fix = await fixture();
  const blocked = join(fix.home, "file");
  writeFileSync(blocked, "");

  expect(
    await beat({ ...payload(fix, "stuck"), scratchpad_dir: join(blocked, "state") }, fix.env),
  ).toBe(undefined);

  expect(heartbeats(fix.root)).toEqual([]);
});

test("stale age reads each event's own time, not a clock pushed ahead", async () => {
  const fix = await fixture();
  const store = openStore(join(fix.root, "plans.db"));
  try {
    const at = Date.parse("2026-11-10T10:00:00Z");
    write(store, () => {
      store.clock = { wall: at + 3_600_000, counter: 0 };
      appendEvent(store, {
        kind: "stored",
        type: HEARTBEAT,
        at,
        project: "Demo",
        plan: "001",
        payload: { branch: "feat/beat", environment: null },
      });
    });

    expect(projectPulses(store, "Demo").newest.get("001")?.at).toBe(at);
  } finally {
    store.db.close();
  }
});

test("policy off keeps the session id out of the heartbeat", async () => {
  const fix = await fixture();
  const store = openStore(join(fix.root, "plans.db"));
  try {
    write(store, () =>
      appendEvent(store, {
        kind: "stored",
        type: POLICY_EVENT,
        at: Date.now(),
        project: "Demo",
        plan: "-",
        payload: { policy: "off" },
      }),
    );
  } finally {
    store.db.close();
  }

  expect(await beat(payload(fix, "quiet"), fix.env)).toBe("written");
  expect(heartbeats(fix.root)).toEqual([{ branch: "feat/beat", environment: null }]);
});

test("a hook run on main, or outside a checkout, opens no store", async () => {
  const fix = await fixture();
  const garbage = new TextEncoder().encode("not a database");
  rmSync(join(fix.root, "plans.db-wal"), { force: true });
  rmSync(join(fix.root, "plans.db-shm"), { force: true });
  writeFileSync(join(fix.root, "plans.db"), garbage);

  const rows = [
    ["001", "beat", "DOING", "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"],
    ["002", "trunk", "DOING", "P2", "S", "-", "-", "main", "2026-11-10", "-"],
  ];

  writeFileSync(
    join(fix.root, "Demo", "index.tsv"),
    `${COLUMNS.join("\t")}\n${rows.map((row) => row.join("\t")).join("\n")}\n`,
  );

  await fixtureGit(fix.repo, ["checkout", "-q", "main"]);
  expect(await beat(payload(fix, "main"), fix.env)).toBe("idle");

  await fixtureGit(fix.repo, ["branch", "-q", "-m", "main", "master"]);
  writeFileSync(
    join(fix.root, "Demo", "index.tsv"),
    readFileSync(join(fix.root, "Demo", "index.tsv"), "utf8").replace("\tmain\t", "\tmaster\t"),
  );

  expect(await beat(payload(fix, "master"), fix.env)).toBe("idle");

  const outside = join(fix.home, "outside");
  mkdirSync(outside);
  expect(await beat(payload(fix, "outside", outside), fix.env)).toBe("idle");

  expect(readFileSync(join(fix.root, "plans.db"))).toEqual(Buffer.from(garbage));
  expect(existsSync(join(fix.root, "plans.db-wal"))).toBe(false);

  await fixtureGit(fix.repo, ["checkout", "-q", "feat/beat"]);
  expect(await beat(payload(fix, "branch"), fix.env)).toBe("failed");
  expect(existsSync(join(fix.state, "heartbeat-branch.json"))).toBe(true);
});

test("a busy store skips the heartbeat and retries on the next tool call", async () => {
  const fix = await fixture();
  const holder = new Database(join(fix.root, "plans.db"));
  holder.run("BEGIN IMMEDIATE");

  const started = performance.now();
  expect(await beat(payload(fix, "held"), fix.env)).toBe("busy");
  expect(performance.now() - started).toBeLessThan(2000);
  expect(existsSync(join(fix.state, "heartbeat-held.json"))).toBe(false);

  holder.run("ROLLBACK");
  holder.close();

  expect(await beat(payload(fix, "held"), fix.env)).toBe("written");
  expect(heartbeats(fix.root)).toHaveLength(1);
});

test("hook calls that write nothing load no store", async () => {
  const fix = await fixture();
  mkdirSync(fix.state, { recursive: true });
  writeFileSync(
    join(fix.state, "heartbeat-quiet.json"),
    JSON.stringify({ at: Date.now() - 60_000 }),
  );

  const src = resolve(import.meta.dir, "..");
  const heavy = [
    "plans/store.ts",
    "plans/record.ts",
    "plans/index-tsv.ts",
    "plans/machine.ts",
    "sessions/policy.ts",
    "../../core/src/index.ts",
  ].map((path) => resolve(src, path));

  const light = ["hooks/heartbeat.ts", "hooks/plan-edits.ts", "../../core/src/pulse.ts"].map(
    (path) => resolve(src, path),
  );

  const edit = {
    cwd: fix.repo,
    tool_name: "Edit",
    tool_input: { file_path: join(fix.home, "notes.md"), old_string: "a", new_string: "b" },
  };

  const module = (path: string) => JSON.stringify(join(import.meta.dir, path));
  const program = [
    `import { beat } from ${module("heartbeat.ts")};`,
    `import { recordPlanEdits } from ${module("plan-edits.ts")};`,
    `import ${module("stop.ts")};`,
    `import ${module("post-tool-use.ts")};`,
    `const heavy = ${JSON.stringify(heavy)};`,
    `const loaded = (paths) => paths.filter((path) => path in require.cache);`,
    `const outcome = await beat(${JSON.stringify(payload(fix, "quiet"))}, process.env);`,
    `await recordPlanEdits(${JSON.stringify(edit)}, process.env);`,
    `const before = loaded(heavy);`,
    `await import(${JSON.stringify(heavy[0])});`,
    `const after = loaded(heavy);`,
    `console.log(JSON.stringify({ outcome: String(outcome), light: loaded(${JSON.stringify(light)}), before, after }));`,
  ].join("\n");

  const result = await runCommand([process.execPath, "-e", program], {
    cwd: fix.repo,
    env: fix.env,
    timeout: 30_000,
  });

  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual({
    outcome: "undefined",
    light,
    before: [],
    after: expect.arrayContaining([heavy[0]]),
  });
});

test("a DOING row beats without the view, and a TODO row stays idle", async () => {
  const doing = await fixture();
  rmSync(join(doing.root, "Demo", "index.tsv"), { force: true });

  expect(await beat(payload(doing, "viewless"), doing.env)).toBe("written");

  const db = new Database(join(doing.root, "plans.db"), { readonly: true });
  try {
    expect(db.query("SELECT plan FROM events WHERE type = 'heartbeat'").all()).toEqual([
      { plan: "001" },
    ]);
  } finally {
    db.close();
  }

  const todo = await fixture("TODO");
  rmSync(join(todo.root, "Demo", "index.tsv"), { force: true });

  const holder = new Database(join(todo.root, "plans.db"));
  holder.run("BEGIN IMMEDIATE");
  try {
    expect(await beat(payload(todo, "viewless"), todo.env)).toBe("idle");
  } finally {
    holder.run("ROLLBACK");
    holder.close();
  }

  expect(heartbeats(todo.root)).toEqual([]);
});

test("a view that still says TODO does not stop a DOING row from beating", async () => {
  const fix = await fixture();
  const row = ["001", "beat", "TODO", "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"];
  writeFileSync(join(fix.root, "Demo", "index.tsv"), `${COLUMNS.join("\t")}\n${row.join("\t")}\n`);

  expect(await beat(payload(fix, "lagging"), fix.env)).toBe("written");
  expect(heartbeats(fix.root)).toEqual([
    { branch: "feat/beat", environment: null, session: "lagging" },
  ]);
});

test("a row that leaves DOING before the write lock gets no heartbeat", async () => {
  const fix = await fixture();
  const cli = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
  let raced = 0;
  const spy = spyOn(store, "write").mockImplementation((held, edit) => {
    raced += 1;
    const flip = Bun.spawnSync([cli, "plans", "set-row", "Demo", "001", "TODO"], {
      cwd: fix.home,
      env: fix.env,
    });

    expect(flip.exitCode).toBe(0);
    spy.mockRestore();
    return write(held, edit);
  });

  try {
    expect(await beat(payload(fix, "raced"), fix.env)).toBe("idle");
  } finally {
    spy.mockRestore();
  }

  expect(raced).toBe(1);
  expect(heartbeats(fix.root)).toEqual([]);
});
