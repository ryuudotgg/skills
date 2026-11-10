import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COLUMNS,
  HEARTBEAT,
  LOG_HEADER,
  POLICY_EVENT,
  secondStamp,
  SESSION_EVENT,
} from "skills-core";
import { importStore } from "../plans/import.ts";
import { appendEvent, openStore, projectPulses, write } from "../plans/store.ts";
import { fixtureGit } from "../test/fixtures.ts";
import { suiteEnvironment } from "../test/process.ts";
import { beat } from "./heartbeat.ts";

setDefaultTimeout(60_000);

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

type Fixture = { home: string; root: string; repo: string; state: string; env: NodeJS.ProcessEnv };

async function fixture(): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), "skills-heartbeat-"));
  temporary.push(home);

  const root = join(home, "Plans");
  mkdirSync(join(root, "Demo", "done"), { recursive: true });

  const row = ["001", "beat", "DOING", "P2", "S", "-", "-", "feat/beat", "2026-11-10", "-"];
  writeFileSync(join(root, "Demo", "index.tsv"), `${COLUMNS.join("\t")}\n${row.join("\t")}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);

  const env: NodeJS.ProcessEnv = { ...suiteEnvironment(), HOME: home, PLANS_DIR: root };
  await importStore(env);

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

  expect(beat(payload(fix, "one"), fix.env)).toBe("written");
  expect(beat(payload(fix, "one"), fix.env)).toBeUndefined();
  expect(beat(payload(fix, "two"), fix.env)).toBe("written");
  expect(beat(payload(fix), fix.env)).toBe("written");

  expect(heartbeats(fix.root)).toEqual([
    { branch: "feat/beat", environment: null, session: "one" },
    { branch: "feat/beat", environment: null, session: "two" },
    { branch: "feat/beat", environment: null },
  ]);

  expect(readFileSync(join(fix.root, "log.tsv"), "utf8")).toBe(LOG_HEADER);

  rmSync(join(fix.state, "heartbeat-one.json"));
  expect(beat(payload(fix, "one"), fix.env)).toBe("idle");
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

  expect(beat(payload(fix, "secret"), fix.env)).toBe("written");
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

  const other = join(fix.home, "other");
  mkdirSync(other);

  expect(beat(payload(fix), fix.env)).toBe("written");
  expect(beat(payload(fix, undefined, other), fix.env)).toBe("idle");
  expect(beat(payload(fix), fix.env)).toBeUndefined();

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

  expect(beat({ ...payload(fix, "stuck"), scratchpad_dir: join(blocked, "state") }, fix.env)).toBe(
    undefined,
  );

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

  expect(beat(payload(fix, "quiet"), fix.env)).toBe("written");
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
  expect(beat(payload(fix, "main"), fix.env)).toBe("idle");

  await fixtureGit(fix.repo, ["branch", "-q", "-m", "main", "master"]);
  writeFileSync(
    join(fix.root, "Demo", "index.tsv"),
    readFileSync(join(fix.root, "Demo", "index.tsv"), "utf8").replace("\tmain\t", "\tmaster\t"),
  );

  expect(beat(payload(fix, "master"), fix.env)).toBe("idle");

  const outside = join(fix.home, "outside");
  mkdirSync(outside);
  expect(beat(payload(fix, "outside", outside), fix.env)).toBe("idle");

  expect(readFileSync(join(fix.root, "plans.db"))).toEqual(Buffer.from(garbage));
  expect(existsSync(join(fix.root, "plans.db-wal"))).toBe(false);

  await fixtureGit(fix.repo, ["checkout", "-q", "feat/beat"]);
  expect(beat(payload(fix, "branch"), fix.env)).toBe("busy");
});

test("a busy store skips the heartbeat and retries on the next tool call", async () => {
  const fix = await fixture();
  const holder = new Database(join(fix.root, "plans.db"));
  holder.run("BEGIN IMMEDIATE");

  const started = performance.now();
  expect(beat(payload(fix, "held"), fix.env)).toBe("busy");
  expect(performance.now() - started).toBeLessThan(2000);
  expect(existsSync(join(fix.state, "heartbeat-held.json"))).toBe(false);

  holder.run("ROLLBACK");
  holder.close();

  expect(beat(payload(fix, "held"), fix.env)).toBe("written");
  expect(heartbeats(fix.root)).toHaveLength(1);
});
