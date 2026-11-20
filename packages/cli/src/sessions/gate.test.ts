import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RemoteRecord } from "../plans/sync.ts";
import { envSources, sessionsMachine } from "../test/sessions-fixture.ts";
import { appendEvent, write } from "../plans/store.ts";
import { authorDeletions, pushGate } from "./gate.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

test("stats leave with secrets in model names, efforts and tools redacted, colliding usage summed", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const planted = new Map(
    readFileSync(join(import.meta.dir, "fixture", "secrets.txt"), "utf8")
      .split("\n")
      .map((line) => line.split("\t"))
      .map(([kind, , value]) => [kind ?? "", value ?? ""]),
  );

  const pat = planted.get("github-pat") ?? "";
  const reversed = `ghp_${pat.slice(4).split("").reverse().join("")}`;
  const others = ["openai", "slack", "anthropic"].map((kind) => planted.get(kind) ?? "");
  const secret = (n: number) => [pat, reversed, ...others][n - 1] ?? "";
  const record = {
    type: "session-stats",
    payload: {
      host: "claude",
      session: "claude-fixture",
      models: {
        [secret(1)]: { effort: "high", in: 2, out: 3 },
        [secret(2)]: { effort: secret(3), in: 5, out: 7 },
      },
      tools: {
        ...(JSON.parse('{"__proto__": 9}') as Record<string, number>),
        [secret(1)]: 1,
        [secret(2)]: 2,
        [secret(4)]: 4,
        Bash: 3,
      },
      records: 4,
      start: null,
      end: null,
      subagents: 0,
    },
  } as unknown as RemoteRecord;

  const sent = JSON.stringify(pushGate(m.store, m.plans).outgoing(record).payload);
  const { models, tools } = JSON.parse(sent) as {
    models: Record<string, { in: number; out: number }>;
    tools: Record<string, number>;
  };

  for (const n of [1, 2, 3, 4, 5]) expect(sent).not.toContain(secret(n));
  expect(Object.values(models).map((usage) => [usage.in, usage.out])).toEqual([[7, 10]]);
  expect(Object.values(tools).sort()).toEqual([3, 3, 4, 9]);
});

test("a lowering keeps a digest blob an allowed pending transcript still shares", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const transcript = (session: string, project: string, blob: string) =>
    appendEvent(m.store, {
      kind: "stored",
      type: "transcript",
      at: Date.now(),
      project,
      plan: "-",
      payload: {
        host: "claude",
        session,
        series: 0,
        chunk: 0,
        first: 1,
        last: 1,
        sha256: `${blob}-sha`,
        blob,
        bytes: 1,
        policy: "redacted",
        rules: "-",
        digest: "shared-sha",
        digestBlob: "d".repeat(32),
      },
    });

  write(m.store, () => {
    const sent = transcript("claude-fixture", "Alpha", "a".repeat(32));
    transcript("other", "Beta", "b".repeat(32));
    m.store.db.run("UPDATE events SET author = 'device', sequence = 1 WHERE id = ?", [sent]);
    appendEvent(m.store, {
      kind: "stored",
      type: "policy",
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: { policy: "stats" },
    });
  });

  expect(authorDeletions(m.store, m.plans)).toBe(1);
  expect(
    m.store.db
      .query(
        "SELECT json_extract(payload, '$.blob') AS blob FROM events WHERE type = 'blob-deleted'",
      )
      .all(),
  ).toEqual([{ blob: "a".repeat(32) }]);

  const transaction = spyOn(m.store.db, "transaction");
  cleanup.push(() => transaction.mockRestore());
  expect(authorDeletions(m.store, m.plans)).toBe(0);
  expect(transaction).toHaveBeenCalledTimes(0);
});

test("no dead blob: an allowed pushed transcript opens no transaction and reads no kept locators", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  write(m.store, () => {
    const sent = appendEvent(m.store, {
      kind: "stored",
      type: "transcript",
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: {
        host: "claude",
        session: "claude-fixture",
        series: 0,
        chunk: 0,
        first: 1,
        last: 1,
        sha256: "a-sha",
        blob: "a".repeat(32),
        bytes: 1,
        policy: "redacted",
        rules: "-",
        digest: "d-sha",
        digestBlob: "d".repeat(32),
      },
    });

    m.store.db.run("UPDATE events SET author = 'device', sequence = 1 WHERE id = ?", [sent]);
  });

  const transaction = spyOn(m.store.db, "transaction");
  const query = spyOn(m.store.db, "query");
  cleanup.push(
    () => transaction.mockRestore(),
    () => query.mockRestore(),
  );

  expect(authorDeletions(m.store, m.plans)).toBe(0);
  expect(transaction).toHaveBeenCalledTimes(0);
  expect(query.mock.calls.filter(([sql]) => sql.includes("blob-deleted"))).toEqual([]);
});

test("the gate reads a scan database that holds only withheld links", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  rmSync(join(m.plans, "sessions-scan.db"), { force: true });
  const db = new Database(join(m.plans, "sessions-scan.db"), { create: true });
  db.run("CREATE TABLE withheld (key TEXT NOT NULL, project TEXT NOT NULL)");
  db.close();

  const record = {
    type: "session",
    payload: {
      host: "claude",
      session: "claude-fixture",
      branch: "feat/one",
      plans: [],
      source: "-",
      started: "-",
    },
  } as unknown as RemoteRecord;

  expect(pushGate(m.store, m.plans).outgoing(record).payload).toMatchObject({ branch: "feat/one" });
});

