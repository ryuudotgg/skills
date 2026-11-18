import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BLOB_MAX, CHUNK_SIZE, POLICY_EVENT, SESSION_EVENT, type SessionPolicy } from "skills-core";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { appendEvent, write } from "../plans/store.ts";
import {
  age,
  blobText,
  sessionsMachine,
  setPolicy,
  transcripts as recorded,
  type SessionsMachine as Machine,
} from "../test/sessions-fixture.ts";
import { chunkTranscripts, uncutBytes } from "./chunks.ts";
import { scanSessions } from "./scan.ts";
import { hostDirs } from "./transcripts.ts";
import { policyVerb } from "./verbs.ts";

const LINES = readFileSync(
  join(
    import.meta.dir,
    "fixture/home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl",
  ),
  "utf8",
)
  .split("\n")
  .filter(Boolean).length;

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

async function machine(policy?: SessionPolicy): Promise<Machine> {
  const m = await sessionsMachine(policy);
  cleanup.push(m.close);
  return m;
}

function chunk(m: Machine): { made: number; withheld: number } {
  return chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });
}

function transcripts(m: Machine) {
  return recorded(m.store);
}

function text(m: Machine, sha256: string): string {
  return blobText(m.store, sha256);
}

test("an idle transcript closes one chunk with its digest, an off session none, a rerun nothing", async () => {
  const m = await machine();

  expect(chunk(m)).toEqual({ made: 1, withheld: 0 });
  expect(chunk(m)).toEqual({ made: 0, withheld: 0 });

  const [only] = transcripts(m);
  expect(only).toMatchObject({ host: "claude", series: 0, chunk: 0, first: 1, last: LINES });
  expect(only?.policy).toBe("redacted");
  expect(text(m, only?.digest ?? "")).toContain("Prompt: ");
  expect(text(m, only?.sha256 ?? "")).toContain("[redacted:");
});

test("a fresh tail waits for ten idle minutes, then closes as the next chunk", async () => {
  const m = await machine();
  chunk(m);

  appendFileSync(m.claude, '{"type":"user","message":{"content":"again"}}\n');
  expect(chunk(m).made).toBe(0);

  age(m.claude);
  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({
    series: 0,
    chunk: 1,
    first: LINES + 1,
    last: LINES + 1,
  });
});

test("chunks end at line boundaries under a mebibyte and concatenate to the transcript", async () => {
  const m = await machine("full");
  const line = `"${"y".repeat(400_000)}"\n`;
  appendFileSync(m.claude, line.repeat(3));
  age(m.claude);

  expect(chunk(m).made).toBe(2);

  const made = transcripts(m);
  const joined = made.map((record) => text(m, record.sha256)).join("");
  expect(made.map((record) => record.bytes <= CHUNK_SIZE)).toEqual([true, true]);
  expect(made.map((record) => [record.first, record.last])).toEqual([
    [1, LINES + 2],
    [LINES + 3, LINES + 3],
  ]);

  expect(joined).toBe(await Bun.file(m.claude).text());
});

test("a rewritten transcript starts the next series from its first line", async () => {
  const m = await machine();
  chunk(m);

  writeFileSync(m.claude, '{"type":"summary","summary":"rewritten"}\n');
  age(m.claude);
  await scanSessions(m.plans, hostDirs(m.env));

  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ series: 1, chunk: 0, first: 1, last: 1 });
});

test("under stats a chunk is withheld: no event, no blob, and its lines never reach a later digest", async () => {
  const m = await machine();
  chunk(m);
  setPolicy(m, "stats");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"private plan"}}\n');
  age(m.claude);
  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });

  setPolicy(m, "full");
  appendFileSync(m.claude, '{"type":"user","message":{"content":"public"}}\n');
  age(m.claude);
  expect(chunk(m).made).toBe(1);

  const last = transcripts(m).at(-1);
  expect(last).toMatchObject({ chunk: 2, first: LINES + 2, last: LINES + 2, policy: "full" });
  expect(text(m, last?.digest ?? "")).toContain("Prompt: public");
  expect(text(m, last?.digest ?? "")).not.toContain("private plan");
});

test("a line past the hub's blob cap is withheld and the chunker moves past it", async () => {
  const m = await machine("full");
  chunk(m);

  appendFileSync(
    m.claude,
    `${"z".repeat(BLOB_MAX)}\n{"type":"user","message":{"content":"after"}}\n`,
  );

  age(m.claude);

  expect(chunk(m)).toEqual({ made: 1, withheld: 1 });
  expect(transcripts(m).at(-1)).toMatchObject({ chunk: 2, first: LINES + 2, last: LINES + 2 });
});

