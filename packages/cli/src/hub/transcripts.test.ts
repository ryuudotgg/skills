import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionPolicy } from "skills-core";
import { chunkTranscripts } from "../sessions/chunks.ts";
import { startHubFixture, type HubFixture } from "../test/hub-fixture.ts";
import {
  age,
  blobText,
  sessionsMachine,
  setPolicy,
  transcripts,
  type SessionsMachine,
} from "../test/sessions-fixture.ts";
import { connect } from "./client.ts";
import { init, type Deps } from "./enroll.ts";
import { keyStore } from "./keys.ts";
import { LONG_BUDGET, statusVerb, syncVerb } from "./sync.ts";

setDefaultTimeout(60_000);

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

type Machine = SessionsMachine & {
  deps: Deps;
  lines: string[];
  failing: Set<string>;
  refusing: Set<string>;
};

async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

async function enrolled(fixture: HubFixture, policy?: SessionPolicy): Promise<Machine> {
  const m = await sessionsMachine(policy);
  cleanup.push(m.close);

  const lines: string[] = [];
  const failing = new Set<string>();
  const refusing = new Set<string>();
  const flaky = (async (input: Request | string | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const route = `${request.method} ${new URL(request.url).pathname.replace(/[0-9a-f]{32}$/, ":id")}`;
    if (failing.has(route)) throw new TypeError("fetch failed");
    if (refusing.has(route))
      return Response.json({ reason: "too-large", message: "too large" }, { status: 413 });

    return fetch(request);
  }) as typeof fetch;

  const deps: Deps = {
    store: m.store,
    keys: keyStore(
      { HOME: join(m.root, ".keys"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline) => connect(url, "local", flaky, undefined, deadline),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  await init(deps, fixture.url, fixture.initCode ?? "", "A");
  return { ...m, deps, lines, failing, refusing };
}

async function sync(m: Machine, url: string, env: NodeJS.ProcessEnv | undefined = m.env) {
  m.lines.length = 0;
  await syncVerb(m.deps, url, { env, budget: LONG_BUDGET, publishQuarantine: false, quiet: false });
  return [...m.lines];
}

function hubCount(fixture: HubFixture, table: "blobs" | "events"): number {
  const db = new Database(join(fixture.dir, "hub.db"), { readonly: true });
  try {
    return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
}

function withheldTypes(m: Machine): string[] {
  const rows = m.store.db
    .query("SELECT type FROM events WHERE withheld = 1 ORDER BY seq")
    .all() as { type: string }[];

  return rows.map((row) => row.type);
}

test("a sync records and uploads a redacted chunk and digest, and withholds the off session", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);

  await sync(m, fixture.url);

  expect(transcripts(m.store)).toHaveLength(1);
  expect(hubCount(fixture, "blobs")).toBe(2);
  expect(withheldTypes(m)).toEqual(["session", "session-stats"]);
});

test("a quiet sync neither scans nor chunks", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);

  await syncVerb(m.deps, fixture.url, {
    env: m.env,
    budget: LONG_BUDGET,
    publishQuarantine: false,
    quiet: true,
  });

  expect(transcripts(m.store)).toHaveLength(0);
});

test("lowering deletes every pushed chunk and digest once, keeping the events", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);
  await sync(m, fixture.url);

  const events = hubCount(fixture, "events");
  setPolicy(m, "stats");

  expect(await sync(m, fixture.url)).toContain("deleted 2 blobs");
  expect(hubCount(fixture, "blobs")).toBe(0);
  expect(hubCount(fixture, "events")).toBeGreaterThan(events);
  expect((await sync(m, fixture.url)).some((line) => line.startsWith("deleted"))).toBe(false);

  m.lines.length = 0;
  await statusVerb(m.deps, fixture.url, "local");
  expect(m.lines).toContain("transcripts: 0 chunks pending, 0 withheld");
});

test("a chunk sealed before its policy dropped is unsealed and never leaves", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);

  m.failing.add("PUT /v1/blobs/:id");
  await expect(sync(m, fixture.url)).rejects.toThrow();
  expect(
    m.store.db
      .query("SELECT author IS NOT NULL AS sealed FROM events WHERE type = 'transcript'")
      .get(),
  ).toEqual({ sealed: 1 });

  setPolicy(m, "stats");
  await sync(m, fixture.url, undefined);

  expect(hubCount(fixture, "blobs")).toBe(0);
  expect(withheldTypes(m)).toContain("transcript");
  expect(m.store.db.query("SELECT count(*) AS n FROM blob_uploads").get()).toEqual({ n: 0 });
});

test("a full chunk not sent before a drop to redacted is withheld, and its text leaves no digest", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture, "full");
  chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });

  setPolicy(m, "redacted");
  await sync(m, fixture.url, undefined);

  expect(hubCount(fixture, "blobs")).toBe(0);
  expect(withheldTypes(m)).toContain("transcript");

  appendFileSync(m.claude, '{"type":"user","message":{"content":"later"}}\n');
  age(m.claude);
  await sync(m, fixture.url);
  expect(hubCount(fixture, "blobs")).toBe(2);
  expect(blobText(m.store, transcripts(m.store).at(-1)?.digest ?? "")).not.toContain("AWS key");
});

test("blobs uploaded before their event was refused are deleted once the policy drops", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);
  chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });

  m.failing.add("POST /v1/events");
  await expect(sync(m, fixture.url, undefined)).rejects.toThrow();
  expect(hubCount(fixture, "blobs")).toBe(2);
  m.failing.clear();

  setPolicy(m, "stats");
  expect(await sync(m, fixture.url, undefined)).toContain("deleted 2 blobs");
  expect(hubCount(fixture, "blobs")).toBe(0);
});

test("a pushed full chunk is deleted when the policy drops to redacted, its digest kept", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture, "full");
  await sync(m, fixture.url);

  setPolicy(m, "redacted");

  expect(await sync(m, fixture.url, undefined)).toContain("deleted 1 blobs");
  expect(hubCount(fixture, "blobs")).toBe(1);
});

test("a blob an older hub refuses as too large stays queued and goes out once it is accepted", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture);

  m.refusing.add("PUT /v1/blobs/:id");
  expect(await sync(m, fixture.url)).toContain(
    "held 2 blobs the hub refuses as too large, upgrade the hub to send them",
  );

  expect(m.store.db.query("SELECT count(*) AS n FROM blob_uploads").get()).toEqual({ n: 2 });

  m.refusing.clear();
  await sync(m, fixture.url, undefined);
  expect(hubCount(fixture, "blobs")).toBe(2);
});

test("a full chunk uploaded before its event was refused loses both blobs when the policy drops to redacted", async () => {
  const fixture = await hub();
  const m = await enrolled(fixture, "full");
  chunkTranscripts(m.store, m.plans, m.env, {
    deadline: Number.POSITIVE_INFINITY,
    bytes: Number.POSITIVE_INFINITY,
  });

  m.failing.add("POST /v1/events");
  await expect(sync(m, fixture.url, undefined)).rejects.toThrow();
  m.failing.clear();

  setPolicy(m, "redacted");
  expect(await sync(m, fixture.url, undefined)).toContain("deleted 2 blobs");
  expect(hubCount(fixture, "blobs")).toBe(0);
});