test("a policy event a revocation quarantines in place reopens the deletion pass", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const policy = (value: string) =>
    appendEvent(m.store, {
      kind: "stored",
      type: "policy",
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: { policy: value as "stats" },
    });

  const loosened = write(m.store, () => {
    policy("stats");
    const full = policy("full");
    const sent = appendEvent(m.store, {
      kind: "stored",
      type: "transcript",
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: {
        host: "claude",
        session: "claude-fixture",
        series: 0,
        chunk: 0,
        first: 1,
        last: 1,
        sha256: "c-sha",
        blob: "c".repeat(32),
        bytes: 1,
        policy: "full",
        rules: "-",
        digest: "e-sha",
        digestBlob: "e".repeat(32),
      },
    });

    m.store.db.run("UPDATE events SET author = 'device', sequence = 1 WHERE id = ?", [sent]);
    return full;
  });

  expect(authorDeletions(m.store, m.plans)).toBe(0);

  m.store.db.run("UPDATE events SET quarantined = 'revoked' WHERE id = ?", [loosened]);
  expect(authorDeletions(m.store, m.plans)).toBe(2);
});

test("a deletion another device authored that a revocation quarantines gets a replacement", async () => {
  const m = await sessionsMachine("stats");
  cleanup.push(m.close);

  const [chunk, digest] = ["f".repeat(32), "9".repeat(32)];
  const theirs = write(m.store, () => {
    const sent = appendEvent(m.store, {
      kind: "stored",
      type: "transcript",
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: {
        host: "claude",
        session: "claude-fixture",
        series: 0,
        chunk: 0,
        first: 1,
        last: 1,
        sha256: "f-sha",
        blob: chunk,
        bytes: 1,
        policy: "redacted",
        rules: "-",
        digest: "9-sha",
        digestBlob: digest,
      },
    });

    m.store.db.run("UPDATE events SET author = 'device', sequence = 1 WHERE id = ?", [sent]);
    return [chunk, digest].map((blob) =>
      appendEvent(m.store, {
        kind: "stored",
        type: "blob-deleted",
        at: Date.now(),
        project: "Alpha",
        plan: "-",
        payload: { blob },
      }),
    );
  });

  expect(authorDeletions(m.store, m.plans)).toBe(0);

  m.store.db.run("UPDATE events SET quarantined = 'revoked' WHERE id = ?", [theirs[0] ?? ""]);
  expect(authorDeletions(m.store, m.plans)).toBe(1);
});

test("idle gate: a plan record and an empty deletion pass leave the scan database unopened", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  rmSync(join(m.plans, "sessions-scan.db"), { force: true });
  mkdirSync(join(m.plans, "sessions-scan.db"));

  const query = spyOn(m.store.db, "query");
  cleanup.push(() => query.mockRestore());

  const record = { type: "plan", payload: { id: "001" } } as unknown as RemoteRecord;
  const gate = pushGate(m.store, m.plans);

  expect(gate.passes(record)).toBe(true);
  expect(gate.outgoing(record)).toBe(record);
  expect(query).toHaveBeenCalledTimes(0);

  expect(authorDeletions(m.store, m.plans)).toBe(0);
  expect(query).toHaveBeenCalledTimes(1);
});

test("a removed worktree's session branch leaves with its env value redacted", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const value = "Zq8vT3nW6pR1yK4mH2";
  const { worktree } = await envSources(m, `DEPLOY_KEY=${value}`);
  rmSync(worktree, { recursive: true });

  const record = {
    type: "session",
    payload: {
      host: "claude",
      session: "claude-fixture",
      branch: `feat/${value}`,
      plans: ["001"],
      source: "resume",
      started: "2026-11-07T10:05:00Z",
    },
  } as unknown as RemoteRecord;

  const sent = pushGate(m.store, m.plans).outgoing(record).payload as { branch: string };
  expect(sent.branch).toBe("feat/[redacted:env]");
});

test("a live worktree's env values win over its registered checkout's", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const [worktreeValue, checkoutValue] = ["Zq8vT3nW6pR1yK4mH2", "Bx5cN7mQ2wL9dR4tY6"];
  const { worktree } = await envSources(
    m,
    `DEPLOY_KEY=${worktreeValue}`,
    `DEPLOY_KEY=${checkoutValue}`,
  );

  const branch = () => {
    const record = {
      type: "session",
      payload: {
        host: "claude",
        session: "claude-fixture",
        branch: `feat/${worktreeValue}/${checkoutValue}`,
        plans: ["001"],
        source: "resume",
        started: "2026-11-07T10:05:00Z",
      },
    } as unknown as RemoteRecord;

    return (pushGate(m.store, m.plans).outgoing(record).payload as { branch: string }).branch;
  };

  expect(branch()).toBe(`feat/[redacted:env]/${checkoutValue}`);

  rmSync(worktree, { recursive: true });
  expect(branch()).toBe(`feat/${worktreeValue}/[redacted:env]`);
});
