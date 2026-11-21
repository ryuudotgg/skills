import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storedEvents } from "../test/stored-events.ts";
import { appendLog } from "./commit.ts";
import { importRoot } from "./import.ts";
import { recordEvent } from "./record.ts";
import * as store from "./store.ts";
import { lastTrailEvent, openStore, trailEntries } from "./store.ts";

const HEADER = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n";
const block = { rules: ["reply-guard/dash"], host: "claude" as const };

let temporary: string;
let plans: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-record-"));
  plans = join(temporary, "plans");
  mkdirSync(join(plans, "Alpha"), { recursive: true });
  writeFileSync(
    join(plans, "Alpha/index.tsv"),
    `${HEADER}001\tshell\tDONE\tP1\tS\t-\t-\tfeat/shell\t2026-11-07\t-\n002\tfeed\tDOING\tP1\tS\t-\t-\tfeat/shell\t2026-11-07\t-\n`,
  );

  env = { ...process.env, PLANS_DIR: plans };
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

test("no plans directory means nothing is created", async () => {
  const missing = join(temporary, "missing");
  await recordEvent("hook-block", block, { project: "-", plan: "-" }, { PLANS_DIR: missing });
  expect(existsSync(missing)).toBe(false);
});

test("a branch maps to its open row, never a closed one, and no project maps to none", async () => {
  await recordEvent("hook-block", block, { cwd: temporary, branch: "feat/shell" }, env);

  const checkout = join(temporary, "Alpha");
  mkdirSync(checkout);
  await recordEvent("hook-block", block, { cwd: checkout, branch: "feat/shell" }, env);
  await recordEvent("hook-block", block, { cwd: checkout, branch: "feat/other" }, env);

  expect(storedEvents(plans, "hook-block").map(({ project, plan }) => [project, plan])).toEqual([
    ["-", "-"],
    ["Alpha", "002"],
    ["Alpha", "-"],
  ]);
});

test("stored events stay out of the trail, its view and a reimport", async () => {
  await appendLog("Alpha", "-", "start", "feat/x", env);
  await recordEvent("hook-block", block, { project: "Alpha", plan: "-" }, env);
  await recordEvent(
    "round",
    { pr: 1, branch: "feat/x", head: "abc", outcomes: { greptile: "fixed" }, verdict: "done" },
    { project: "Alpha", plan: "-" },
    env,
  );

  await appendLog("Alpha", "-", "handback", "feat/x", env);
  await importRoot(plans);

  const store = openStore(join(plans, "plans.db"));
  try {
    expect(trailEntries(store).map((entry) => entry.event)).toEqual(["start", "handback"]);
    expect(lastTrailEvent(store, "Alpha", "-")).toEqual({ event: "handback", detail: "feat/x" });
  } finally {
    store.db.close();
  }

  const types = readFileSync(join(plans, "log.tsv"), "utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t")[3]);

  expect(types).toEqual(["start", "handback"]);
  expect(storedEvents(plans, "hook-block")).toHaveLength(1);
});

test("a held store drops the event at its busy budget and throws nothing", async () => {
  await recordEvent("hook-block", block, { project: "Alpha", plan: "-" }, env);

  const budgeted = openStore(join(plans, "plans.db"), { busyMs: 100, drain: false });
  expect(budgeted.db.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 100 });
  budgeted.db.close();

  const holder = new Database(join(plans, "plans.db"));
  holder.run("BEGIN EXCLUSIVE");

  const opened = spyOn(store, "openStore");
  try {
    await recordEvent("hook-block", block, { project: "Alpha", plan: "-" }, env, 100);
    expect(opened.mock.calls.map(([, options]) => options?.busyMs)).toEqual([100]);
  } finally {
    opened.mockRestore();
    holder.run("ROLLBACK");
    holder.close();
  }

  expect(storedEvents(plans, "hook-block")).toHaveLength(1);
});

test("a pr event repeats only when state, head or verdict changes", async () => {
  const pr = {
    pr: 4,
    branch: "feat/x",
    state: "open" as const,
    head: "abc",
    verdict: "pending" as const,
    failing: [],
  };

  const place = { project: "Alpha", plan: "002" };
  for (const next of [
    pr,
    pr,
    { ...pr, verdict: "green" as const },
    { ...pr, verdict: "green" as const },
    { ...pr, head: "def", verdict: "green" as const },
    { ...pr, state: "merged" as const, head: "def", verdict: null },
  ])
    await recordEvent("pr", next, place, env);

  await recordEvent("pr", pr, { project: "Alpha", plan: "001" }, env);

  expect(
    storedEvents(plans, "pr").map(({ plan, payload }) => [
      plan,
      payload.state,
      payload.head,
      payload.verdict,
    ]),
  ).toEqual([
    ["002", "open", "abc", "pending"],
    ["002", "open", "abc", "green"],
    ["002", "open", "def", "green"],
    ["002", "merged", "def", null],
    ["001", "open", "abc", "pending"],
  ]);
});

