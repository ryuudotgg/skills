import { afterEach, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { SESSION_EVENT, SESSION_STATS_EVENT, type SessionStats } from "skills-core";
import * as record from "../plans/record.ts";
import { appendEvent, write } from "../plans/store.ts";
import { age, sessionsMachine, setPolicy, type SessionsMachine } from "../test/sessions-fixture.ts";
import { SCAN_DB } from "./policy.ts";
import { scanSessions } from "./scan.ts";
import { hostDirs } from "./transcripts.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

type StatsRow = {
  id: string;
  project: string;
  plan: string;
  payload: string;
  quarantined: string | null;
};

function stats(m: SessionsMachine): StatsRow[] {
  return m.store.db
    .query(
      `SELECT id, project, plan, payload, quarantined FROM events
       WHERE type = 'session-stats' AND json_extract(payload, '$.session') = 'claude-fixture'
       ORDER BY seq`,
    )
    .all() as StatsRow[];
}

function quarantine(m: SessionsMachine, id: string, reason: string | null = "revoked"): void {
  m.store.db.run("UPDATE events SET quarantined = ? WHERE id = ?", [reason, id]);
}

let appended = 0;
function appendRecord(m: SessionsMachine): void {
  appended += 1;
  const record = {
    type: "assistant",
    sessionId: "claude-fixture",
    cwd: "/tmp/sessions-fixture/checkout/Alpha",
    uuid: `00000000-0000-4000-9000-${String(appended).padStart(12, "0")}`,
    timestamp: "2026-11-07T10:10:00.000Z",
    message: {
      id: `msg_scan_${appended}`,
      model: "claude-opus-5-5",
      role: "assistant",
      content: [{ type: "text", text: "more" }],
      usage: { input_tokens: 5, output_tokens: 3 },
    },
  };

  appendFileSync(m.claude, `${JSON.stringify(record)}\n`);
  age(m.claude);
}

function recordGamma(m: SessionsMachine, session = "claude-fixture"): string {
  return write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Gamma",
      plan: "-",
      payload: {
        host: "claude",
        session,
        branch: "feat/gamma",
        plans: [],
        source: "startup",
        started: "2026-11-07T10:00:00Z",
      },
    }),
  );
}

const scan = (m: SessionsMachine) => scanSessions(m.plans, hostDirs(m.env));

test("a quarantined session event never decides where new stats are filed", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  quarantine(m, recordGamma(m));
  appendRecord(m);
  await scan(m);

  expect(stats(m).at(-1)).toMatchObject({ project: "Alpha", plan: "001", quarantined: null });
});

test("a quarantined session event the Heads already followed stops deciding", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const gamma = recordGamma(m);
  appendRecord(m);
  await scan(m);
  expect(stats(m).at(-1)).toMatchObject({ project: "Gamma", plan: "-" });

  quarantine(m, gamma);
  appendRecord(m);
  await scan(m);

  expect(stats(m).at(-1)).toMatchObject({ project: "Alpha", plan: "001", quarantined: null });
});

test("revoked stats get a replacement with the transcript untouched, once", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const revoked = stats(m).at(-1)!;
  quarantine(m, revoked.id);

  expect(await scan(m)).toEqual({ scanned: 1, changed: 1 });

  const visible = stats(m).filter((row) => row.quarantined === null);
  expect(visible.length).toBe(1);
  expect(visible[0]!.payload).toBe(revoked.payload);
  expect(visible[0]!.id).not.toBe(revoked.id);

  expect(await scan(m)).toEqual({ scanned: 0, changed: 0 });

  const before = stats(m).length;
  quarantine(m, revoked.id, null);
  expect(await scan(m)).toEqual({ scanned: 0, changed: 0 });
  expect(stats(m).length).toBe(before);
});

test("a silenced session gets no replacement for its revoked stats", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  setPolicy(m, "off");
  const before = m.store.db.query("SELECT max(seq) AS seq FROM events").get() as { seq: number };
  quarantine(m, stats(m).at(-1)!.id);

  expect(await scan(m)).toEqual({ scanned: 0, changed: 0 });

  const after = m.store.db.query("SELECT max(seq) AS seq FROM events").get() as { seq: number };
  expect(after.seq).toBe(before.seq);
});

test("a Quarantine change leaves a session alone whose Head only moved forward", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const ours = JSON.parse(stats(m).at(-1)!.payload) as SessionStats;
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_STATS_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: { ...ours, records: ours.records + 10 },
    }),
  );

  quarantine(m, recordGamma(m, "claude-elsewhere"));
  const before = stats(m).length;

  expect(await scan(m)).toEqual({ scanned: 0, changed: 0 });
  expect(stats(m).length).toBe(before);
});

test("a readmission an older CLI scanned past still rebuilds the Heads", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const gamma = recordGamma(m);
  quarantine(m, gamma);
  appendRecord(m);
  await scan(m);
  quarantine(m, gamma, null);

  const progress = new Database(join(m.plans, SCAN_DB));
  progress.run("UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq'");
  progress.close();

  appendRecord(m);
  await scan(m);

  expect(stats(m).at(-1)).toMatchObject({ project: "Gamma", plan: "-" });
});

test("a quarantine that lands while a scan waits on an origin holds that scan's appends", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const gamma = recordGamma(m);
  appendRecord(m);
  await scan(m);
  expect(stats(m).at(-1)).toMatchObject({ project: "Gamma" });

  const other = join(dirname(m.claude), "claude-other.jsonl");
  const first = { type: "user", sessionId: "claude-other", cwd: m.root, gitBranch: "feat/two" };
  writeFileSync(
    other,
    `${JSON.stringify({ ...first, message: { role: "user", content: "hi" } })}\n`,
  );

  age(other);
  appendRecord(m);

  const spy = spyOn(record, "placed").mockImplementation(async () => {
    quarantine(m, gamma);
    return { project: "Alpha", branch: "feat/two" };
  });

  cleanup.push(() => spy.mockRestore());

  const before = stats(m).length;
  await scan(m);
  expect(spy).toHaveBeenCalled();
  expect(stats(m).length).toBe(before);

  await scan(m);
  expect(stats(m).at(-1)).toMatchObject({ project: "Alpha", plan: "001", quarantined: null });
});
