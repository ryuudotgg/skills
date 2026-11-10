import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isoWeekSpan } from "skills-core";
import { storedEvents } from "../test/stored-events.ts";
import { appendLog, recordWorkingCopies } from "./commit.ts";
import { digestVerb } from "./digest.ts";
import { appendEvent, openStore } from "./store.ts";

const HEADER = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n";
const usage = "skills digest [--week <YYYY-MM-DD>]";

let temporary: string;
let plans: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-digest-"));
  plans = join(temporary, "plans");
  mkdirSync(join(plans, "Alpha"), { recursive: true });
  writeFileSync(
    join(plans, "Alpha/index.tsv"),
    `${HEADER}001\tshell\tREVIEW\tP1\tS\t-\t-\tfeat/shell\t2026-11-07\t-\n`,
  );

  env = { PATH: process.env.PATH, HOME: temporary, PLANS_DIR: plans };
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

async function run(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await digestVerb(args, usage, {
    cwd: temporary,
    env,
    capture: true,
    out: (text) => void out.push(text),
    err: (text) => void err.push(text),
  });

  return { code, out: out.join(""), err: err.join("") };
}

function digests(): { week: string; markdown: string }[] {
  return storedEvents(plans, "digest").map(
    ({ payload }) => payload as { week: string; markdown: string },
  );
}

test("writes one digest for this week, then reports it exists, and keeps it out of log.tsv", async () => {
  const week = isoWeekSpan(Date.now()).week;
  await appendLog("Alpha", "001", "start", "feat/shell", env);

  expect(await run([])).toEqual({ code: 0, out: `digest ${week} written\n`, err: "" });
  expect(await run([])).toEqual({ code: 0, out: `digest ${week} exists\n`, err: "" });
  expect(digests().map((digest) => digest.week)).toEqual([week]);

  const types = readFileSync(join(plans, "log.tsv"), "utf8")
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t")[3]);

  expect(types).toEqual(["start"]);
});

test("a lesson carries the first line of the plan's newest Landed section", async () => {
  const file = join(plans, "Alpha/001-shell.md");
  writeFileSync(file, "# 001 shell\n\n## Landed\n\n\nBranch feat/shell, not merged yet.\nMore.\n");
  await recordWorkingCopies(plans, [file]);
  await appendLog("Alpha", "001", "review", "feat/shell", env);
  await appendLog("Alpha", "001", "review", "feat/shell", env);

  expect((await run([])).code).toBe(0);
  expect(digests()[0]?.markdown).toContain(
    "## Lessons for /plans new\n\n- Alpha 001 shell: Branch feat/shell, not merged yet.\n",
  );
});

test("a digest written before its week ended gives way to one written after", async () => {
  const store = openStore(join(plans, "plans.db"), { fresh: true });
  try {
    appendEvent(store, {
      kind: "stored",
      type: "digest",
      at: Date.parse("2026-10-01T12:00:00Z"),
      project: "-",
      plan: "-",
      payload: { week: "2026-W40", markdown: "## Closes\n\nnone\n" },
    });
  } finally {
    store.db.close();
  }

  expect((await run(["--week", "2026-10-01"])).out).toBe("digest 2026-W40 written\n");
  expect((await run(["--week", "2026-10-04"])).out).toBe("digest 2026-W40 exists\n");
  expect(digests()).toHaveLength(2);
});

test("refuses a bad week, extra words and a missing plans directory", async () => {
  for (const args of [["--week"], ["--week", "2026-13-01"], ["--week", "2026-11-10", "x"], ["now"]])
    expect(await run(args)).toEqual({ code: 2, out: "", err: `usage: ${usage}\n` });

  env.PLANS_DIR = join(temporary, "missing");
  expect(await run([])).toEqual({
    code: 1,
    out: "",
    err: `digest: no plans directory at ${join(temporary, "missing")}\n`,
  });
});

test("an empty Landed section gives no line, never the heading after it", async () => {
  const file = join(plans, "Alpha/001-shell.md");
  writeFileSync(file, "# 001 shell\n\n## Landed\n\n## Private notes\n\nsecret\n");
  await recordWorkingCopies(plans, [file]);
  await appendLog("Alpha", "001", "review", "feat/shell", env);
  await appendLog("Alpha", "001", "review", "feat/shell", env);

  expect((await run([])).code).toBe(0);
  expect(digests()[0]?.markdown).toContain("- Alpha 001 shell: -\n");
  expect(digests()[0]?.markdown).not.toContain("Private");
});

test("a machine joined to a hub writes no final digest when no hub sync finished during the run", async () => {
  const store = openStore(join(plans, "plans.db"), { fresh: true });
  try {
    store.db.run("INSERT INTO meta (key, value) VALUES ('checkpoint', '{}')");
  } finally {
    store.db.close();
  }

  env.HUB_URL = "http://127.0.0.1:9";
  const result = await run(["--week", "2026-10-01"]);

  expect(result.code).toBe(1);
  expect(result.err).toStartWith("digest: no hub sync finished since ");
  expect(result.err).toContain("a final 2026-W40 digest could miss another machine's events");
  expect(digests()).toEqual([]);

  delete env.HUB_URL;
  expect((await run(["--week", "2026-10-01"])).out).toBe("digest 2026-W40 written\n");
});
