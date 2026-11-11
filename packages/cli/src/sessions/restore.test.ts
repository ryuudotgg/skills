import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MACHINE_EVENT,
  SESSION_EVENT,
  TRANSCRIPT_EVENT,
  TOOLS,
  type Facts,
  type Host,
  type TranscriptRecord,
} from "skills-core";
import { appendEvent, sha256, storeBlob, write, type Store } from "../plans/store.ts";
import { sessionsMachine, setPolicy, type SessionsMachine } from "../test/sessions-fixture.ts";
import {
  missingChunks,
  movesOf,
  restoreAll,
  resumeLine,
  rewriter,
  targetOf,
  writeExclusive,
} from "./restore.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

const ORIGIN = { cwd: "/r/a/Alpha", root: "/r/a/Alpha", home: "/h/a" };

type Chunk = {
  machine: string;
  series: number;
  chunk: number;
  text: string;
  at: number;
  host?: Host;
};

async function machine(): Promise<SessionsMachine & { checkout: string }> {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const checkout = join(m.root, "checkout/Alpha");
  mkdirSync(checkout, { recursive: true });
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: MACHINE_EVENT,
      at: Date.now(),
      project: "-",
      plan: "-",
      payload: {
        label: "B",
        environment: null,
        os: { platform: "darwin", version: null },
        arch: "arm64",
        tools: Object.fromEntries(
          TOOLS.map((tool) => [tool, { absent: true, reason: "test" }]),
        ) as Facts["tools"],
        checkouts: { Alpha: { path: checkout, origin: null } },
        captured: new Date().toISOString(),
      },
    }),
  );

  return { ...m, checkout };
}

function record(store: Store, chunk: Chunk, session = "claude-fixture"): TranscriptRecord {
  const bytes = Buffer.from(chunk.text);
  const locator = sha256(Buffer.from(`${chunk.machine}${chunk.series}${chunk.chunk}`)).slice(0, 32);
  const payload: TranscriptRecord = {
    host: chunk.host ?? "claude",
    session,
    series: chunk.series,
    chunk: chunk.chunk,
    first: chunk.chunk + 1,
    last: chunk.chunk + 1,
    sha256: sha256(bytes),
    blob: locator,
    bytes: bytes.length,
    policy: "redacted",
    rules: "-",
    digest: "-",
    digestBlob: "-",
    ...(chunk.chunk === 0 ? ORIGIN : {}),
  };

  write(store, () => {
    storeBlob(store, payload.sha256, bytes, locator);
    const author = { ...store, machine: chunk.machine };
    appendEvent(author, {
      kind: "stored",
      type: TRANSCRIPT_EVENT,
      at: chunk.at,
      project: "Alpha",
      plan: "-",
      payload,
    });

    store.clock = author.clock;
  });

  return payload;
}

function restoredFile(m: SessionsMachine & { checkout: string }): string {
  const folder = m.checkout.replace(/[^A-Za-z0-9]/gu, "-");
  return readFileSync(
    join(m.root, "home/.claude/projects", folder, "claude-fixture.jsonl"),
    "utf8",
  );
}

test("two machines recorded the same session: restore takes the newest series of the machine whose chunk is newest", async () => {
  const m = await machine();
  const at = Date.parse("2026-11-07T10:00:00Z");

  record(m.store, { machine: "a", series: 5, chunk: 0, text: "a old\n", at });
  record(m.store, { machine: "a", series: 5, chunk: 1, text: "a older\n", at });
  record(m.store, { machine: "c", series: 0, chunk: 0, text: "c zero\n", at });
  record(m.store, { machine: "c", series: 1, chunk: 0, text: "c one\n", at });
  record(m.store, { machine: "c", series: 1, chunk: 1, text: "c one more\n", at });

  const lines = restoreAll(m.store, m.env, {});
  expect(lines.at(-1)).toBe("restored 1, skipped 0");
  expect(lines[1]).toBe(`cd ${m.checkout} && claude --resume claude-fixture`);
  expect(restoredFile(m)).toBe("c one\nc one more\n");
});

test("a missing or deleted chunk ends the file before it and names the gap", async () => {
  const m = await machine();
  const at = Date.now();
  record(m.store, { machine: "a", series: 0, chunk: 0, text: "zero\n", at });
  const one = record(m.store, { machine: "a", series: 0, chunk: 1, text: "one\n", at: at + 1 });
  record(m.store, { machine: "a", series: 0, chunk: 2, text: "two\n", at: at + 2 });
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: "blob-deleted",
      at: at + 3,
      project: "Alpha",
      plan: "-",
      payload: { blob: one.blob },
    }),
  );

  const [wrote] = restoreAll(m.store, m.env, {});
  expect(wrote).toEndWith(" through chunk 0, chunk 1 missing");
  expect(restoredFile(m)).toBe("zero\n");
});