test("a spent budget leaves the backlog for the next run", async () => {
  const m = await machine();
  const spent = chunkTranscripts(m.store, m.plans, m.env, { deadline: 0, bytes: 0 });

  expect(spent).toEqual({ made: 0, withheld: 0 });
  expect(chunk(m).made).toBe(1);
});

test("lines written while a chunked session is off never reach a later chunk", async () => {
  const m = await machine();
  chunk(m);
  setPolicy(m, "off");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"while off"}}\n');
  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });

  setPolicy(m, "redacted");
  appendFileSync(m.claude, '{"type":"user","message":{"content":"back on"}}\n');
  age(m.claude);
  expect(chunk(m).made).toBe(1);

  const last = transcripts(m).at(-1);
  expect(last).toMatchObject({ first: LINES + 2, last: LINES + 2 });
  expect(text(m, last?.sha256 ?? "")).not.toContain("while off");
});

test("a chunk that fills closes at once, before the transcript goes idle", async () => {
  const m = await machine("full");
  chunk(m);

  appendFileSync(m.claude, `"${"w".repeat(CHUNK_SIZE)}"\n`);
  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ first: LINES + 1, last: LINES + 1 });
});

test("a line past the blob cap is passed over even when the run's byte allowance is smaller", async () => {
  const m = await machine("full");
  chunk(m);

  appendFileSync(
    m.claude,
    `${"z".repeat(BLOB_MAX)}\n{"type":"user","message":{"content":"after"}}\n`,
  );

  age(m.claude);

  const small = chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: 4096,
  });

  expect(small).toEqual({ made: 1, withheld: 1 });
});

test("oversized lines stop at the deadline", async () => {
  const m = await machine("full");
  chunk(m);

  const firstEnd = Bun.file(m.claude).size + BLOB_MAX + 1;
  appendFileSync(m.claude, `${"z".repeat(BLOB_MAX)}\n`.repeat(3));
  age(m.claude);

  const now = Date.now;
  const deadline = now() + 60_000;
  let checks = 0;
  Date.now = () => (checks++ === 0 ? deadline - 1 : deadline + 1);
  cleanup.push(() => {
    Date.now = now;
  });

  const late = chunkTranscripts(m.store, m.plans, m.env, {
    deadline,
    bytes: Number.POSITIVE_INFINITY,
  });

  Date.now = now;
  const cursor = m.store.db.query("SELECT offset FROM transcript_cursors").get() as {
    offset: number;
  };

  expect(late).toEqual({ made: 0, withheld: 1 });
  expect(cursor.offset).toBe(firstEnd);
  expect(chunk(m)).toEqual({ made: 0, withheld: 2 });
});

test("a transcript the scan restarted starts a new series even when it stays past the chunk offset", async () => {
  const m = await machine();
  chunk(m);

  const original = await Bun.file(m.claude).text();
  const tail = '{"type":"user","message":{"content":"pending tail"}}\n';
  appendFileSync(m.claude, tail.repeat(10));
  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(0);

  writeFileSync(m.claude, original.replace("deploy fails", "deploy broke") + tail.repeat(5));
  age(m.claude);
  await scanSessions(m.plans, hostDirs(m.env));

  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ series: 1, chunk: 0, first: 1 });
});

function chunkWith(m: Machine, env: NodeJS.ProcessEnv): { made: number; withheld: number } {
  return chunkTranscripts(m.store, m.plans, env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });
}

function cursorPaths(m: Machine): string[] {
  const rows = m.store.db.query("SELECT path FROM transcript_cursors").all() as { path: string }[];
  return rows.map((row) => row.path);
}

function moveProject(m: Machine): string {
  const from = dirname(m.claude);
  const to = join(dirname(from), "-tmp-sessions-fixture-checkout-Renamed");
  renameSync(from, to);
  return join(to, basename(m.claude));
}

