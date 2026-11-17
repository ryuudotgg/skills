import { afterEach, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BLOB_MAX, CHUNK_SIZE, SESSION_EVENT, type SessionPolicy } from "skills-core";
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
