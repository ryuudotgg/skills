import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseFeed,
  POLICY_EVENT,
  SESSION_EVENT,
  type SessionPolicy,
  type SessionRecord,
} from "skills-core";
import { appendEvent, openStore, recordRevision, sha256, write } from "../plans/store.ts";
import { ensureLinks, saveLink, SCAN_DB } from "../sessions/policy.ts";
import { resolveBuild } from "./build.ts";
import { dashHandler } from "./http.ts";

const TOKEN = "t".repeat(43);
const HOST = "127.0.0.1:4000";
let temporary: string;
let dist: string;

let plansDb: string;
function insert(id: string, wall: number, machine = "studio", type = "start") {
  const store = openStore(plansDb, { drain: false });
  store.db.run(
    `INSERT INTO events (id, machine, wall, counter, ts, project, plan, type, legacy, payload)
     VALUES (?, ?, ?, 0, ?, 'Alpha', '001', ?, 0, ?)`,
    [
      id,
      machine,
      wall,
      new Date(wall).toISOString(),
      type,
      JSON.stringify({ detail: "check", line: "" }),
    ],
  );

  store.db.close();
}

function get(path: string, headers: Record<string, string> = {}): Response {
  const handle = dashHandler({ token: TOKEN, dist, plansDb, env: {} });
  return handle(
    new Request(`http://${HOST}${path}`, {
      headers: { Host: HOST, Authorization: `Bearer ${TOKEN}`, ...headers },
    }),
    HOST,
  );
}

async function feedIds(path: string): Promise<string[]> {
  const response = get(path);
  expect(response.status).toBe(200);
  return parseFeed(await response.text()).map((event) => event.id);
}

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "dash-"));
  dist = join(temporary, "dist");
  plansDb = join(temporary, "plans.db");

  mkdirSync(dist);
  writeFileSync(join(dist, "index.html"), "<p>shell</p>");
  writeFileSync(join(dist, "index.js"), "export {};");
  openStore(plansDb, { fresh: true }).db.close();
});

afterEach(() => rmSync(temporary, { recursive: true, force: true }));

test("the feed needs the bearer token and the page does not", async () => {
  expect(get("/feed", { Authorization: "" }).status).toBe(401);
  expect(get("/feed", { Authorization: `Bearer ${"x".repeat(43)}` }).status).toBe(401);
  expect(get("/blobs/" + "0".repeat(64), { Authorization: "" }).status).toBe(401);
  expect(get("/", { Authorization: "" }).status).toBe(200);
  expect(get("/index.js", { Authorization: "" }).status).toBe(200);
});