test("a transcript in a moved project folder resumes its cursor and keeps withheld lines out", async () => {
  const m = await machine();
  chunk(m);
  setPolicy(m, "stats");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"private plan"}}\n');
  age(m.claude);
  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });

  const moved = moveProject(m);
  await scanSessions(m.plans, hostDirs(m.env));
  setPolicy(m, "redacted");
  expect(chunk(m).made).toBe(0);
  expect(uncutBytes(m.store, m.plans)).toBe(0);

  const before = transcripts(m).length;
  appendFileSync(moved, '{"type":"user","message":{"content":"public"}}\n');
  age(moved);
  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);

  const made = transcripts(m);
  expect(made.length).toBe(before + 1);
  expect(made.at(-1)).toMatchObject({ series: 0, chunk: 2 });

  const blobs = made.flatMap((record) => [text(m, record.sha256), text(m, record.digest)]);
  expect(blobs.filter((blob) => blob.includes("private plan"))).toEqual([]);

  expect(cursorPaths(m)).toEqual([moved]);
});

test("a rollout under a moved CODEX_HOME resumes its cursor", async () => {
  const m = await machine();
  const codex = join(m.root, "home/.codex/sessions/2026/11/07");
  const fixture = readFileSync(
    join(codex, "rollout-2026-11-07T10-00-00-codex-fixture.jsonl"),
    "utf8",
  );

  const name = "rollout-2026-11-07T11-00-00-codex-moved.jsonl";
  writeFileSync(join(codex, name), fixture.replaceAll("codex-fixture", "codex-moved"));
  age(join(codex, name));

  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: {
        host: "codex",
        session: "codex-moved",
        branch: "feat/one",
        plans: ["001"],
        source: "startup",
        started: "2026-11-07T11:00:00Z",
      },
    }),
  );

  await scanSessions(m.plans, hostDirs(m.env));
  chunk(m);

  const codexHome = join(m.root, "codex-home");
  renameSync(join(m.root, "home/.codex"), codexHome);
  const env = { ...m.env, CODEX_HOME: codexHome };
  await scanSessions(m.plans, hostDirs(env));

  expect(chunkWith(m, env)).toEqual({ made: 0, withheld: 0 });
  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(cursorPaths(m)).toContain(join(codexHome, "sessions/2026/11/07", name));

  const rollout = transcripts(m).filter((record) => record.session === "codex-moved");
  expect(rollout.map((record) => record.series)).toEqual([0]);
});

test("a moved transcript whose first line changed starts the next series", async () => {
  const m = await machine();
  chunk(m);

  const moved = moveProject(m);
  const [, ...rest] = readFileSync(moved, "utf8").split("\n");
  writeFileSync(moved, `{"type":"summary","summary":"Renamed session"}\n${rest.join("\n")}`);
  age(moved);
  await scanSessions(m.plans, hostDirs(m.env));

  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ series: 1, chunk: 0, first: 1 });
});

test("a copy that sorts after the transcript starts its own series instead of resuming", async () => {
  const m = await machine();
  chunk(m);

  const folder = join(dirname(dirname(m.claude)), "-tmp-sessions-fixture-checkout-Renamed");
  mkdirSync(folder);

  const copy = join(folder, basename(m.claude));
  copyFileSync(m.claude, copy);
  age(copy);

  await scanSessions(m.plans, hostDirs(m.env));

  expect(uncutBytes(m.store, m.plans)).toBe(Bun.file(copy).size);
  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ series: 1, chunk: 0, first: 1 });
});

test("a CLAUDE_CONFIG_DIR copied to a new home resumes its cursor and keeps withheld lines out", async () => {
  const m = await machine();
  chunk(m);
  setPolicy(m, "stats");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"private plan"}}\n');
  age(m.claude);
  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });

  const claudeHome = join(m.root, "claude-home");
  cpSync(join(m.root, "home/.claude"), claudeHome, { recursive: true, preserveTimestamps: true });

  const env = { ...m.env, CLAUDE_CONFIG_DIR: claudeHome };
  await scanSessions(m.plans, hostDirs(env));
  setPolicy(m, "redacted");

  expect(chunkWith(m, env)).toEqual({ made: 0, withheld: 0 });
  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(cursorPaths(m)).toEqual([
    join(claudeHome, "projects", basename(dirname(m.claude)), basename(m.claude)),
  ]);
});

test("a cursor never passes to a copy the scan did not follow", async () => {
  const m = await machine();
  chunk(m);

  const projects = dirname(dirname(m.claude));
  const copied = join(projects, "-tmp-sessions-fixture-checkout-Renamed");
  mkdirSync(copied);
  copyFileSync(m.claude, join(copied, basename(m.claude)));
  age(join(copied, basename(m.claude)));

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);

  renameSync(copied, join(projects, "-tmp-sessions-fixture-checkout-Aaa"));
  await scanSessions(m.plans, hostDirs(m.env));

  expect(uncutBytes(m.store, m.plans)).toBe(Bun.file(m.claude).size);
  expect(chunk(m).made).toBe(1);
  expect(transcripts(m).at(-1)).toMatchObject({ series: 2, chunk: 0, first: 1 });
});

