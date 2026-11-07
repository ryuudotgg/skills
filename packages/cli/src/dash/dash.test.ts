import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseFeed } from "skills-core";
import { openStore, sha256 } from "../plans/store.ts";
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
  const handle = dashHandler({ token: TOKEN, dist, plansDb });
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

  const handle = dashHandler({ token: TOKEN, dist, plansDb });
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
  store.db.run(
    "INSERT INTO revisions (project, path, sha256, text, captured, machine) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "Alpha",
      "Alpha/002-feed.md",
      sha256(text),
      Buffer.from(text),
      "2026-11-01T09:00:00Z",
      "studio",
    ],
  );

  store.db.close();

  const found = get(`/blobs/${sha256(text)}`);
  expect(found.status).toBe(200);
  expect(await found.text()).toBe(text);
  expect(get(`/blobs/${"0".repeat(64)}`).status).toBe(404);
});

test("a missing build refuses through the installer, which 258 replaces", async () => {
  const env = { HOME: temporary };
  const target = join(temporary, ".agents", "dashboard", "9.9.9");

  expect(await resolveBuild(undefined, "9.9.9", env, temporary)).toEqual({
    kind: "refused",
    line: `dash: no dashboard build for 9.9.9: not installed at ${target}`,
  });

  const installed = await resolveBuild(
    undefined,
    "9.9.9",
    env,
    temporary,
    async (_version, into) => {
      mkdirSync(into, { recursive: true });
      writeFileSync(join(into, "index.html"), "<p>release</p>");
      return { kind: "installed" };
    },
  );

  expect(installed).toEqual({ kind: "build", dir: target });

  expect(await resolveBuild("dist", "9.9.9", env, temporary)).toEqual({ kind: "build", dir: dist });
});