test("a session this machine also recorded is skipped silently, and since filters on its start", async () => {
  const m = await machine();
  record(m.store, { machine: "a", series: 0, chunk: 0, text: "theirs\n", at: Date.now() });

  expect(restoreAll(m.store, m.env, { since: Date.parse("2026-11-08T00:00:00Z") })).toEqual([
    "restored 0, skipped 0",
  ]);

  record(m.store, {
    machine: m.store.machine,
    series: 0,
    chunk: 0,
    text: "ours\n",
    at: Date.now(),
  });

  expect(restoreAll(m.store, m.env, {})).toEqual(["restored 0, skipped 0"]);
});

test("paths move in string values only, at path boundaries, and untouched lines keep their bytes", () => {
  const rewrite = rewriter(
    movesOf({ ...ORIGIN, cwd: "/r/a/Alpha/sub" } as TranscriptRecord, "/l/b", "/h/b"),
  );

  const line =
    '{"cwd":"/r/a/Alpha/sub","/r/a/Alpha":"/r/a/Alpha/README.md","near":"/r/a/Alpha2/x","key":"/h/a/.ssh","n":1.0}';

  expect(rewrite(line)).toBe(
    '{"cwd":"/l/b/sub","/r/a/Alpha":"/l/b/README.md","near":"/r/a/Alpha2/x","key":"/h/b/.ssh","n":1.0}',
  );

  expect(rewrite('{"n":1.0,"x":"/elsewhere"}')).toBe('{"n":1.0,"x":"/elsewhere"}');
  expect(rewrite("cd /r/a/Alpha && ls /h/a")).toBe("cd /l/b && ls /h/b");
});

test("a file already at the target wins over the restored one", async () => {
  const m = await machine();
  const target = join(m.root, "home/race/claude-fixture.jsonl");
  mkdirSync(join(m.root, "home/race"));
  writeFileSync(target, "host\n");

  expect(writeExclusive(target, Buffer.from("restored\n"))).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("host\n");
  expect(readdirSync(join(m.root, "home/race"))).toEqual(["claude-fixture.jsonl"]);
  expect(writeExclusive(join(m.root, "home/race/new/one.jsonl"), Buffer.from("x\n"))).toBe(true);
  expect(existsSync(join(m.root, "home/race/new/one.jsonl"))).toBe(true);
});

test("the current policy decides what restores: nothing under stats, no full chunk under redacted", async () => {
  const m = await machine();
  const at = Date.now();
  record(m.store, { machine: "a", series: 0, chunk: 0, text: "zero\n", at });
  const full = record(m.store, { machine: "a", series: 0, chunk: 1, text: "secret\n", at });
  m.store.db.run(
    "UPDATE events SET payload = json_set(payload, '$.policy', 'full') WHERE json_extract(payload, '$.blob') = ?",
    [full.blob],
  );

  setPolicy(m, "stats");
  expect(restoreAll(m.store, m.env, {})).toEqual(["restored 0, skipped 0"]);

  setPolicy(m, "redacted");
  const [wrote] = restoreAll(m.store, m.env, {});
  expect(wrote).toEndWith(" through chunk 0, chunk 1 missing");
  expect(restoredFile(m)).toBe("zero\n");
});

test("only well formed, allowed and undeleted chunks with no local blob are fetched", async () => {
  const m = await machine();
  const at = Date.now();

  const held = record(m.store, { machine: "a", series: 0, chunk: 0, text: "held\n", at });
  const wanted = record(m.store, { machine: "a", series: 0, chunk: 1, text: "wanted\n", at });
  const gone = record(m.store, { machine: "a", series: 0, chunk: 2, text: "gone\n", at });
  const odd = record(m.store, { machine: "a", series: 0, chunk: 3, text: "odd\n", at });
  m.store.db.run("DELETE FROM blobs WHERE sha256 IN (?, ?, ?)", [
    wanted.sha256,
    gone.sha256,
    odd.sha256,
  ]);

  m.store.db.run(
    "UPDATE events SET payload = json_set(payload, '$.blob', '../x') WHERE json_extract(payload, '$.sha256') = ?",
    [odd.sha256],
  );

  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: "blob-deleted",
      at,
      project: "Alpha",
      plan: "-",
      payload: { blob: gone.blob },
    }),
  );

  expect(missingChunks(m.store, m.plans).map((fetch) => fetch.sha256)).toEqual([wanted.sha256]);
  expect(held.sha256).not.toBe(wanted.sha256);

  setPolicy(m, "stats");
  expect(missingChunks(m.store, m.plans)).toEqual([]);
});