test("a move beside a copy resumes its cursor and keeps withheld lines out", async () => {
  const m = await machine();
  const copy = join(dirname(dirname(m.claude)), "-tmp-sessions-fixture-checkout-Aaa");
  mkdirSync(copy);
  copyFileSync(m.claude, join(copy, basename(m.claude)));
  age(join(copy, basename(m.claude)));

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);
  expect(cursorPaths(m)).toEqual([m.claude]);

  setPolicy(m, "stats");
  appendFileSync(m.claude, '{"type":"user","message":{"content":"private plan"}}\n');
  age(m.claude);
  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });

  const moved = moveProject(m);
  await scanSessions(m.plans, hostDirs(m.env));
  setPolicy(m, "redacted");

  expect(chunk(m).made).toBe(0);
  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(cursorPaths(m)).toEqual([moved]);

  const blobs = transcripts(m).flatMap((record) => [
    text(m, record.sha256),
    text(m, record.digest),
  ]);

  expect(blobs.filter((blob) => blob.includes("private plan"))).toEqual([]);
});

test("two moves scanned before the next chunk still resume the cursor beside a copy", async () => {
  const m = await machine();
  const copy = join(dirname(dirname(m.claude)), "-tmp-sessions-fixture-checkout-Aaa");
  mkdirSync(copy);
  copyFileSync(m.claude, join(copy, basename(m.claude)));
  age(join(copy, basename(m.claude)));

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);

  const renamed = moveProject(m);
  await scanSessions(m.plans, hostDirs(m.env));

  const zed = join(dirname(dirname(renamed)), "-tmp-sessions-fixture-checkout-Zed");
  renameSync(dirname(renamed), zed);
  await scanSessions(m.plans, hostDirs(m.env));

  expect(chunk(m).made).toBe(0);
  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(cursorPaths(m)).toEqual([join(zed, basename(m.claude))]);
});

test("a move an older scan left unlinked resumes its cursor after the upgrade", async () => {
  const m = await machine();
  chunk(m);

  const moved = moveProject(m);
  await scanSessions(m.plans, hostDirs(m.env));

  const db = new Database(join(m.plans, "sessions-scan.db"));
  db.run("DROP TABLE moved");
  db.run("DELETE FROM meta WHERE key = 'moved'");
  db.close();

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(0);
  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(cursorPaths(m)).toEqual([moved]);
});

test("a copy at a path a transcript left never hands its cursor to that transcript's next move", async () => {
  const m = await machine();
  chunk(m);

  const aaa = join(dirname(dirname(m.claude)), "-tmp-sessions-fixture-checkout-Aaa");
  renameSync(dirname(m.claude), aaa);
  const left = join(aaa, basename(m.claude));

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(0);
  expect(cursorPaths(m)).toEqual([left]);

  mkdirSync(dirname(m.claude));
  copyFileSync(left, m.claude);
  age(m.claude);

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);
  expect(cursorPaths(m)).toEqual([m.claude]);

  appendFileSync(left, '{"type":"user","message":{"content":"divergent tail"}}\n');
  appendFileSync(m.claude, '{"type":"user","message":{"content":"copy tail"}}\n');
  age(left);
  age(m.claude);

  renameSync(aaa, join(dirname(aaa), "-tmp-sessions-fixture-checkout-Zed"));

  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);

  const last = transcripts(m).at(-1);
  expect(last).toMatchObject({ series: 2, chunk: 0, first: 1 });
  expect(text(m, last?.sha256 ?? "")).toContain("divergent tail");
});

test("a backlog read past its deadline stops at the first block of a moved transcript's long first line", async () => {
  const m = await machine();
  const [first, ...rest] = readFileSync(m.claude, "utf8").split("\n");
  const padded = JSON.stringify({ ...JSON.parse(first!), pad: "p".repeat(200_000) });
  writeFileSync(m.claude, `${padded}\n${rest.join("\n")}`);
  age(m.claude);

  await scanSessions(m.plans, hostDirs(m.env));
  chunk(m);

  const moved = moveProject(m);
  await scanSessions(m.plans, hostDirs(m.env));

  expect(uncutBytes(m.store, m.plans)).toBe(0);
  expect(uncutBytes(m.store, m.plans, 0)).toBe(Bun.file(moved).size);
});