test("pr and round events reach every open row on their branch, a hook block only the first", async () => {
  const checkout = join(temporary, "Alpha");
  mkdirSync(checkout);
  writeFileSync(
    join(plans, "Alpha/index.tsv"),
    `${HEADER}001\ta\tREVIEW\tP1\tS\t-\t-\tfeat/batch\t2026-11-07\t-\n002\tb\tREVIEW\tP1\tS\t-\t-\tfeat/batch\t2026-11-07\t-\n`,
  );

  const pr = {
    pr: 9,
    branch: "feat/batch",
    state: "open" as const,
    head: "abc",
    verdict: "green" as const,
    failing: [],
  };

  await recordEvent("pr", pr, { cwd: checkout, branch: "feat/batch" }, env);
  await recordEvent("hook-block", block, { cwd: checkout, branch: "feat/batch" }, env);
  await recordEvent(
    "round",
    { pr: 9, branch: "feat/batch", head: "abc", outcomes: { greptile: "fixed" }, verdict: "done" },
    { cwd: checkout, branch: "feat/batch" },
    env,
  );

  expect(storedEvents(plans, "pr").map((event) => event.plan)).toEqual(["001", "002"]);
  expect(storedEvents(plans, "round").map((event) => event.plan)).toEqual(["001", "002"]);
  expect(storedEvents(plans, "hook-block").map((event) => event.plan)).toEqual(["001"]);
});

test("a round on a head already holding the same outcomes is not recorded again", async () => {
  const place = { project: "Alpha", plan: "002" };
  const round = (outcomes: Record<string, "fixed" | "dismissed">, head = "abc") => ({
    pr: 3,
    branch: "feat/x",
    head,
    outcomes,
    verdict: "rereview",
  });

  for (const next of [
    round({ greptile: "fixed" }),
    round({ greptile: "dismissed" }),
    round({ greptile: "fixed" }),
    round({ greptile: "fixed" }, "def"),
    round({}, ""),
    round({}, ""),
  ])
    await recordEvent("round", next, place, env);

  expect(
    storedEvents(plans, "round").map(({ payload }) => [payload.head, payload.outcomes]),
  ).toEqual([
    ["abc", { greptile: "fixed" }],
    ["abc", { greptile: "dismissed" }],
    ["def", { greptile: "fixed" }],
    ["", {}],
    ["", {}],
  ]);
});

function quarantineNewest(type: string): void {
  const db = new Database(join(plans, "plans.db"));
  try {
    db.run(
      "UPDATE events SET quarantined = 'revoked' WHERE seq = (SELECT max(seq) FROM events WHERE type = ?)",
      [type],
    );
  } finally {
    db.close();
  }
}

test("a quarantined pr event never suppresses a genuine append", async () => {
  const place = { project: "Alpha", plan: "002" };
  const pr = (number: number, verdict: "pending" | "green") => ({
    pr: number,
    branch: "feat/x",
    state: "open" as const,
    head: "abc",
    verdict,
    failing: [],
  });

  await recordEvent("pr", pr(4, "pending"), place, env);
  quarantineNewest("pr");
  await recordEvent("pr", pr(4, "pending"), place, env);

  await recordEvent("pr", pr(5, "pending"), place, env);
  await recordEvent("pr", pr(5, "green"), place, env);
  quarantineNewest("pr");
  await recordEvent("pr", pr(5, "pending"), place, env);

  expect(storedEvents(plans, "pr").map(({ payload }) => [payload.pr, payload.verdict])).toEqual([
    [4, "pending"],
    [4, "pending"],
    [5, "pending"],
    [5, "green"],
  ]);
});

test("a quarantined round event never suppresses a genuine append", async () => {
  const round = {
    pr: 3,
    branch: "feat/x",
    head: "abc",
    outcomes: { greptile: "fixed" as const },
    verdict: "rereview",
  };

  await recordEvent("round", round, { project: "Alpha", plan: "002" }, env);
  quarantineNewest("round");
  await recordEvent("round", round, { project: "Alpha", plan: "002" }, env);

  expect(storedEvents(plans, "round")).toHaveLength(2);
});