test("a chunk whose recorded policy is missing or unknown is neither fetched nor restored", async () => {
  const m = await machine();
  const odd = record(m.store, { machine: "a", series: 0, chunk: 0, text: "odd\n", at: Date.now() });
  m.store.db.run("DELETE FROM blobs WHERE sha256 = ?", [odd.sha256]);
  m.store.db.run(
    "UPDATE events SET payload = json_remove(payload, '$.policy') WHERE type = 'transcript'",
  );

  expect(missingChunks(m.store, m.plans)).toEqual([]);
  expect(restoreAll(m.store, m.env, {})).toEqual([
    "skipped claude claude-fixture chunk 0 missing",
    "restored 0, skipped 1",
  ]);
});

test("escaped and Unicode neighbours are judged on the decoded path", () => {
  const rewrite = rewriter(movesOf(ORIGIN as TranscriptRecord, "/l/b", "/h/b"));

  expect(rewrite('{"cwd":"\\/r\\/a\\/Alpha"}')).toBe('{"cwd":"/l/b"}');
  expect(rewrite('{"p":"/r/a/Alpha\\u65e5/x","q":"/r/a/Alpha日/x"}')).toBe(
    '{"p":"/r/a/Alpha\\u65e5/x","q":"/r/a/Alpha日/x"}',
  );

  expect(rewrite("see /r/a/Alpha.")).toBe("see /l/b.");
});

test("the resume line quotes a word only when the shell would split or expand it", () => {
  expect(resumeLine("claude", "abc", "/l/b")).toBe("cd /l/b && claude --resume abc");
  expect(resumeLine("claude", "a$b", "/l/My Project")).toBe(
    "cd '/l/My Project' && claude --resume 'a$b'",
  );

  expect(resumeLine("codex", "it's", "/l/b")).toBe("codex resume 'it'\\''s'");
});

test("a Codex rollout lands under its start day in UTC, and a project with no checkout is named", async () => {
  const m = await machine();
  const dirs = { claude: "/c/projects", codex: "/x/sessions" };
  const start = Date.parse("2026-11-07T10:00:00Z");

  expect(targetOf("codex", "id", "/l/b", start, dirs)).toBe(
    "/x/sessions/2026/11/07/rollout-2026-11-07T10-00-00-id.jsonl",
  );

  expect(targetOf("codex", "-flag", "/l/b", start, dirs)).toBeUndefined();

  record(m.store, { machine: "a", series: 0, chunk: 0, text: "x\n", at: Date.now() });
  m.store.db.run("UPDATE events SET project = 'Beta' WHERE type = 'transcript'");
  expect(restoreAll(m.store, m.env, {})).toEqual([
    "skipped claude claude-fixture no checkout for Beta",
    "restored 0, skipped 1",
  ]);
});

test("a Codex session restores as a rollout under its start day with its paths moved", async () => {
  const m = await machine();
  const at = Date.now();
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: SESSION_EVENT,
      at,
      project: "Alpha",
      plan: "-",
      payload: {
        host: "codex",
        session: "codex-other",
        branch: "feat/one",
        plans: [],
        source: "startup",
        started: "2026-11-07T10:00:00Z",
      },
    }),
  );

  const meta = '{"type":"session_meta","payload":{"id":"codex-other","cwd":"/r/a/Alpha"}}\n';
  const turn = '{"type":"turn_context","payload":{"cwd":"/r/a/Alpha","model":"m"}}\n';
  const codex = { machine: "a", series: 0, at, host: "codex" as const };
  record(m.store, { ...codex, chunk: 0, text: meta }, "codex-other");
  record(m.store, { ...codex, chunk: 1, text: turn }, "codex-other");

  const path = join(
    m.root,
    "home/.codex/sessions/2026/11/07/rollout-2026-11-07T10-00-00-codex-other.jsonl",
  );

  expect(restoreAll(m.store, m.env, {})).toEqual([
    `wrote codex codex-other ${path}`,
    "codex resume codex-other",
    "restored 1, skipped 0",
  ]);

  expect(readFileSync(path, "utf8")).toBe(
    meta.replaceAll("/r/a/Alpha", m.checkout) + turn.replaceAll("/r/a/Alpha", m.checkout),
  );
});

test("sync fetches only the series restore would pick", async () => {
  const m = await machine();
  const at = Date.now();

  const old = record(m.store, { machine: "a", series: 0, chunk: 0, text: "old\n", at });
  const newer = record(m.store, { machine: "a", series: 1, chunk: 0, text: "new\n", at });
  const ours = record(m.store, { machine: "b", series: 0, chunk: 0, text: "x\n", at }, "both");
  record(m.store, { machine: m.store.machine, series: 0, chunk: 0, text: "y\n", at }, "both");
  m.store.db.run("DELETE FROM blobs WHERE sha256 IN (?, ?, ?)", [
    old.sha256,
    newer.sha256,
    ours.sha256,
  ]);

  expect(missingChunks(m.store, m.plans).map((fetch) => fetch.sha256)).toEqual([newer.sha256]);
});