const HOUR = 60 * 60 * 1000;

function prompt(session: string, content: string, at?: number): string {
  const timestamp = at === undefined ? {} : { timestamp: new Date(at).toISOString() };
  const record = {
    type: "user",
    sessionId: session,
    cwd: "/tmp/sessions-fixture/checkout/Alpha",
    ...timestamp,
    message: { role: "user", content },
  };

  return `${JSON.stringify(record)}\n`;
}

function addSession(m: Machine, session: string, text: string): string {
  const path = join(dirname(m.claude), `${session}.jsonl`);
  writeFileSync(path, text);
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: {
        host: "claude",
        session,
        branch: "feat/one",
        plans: ["001"],
        source: "startup",
        started: "2026-11-07T11:00:00Z",
      },
    }),
  );

  return path;
}

function policyAt(m: Machine, policy: SessionPolicy, at: number): void {
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: POLICY_EVENT,
      at,
      project: "Alpha",
      plan: "-",
      payload: { policy },
    }),
  );
}

function captured(m: Machine): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    cwd: m.root,
    env: { ...m.env, PLANS_DIR: m.plans },
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
    stdout,
    stderr,
  };
}

function allBlobs(m: Machine): string[] {
  return transcripts(m).flatMap((record) => [text(m, record.sha256), text(m, record.digest)]);
}

test("a stats window with no sync between its ends keeps every line written in it local", async () => {
  const m = await machine("redacted");
  expect(chunk(m).made).toBe(1);
  setPolicy(m, "stats");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"private plan"}}\n');
  const second = addSession(
    m,
    "claude-second",
    prompt("claude-second", "second session plan", Date.parse("2026-11-07T11:00:00Z")),
  );

  const io = captured(m);
  expect(await policyVerb(["Alpha", "redacted"], "usage", io)).toBe(0);
  expect(io.stdout).toEqual(["Alpha redacted\n"]);
  expect(io.stderr).toEqual([]);

  appendFileSync(m.claude, '{"type":"user","message":{"content":"public"}}\n');
  age(m.claude);
  age(second);
  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m).made).toBe(1);

  const last = transcripts(m).at(-1);
  expect(last).toMatchObject({ session: "claude-fixture" });
  expect(text(m, last?.sha256 ?? "")).toContain("public");
  expect(text(m, last?.digest ?? "")).toContain("Prompt: public");

  const leaked = allBlobs(m).filter(
    (blob) => blob.includes("private plan") || blob.includes("second session plan"),
  );

  expect(leaked).toEqual([]);
});

test("a loosening from another machine keeps the lines recorded inside its stats window local", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "before window", start - HOUR / 2) +
      prompt("claude-fixture", "private plan", start + HOUR / 2) +
      prompt("claude-fixture", "after window", end + HOUR / 2),
  );

  const untimed = addSession(m, "claude-untimed", prompt("claude-untimed", "untimed plan"));
  age(m.claude);
  age(untimed);
  await scanSessions(m.plans, hostDirs(m.env));
  expect(chunk(m)).toEqual({ made: 2, withheld: 3 });

  const [before, after] = transcripts(m);
  expect(transcripts(m)).toMatchObject([
    { session: "claude-fixture", first: 2, last: LINES + 1 },
    { session: "claude-fixture", first: LINES + 3, last: LINES + 3 },
  ]);

  expect(text(m, before?.sha256 ?? "")).toContain("before window");
  expect(text(m, after?.sha256 ?? "")).toContain("after window");
  expect(text(m, after?.digest ?? "")).toContain("Prompt: before window\n");
  expect(text(m, after?.digest ?? "")).toContain("Prompt: after window\n");

  const leaked = allBlobs(m).filter(
    (blob) => blob.includes("private plan") || blob.includes("untimed plan"),
  );

  expect(leaked).toEqual([]);
});

test("a session never chunked while off uploads from its first line", async () => {
  const m = await machine("off");
  setPolicy(m, "redacted");
  await scanSessions(m.plans, hostDirs(m.env));

  expect(chunk(m)).toEqual({ made: 1, withheld: 0 });
  expect(transcripts(m)).toMatchObject([{ session: "claude-fixture", series: 0, first: 1 }]);
});