test("every path that is not an asset or an endpoint serves the shell, never a file outside dist", async () => {
  writeFileSync(join(temporary, "secret.txt"), "secret");

  for (const path of ["/board", "/plan/Alpha/002", "/../secret.txt", "/%2e%2e/secret.txt"]) {
    const response = get(path);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>shell</p>");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  }
});

test("a request naming another host or using another method is refused", () => {
  expect(get("/", { Host: "attacker.example" }).status).toBe(403);

  const handle = dashHandler({ token: TOKEN, dist, plansDb, env: {} });
  const post = new Request(`http://${HOST}/feed`, { method: "POST", headers: { Host: HOST } });
  expect(handle(post, HOST).status).toBe(405);
});

test("the cursor is arrival order, so an older event that lands later is still served once", async () => {
  insert("a", 1_000);
  insert("b", 3_000);
  expect(await feedIds("/feed")).toEqual(["a", "b"]);

  insert("c", 2_000, "laptop");
  expect(await feedIds("/feed?after=b")).toEqual(["c"]);
  expect(await feedIds("/feed?after=c")).toEqual([]);
});

test("an unknown cursor answers 410 and a malformed one 400", () => {
  insert("a", 1_000);
  expect(get("/feed?after=ffff").status).toBe(410);
  expect(get("/feed?after=not%20a%20cursor").status).toBe(400);
});

test("a missing plans.db serves an empty feed, 410s a cursor and creates nothing", async () => {
  insert("a", 1_000);
  rmSync(plansDb);

  expect(await feedIds("/feed")).toEqual([]);
  expect(get("/feed?after=a").status).toBe(410);
  expect(await Bun.file(plansDb).exists()).toBe(false);
});

test("a link in the build that points outside it is never served", async () => {
  writeFileSync(join(temporary, "secret.txt"), "secret");
  symlinkSync(join(temporary, "secret.txt"), join(dist, "leak.txt"));

  const response = get("/leak.txt", { Authorization: "" });
  expect(await response.text()).toBe("<p>shell</p>");

  rmSync(join(dist, "index.html"));
  symlinkSync(join(temporary, "secret.txt"), join(dist, "index.html"));
  expect(get("/board").status).toBe(404);
});

test("names inherited from Object are not endpoints", async () => {
  for (const path of ["/constructor", "/toString", "/__proto__"]) {
    const response = get(path, { Authorization: "" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<p>shell</p>");
  }
});

test("a blob is served by the sha256 of its bytes", async () => {
  const text = "# 002 feed\n";
  const store = openStore(plansDb, { drain: false });
  recordRevision(
    store,
    "Alpha",
    "Alpha/002-feed.md",
    Buffer.from(text),
    sha256(text),
    "2026-11-01T09:00:00.000Z",
  );

  store.db.close();

  const found = get(`/blobs/${sha256(text)}`);
  expect(found.status).toBe(200);
  expect(await found.text()).toBe(text);
  expect(get(`/blobs/${"0".repeat(64)}`).status).toBe(404);
});

function session(id: string, project: string, machine?: string) {
  const store = openStore(plansDb, { drain: false });
  const record: SessionRecord = {
    host: "claude",
    session: id,
    branch: "feat/feed",
    plans: ["002"],
    source: "scan",
    started: "2026-11-04T09:00:00Z",
  };

  write(store, () =>
    appendEvent(store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project,
      plan: "002",
      payload: record,
    }),
  );

  if (machine !== undefined)
    store.db.run("UPDATE events SET machine = ? WHERE type = ?", [machine, SESSION_EVENT]);

  store.db.close();
}

function policy(project: string, value: SessionPolicy) {
  const store = openStore(plansDb, { drain: false });
  write(store, () =>
    appendEvent(store, {
      kind: "stored",
      type: POLICY_EVENT,
      at: Date.now(),
      project,
      plan: "-",
      payload: { policy: value },
    }),
  );

  store.db.close();
}

test("a session page is the shell, while its digest needs the token", async () => {
  const page = get("/sessions/s-2", { Authorization: "" });
  expect(page.status).toBe(200);
  expect(await page.text()).toBe("<p>shell</p>");

  expect(get("/sessions/s-2/digest", { Authorization: "" }).status).toBe(401);
  expect(get("/sessions/s-2/digest/more", { Authorization: "" }).status).toBe(200);
});

test("a digest the policy withholds answers 403 with the policy word", async () => {
  session("s-2", "Alpha");
  policy("Alpha", "stats");

  const response = get("/sessions/s-2/digest");
  expect(response.status).toBe(403);
  expect(await response.text()).toBe("stats\n");

  policy("Alpha", "off");
  expect(await get("/sessions/s-2/digest").text()).toBe("off\n");
});

test("a session another machine recorded, or none at all, answers 404 without a transcript", async () => {
  session("s-1", "Alpha", "laptop");

  for (const path of ["/sessions/s-1/digest", "/sessions/s-9/digest", "/sessions/%E0/digest"]) {
    const response = get(path);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("no digest for this session\n");
  }
});

test("withheld lists the sessions a local link ties to an off project, behind the token", async () => {
  session("s-2", "Alpha");
  policy("Beta", "off");

  const links = new Database(join(temporary, SCAN_DB), { create: true });
  ensureLinks(links);
  saveLink(links, "claude\ts-2", "Beta");
  links.close();

  expect(get("/withheld", { Authorization: "" }).status).toBe(401);
  expect(await get("/withheld").text()).toBe("claude\ts-2\n");
  expect(get("/withheld/more").status).toBe(404);
});

test("a missing build refuses with the installer's reason or serves what it installed", async () => {
  const env = { HOME: temporary };
  const target = join(temporary, ".agents", "dashboard", "9.9.9");

  expect(
    await resolveBuild(undefined, "9.9.9", env, temporary, async () => ({
      kind: "refused",
      reason: "skills-dashboard-9.9.9.tar.gz is missing from the v9.9.9 release",
    })),
  ).toEqual({
    kind: "refused",
    line: "dash: no dashboard build for 9.9.9: skills-dashboard-9.9.9.tar.gz is missing from the v9.9.9 release",
  });

  const installed = await resolveBuild(undefined, "9.9.9", env, temporary, async () => {
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), "<p>release</p>");
    return { kind: "installed" };
  });

  expect(installed).toEqual({ kind: "build", dir: target });

  expect(await resolveBuild("dist", "9.9.9", env, temporary)).toEqual({ kind: "build", dir: dist });
});