test("an untimed line past a resumed cursor is judged by the timed line before it", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  appendFileSync(m.claude, prompt("claude-fixture", "private plan", start + HOUR / 2));
  age(m.claude);
  expect(chunk(m)).toEqual({ made: 1, withheld: 2 });

  appendFileSync(
    m.claude,
    '{"type":"user","message":{"content":"untimed plan"}}\n' +
      prompt("claude-fixture", "after window", end + HOUR / 2),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 1, withheld: 1 });
  expect(transcripts(m).at(-1)).toMatchObject({ first: LINES + 3, last: LINES + 3 });

  const leaked = allBlobs(m).filter(
    (blob) => blob.includes("private plan") || blob.includes("untimed plan"),
  );

  expect(leaked).toEqual([]);
});

test("a loosening that cannot pass over the transcripts refuses and records no policy", async () => {
  const m = await machine();
  setPolicy(m, "stats");

  const policies = () =>
    (
      m.store.db.query("SELECT count(*) AS n FROM events WHERE type = 'policy'").get() as {
        n: number;
      }
    ).n;

  const before = policies();
  const io = captured(m);
  const held = await tryLock(join(m.plans, ".sessions.lock"), () =>
    policyVerb(["Alpha", "redacted"], "usage", io),
  );

  expect(held).toEqual({ held: false, value: 1 });
  expect(io.stdout).toEqual([]);
  expect(io.stderr).toEqual(["sessions policy: another sessions scan is running\n"]);
  expect(policies()).toBe(before);
});

test("an untimed line after a record too big to read inside a stats window stays local", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  const huge = JSON.stringify({
    type: "user",
    timestamp: new Date(start + HOUR / 2).toISOString(),
    pad: "p".repeat(BLOB_MAX),
  });

  appendFileSync(
    m.claude,
    `${huge}\n{"type":"user","message":{"content":"untimed plan"}}\n` +
      prompt("claude-fixture", "after window", end + HOUR / 2),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 2, withheld: 3 });
  expect(transcripts(m).at(-1)).toMatchObject({ first: LINES + 3, last: LINES + 3 });
  expect(allBlobs(m).filter((blob) => blob.includes("untimed plan"))).toEqual([]);
});

test("a long run of lines inside a stats window is passed over in steps the budget can stop", async () => {
  const start = Date.now() + HOUR;
  const m = await machine();
  chunk(m);
  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);

  const inside = prompt("claude-fixture", "x".repeat(CHUNK_SIZE / 2), start + HOUR / 2);
  appendFileSync(m.claude, inside.repeat(3));
  age(m.claude);

  const small = chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: 1,
  });

  expect(small).toEqual({ made: 0, withheld: 1 });
  expect(m.store.db.query("SELECT line FROM transcript_cursors").get()).toEqual({
    line: LINES + 2,
  });

  expect(chunk(m)).toEqual({ made: 0, withheld: 1 });
});

test.skipIf(process.getuid?.() === 0)(
  "a loosening that cannot read a transcript refuses and records no policy",
  async () => {
    const m = await machine();
    setPolicy(m, "stats");

    const folder = dirname(m.claude);
    chmodSync(folder, 0o000);
    cleanup.push(() => chmodSync(folder, 0o755));

    const io = captured(m);
    const before = transcripts(m).length;
    expect(await policyVerb(["Alpha", "redacted"], "usage", io)).toBe(1);
    chmodSync(folder, 0o755);

    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toStartWith("sessions policy: cannot pass over");
    expect(io.stderr.join("")).toContain("EACCES");
    expect(transcripts(m).length).toBe(before);
    expect(
      m.store.db
        .query(
          "SELECT json_extract(payload, '$.policy') AS p FROM events WHERE type = 'policy' ORDER BY seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ p: "stats" });
  },
);

test("a stats window starts when its event was written even when the store's clock runs ahead", async () => {
  const m = await machine();
  const now = Date.now();
  policyAt(m, "redacted", now + HOUR);
  policyAt(m, "stats", now);
  policyAt(m, "redacted", now);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "private plan", now + 60_000) +
      prompt("claude-fixture", "after window", now + 2 * HOUR),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 2, withheld: 2 });
  expect(allBlobs(m).filter((blob) => blob.includes("private plan"))).toEqual([]);
});

test("a stats window of any project the session is linked to keeps its lines local", async () => {
  const start = Date.now() + HOUR;
  const m = await machine();
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Beta",
      plan: "001",
      payload: {
        host: "claude",
        session: "claude-fixture",
        branch: "feat/one",
        plans: ["001"],
        source: "resume",
        started: "2026-11-07T10:00:00Z",
      },
    }),
  );

  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "private plan", start + HOUR / 2) +
      prompt("claude-fixture", "after window", start + 2 * HOUR),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 2, withheld: 2 });
  expect(allBlobs(m).filter((blob) => blob.includes("private plan"))).toEqual([]);
});

test("a lookback stops after the blob cap and holds back the untimed line it could not place", async () => {
  const start = Date.now() + HOUR;
  const m = await machine("full");
  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);
  policyAt(m, "full", start + HOUR);

  const filler = `"${"u".repeat(1_000_000)}"\n`;
  appendFileSync(m.claude, filler.repeat(Math.ceil(BLOB_MAX / 1_000_000) + 1));
  age(m.claude);
  chunk(m);

  const before = transcripts(m).length;
  appendFileSync(
    m.claude,
    '{"type":"user","message":{"content":"untimed plan"}}\n' +
      prompt("claude-fixture", "after window", start + 2 * HOUR),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 1, withheld: 1 });
  expect(transcripts(m).length).toBe(before + 1);
  expect(allBlobs(m).filter((blob) => blob.includes("untimed plan"))).toEqual([]);
});

test("a stats event written earlier but ordered later moves its window's start back", async () => {
  const now = Date.now();
  const m = await machine();
  policyAt(m, "stats", now);
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: POLICY_EVENT,
      at: now + 2 * HOUR,
      project: "Gamma",
      plan: "-",
      payload: { policy: "full" },
    }),
  );

  policyAt(m, "stats", now - HOUR);
  policyAt(m, "redacted", now + 3 * HOUR);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "private plan", now - HOUR / 2) +
      prompt("claude-fixture", "after window", now + 4 * HOUR),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 2, withheld: 2 });
  expect(allBlobs(m).filter((blob) => blob.includes("private plan"))).toEqual([]);
});

test.skipIf(process.getuid?.() === 0)(
  "a loosening whose scan cannot read a new transcript refuses in the verb's own words",
  async () => {
    const m = await machine();
    setPolicy(m, "stats");

    const locked = addSession(
      m,
      "claude-locked",
      prompt("claude-locked", "locked plan", Date.now()),
    );

    chmodSync(locked, 0o000);
    cleanup.push(() => chmodSync(locked, 0o644));

    const io = captured(m);
    expect(await policyVerb(["Alpha", "redacted"], "usage", io)).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toStartWith("sessions policy: cannot pass over");
    expect(io.stderr.join("")).toContain("EACCES");
  },
);

test("an untimed opening line stays local once a stats window exists, whatever follows it", async () => {
  const start = Date.now() + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);

  const leading = addSession(
    m,
    "claude-leading",
    '{"type":"user","sessionId":"claude-leading","message":{"content":"leading plan"}}\n' +
      prompt("claude-leading", "after window", start + 2 * HOUR),
  );

  age(m.claude);
  age(leading);
  await scanSessions(m.plans, hostDirs(m.env));
  chunk(m);

  const own = transcripts(m).filter((record) => record.session === "claude-leading");
  expect(own).toMatchObject([{ first: 2, last: 2 }]);
  expect(allBlobs(m).filter((blob) => blob.includes("leading plan"))).toEqual([]);
});

test("a series whose opening line is withheld still uploads its first chunk as chunk 0", async () => {
  const start = Date.now() + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);

  expect(chunk(m)).toEqual({ made: 1, withheld: 1 });
  expect(transcripts(m)).toMatchObject([
    { series: 0, chunk: 0, first: 2, last: LINES, cwd: "/tmp/sessions-fixture/checkout/Alpha" },
  ]);
});

test("an untimed line between timed lines that straddle a stats window stays local", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "before window", start - HOUR / 2) +
      '{"type":"user","message":{"content":"straddled plan"}}\n' +
      prompt("claude-fixture", "after window", end + HOUR / 2),
  );

  age(m.claude);
  expect(chunk(m)).toEqual({ made: 2, withheld: 2 });
  expect(allBlobs(m).filter((blob) => blob.includes("straddled plan"))).toEqual([]);
  expect(allBlobs(m).some((blob) => blob.includes("after window"))).toBe(true);
});

test("an untimed line between timestamps that run backwards across a stats window stays local", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "inside window", start + HOUR / 2) +
      '{"type":"user","message":{"content":"reversed plan"}}\n' +
      prompt("claude-fixture", "before window", start - HOUR / 2),
  );

  age(m.claude);
  chunk(m);
  expect(allBlobs(m).filter((blob) => blob.includes("reversed plan"))).toEqual([]);
  expect(allBlobs(m).some((blob) => blob.includes("before window"))).toBe(true);
});

test("an untimed run longer than a chunk uploads when no stats window falls around it", async () => {
  const start = Date.now() + HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  const large = `large plan ${"x".repeat(CHUNK_SIZE + 1024)}`;
  appendFileSync(
    m.claude,
    prompt("claude-fixture", "after window", end + HOUR / 4) +
      JSON.stringify({ type: "user", message: { content: large } }) +
      "\n" +
      prompt("claude-fixture", "later still", end + HOUR / 2),
  );

  age(m.claude);
  chunk(m);
  expect(allBlobs(m).some((blob) => blob.includes("large plan"))).toBe(true);
  expect(allBlobs(m).some((blob) => blob.includes("later still"))).toBe(true);
});

test("an untimed run whose look ahead outlasts the deadline still moves the cursor", async () => {
  const start = Date.now() + HOUR;
  const m = await machine();
  chunk(m);
  policyAt(m, "stats", start);
  policyAt(m, "redacted", start + HOUR);

  const untimed = `${JSON.stringify({ type: "user", message: { content: "x".repeat(CHUNK_SIZE / 2) } })}\n`;
  const count = BLOB_MAX / CHUNK_SIZE;
  appendFileSync(
    m.claude,
    prompt("claude-fixture", "before window", Date.now()) + untimed.repeat(count),
  );

  age(m.claude);

  const cursor = () =>
    (m.store.db.query("SELECT line FROM transcript_cursors").get() as { line: number }).line;

  const now = Date.now;
  cleanup.push(() => {
    Date.now = now;
  });

  const deadline = now() + 60_000;
  const lines: number[] = [cursor()];
  for (let run = 0; run < 3; run++) {
    let checks = 0;
    Date.now = () => (checks++ < 6 ? deadline - 1 : deadline + 1);
    chunkTranscripts(m.store, m.plans, m.env, { deadline, bytes: Number.POSITIVE_INFINITY });
    Date.now = now;
    lines.push(cursor());
  }

  expect(lines[1]!).toBeGreaterThan(lines[0]!);
  expect(lines[2]!).toBeGreaterThan(lines[1]!);
  expect(lines[3]!).toBeGreaterThan(lines[2]!);
  expect(allBlobs(m).filter((blob) => blob.includes("xxxx"))).toEqual([]);
});

test("an untimed tail stays local when a stats window falls before the file's last change", async () => {
  const start = Date.now() - 3 * HOUR;
  const end = start + HOUR;
  const m = await machine();
  policyAt(m, "stats", start);
  policyAt(m, "redacted", end);

  appendFileSync(
    m.claude,
    prompt("claude-fixture", "before window", start - HOUR / 2) +
      '{"type":"user","message":{"content":"tail plan"}}\n',
  );

  const changed = new Date(end + HOUR);
  utimesSync(m.claude, changed, changed);
  chunk(m);
  expect(allBlobs(m).filter((blob) => blob.includes("tail plan"))).toEqual([]);
  expect(allBlobs(m).some((blob) => blob.includes("before window"))).toBe(true);
});

test.skipIf(process.getuid?.() === 0)(
  "a loosening refuses when a transcript folder the scan never read cannot be listed",
  async () => {
    const m = await machine();
    setPolicy(m, "stats");

    const folder = join(dirname(dirname(m.claude)), "-tmp-sessions-fixture-checkout-Hidden");
    mkdirSync(folder);
    writeFileSync(join(folder, "claude-hidden.jsonl"), prompt("claude-hidden", "hidden plan"));

    chmodSync(folder, 0o000);
    cleanup.push(() => chmodSync(folder, 0o755));

    const io = captured(m);
    expect(await policyVerb(["Alpha", "redacted"], "usage", io)).toBe(1);
    expect(io.stdout).toEqual([]);
    expect(io.stderr.join("")).toStartWith("sessions policy: cannot pass over");
    expect(io.stderr.join("")).toContain("EACCES");
    expect(
      m.store.db
        .query(
          "SELECT json_extract(payload, '$.policy') AS p FROM events WHERE type = 'policy' ORDER BY seq DESC LIMIT 1",
        )
        .get(),
    ).toEqual({ p: "stats" });
  },
);
