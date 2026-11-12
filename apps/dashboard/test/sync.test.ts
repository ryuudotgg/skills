import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { parseSync } from "skills-core";
import { buildDashboard } from "../build.ts";

setDefaultTimeout(120_000);

const repo = resolve(import.meta.dir, "../../..");
const live = join(repo, "packages/cli/src/test/hub-live.ts");
const bin = join(repo, "skills/playbook/bin");

type Env = Record<string, string>;

type Machine = { env: Env; cwd: string };

type Dash = { process: Bun.Subprocess<"ignore", "pipe", "inherit">; url: string; origin: string };

let temporary: string;
let hubUrl: string;
let a: Machine;
let b: Machine;

let dist: string;
let browser: Browser;
let dash: Dash;

async function finished(child: Bun.Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (code !== 0) throw new Error(`exit ${code}: ${error || text}`);
  return text;
}

function hubLive(...args: string[]): Promise<string> {
  return finished(Bun.spawn(["bun", live, ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" }));
}

function unquoted(value: string): string {
  return value.startsWith("'") ? value.slice(1, -1).replaceAll("'\\''", "'") : value;
}

async function machine(name: string, plans: "fixture" | "empty"): Promise<Machine> {
  const lines = (await hubLive("machine", temporary, name, "--plans", plans)).split("\n");
  const env: Env = { PATH: `${bin}:${process.env.PATH ?? ""}`, TMPDIR: temporary };

  let cwd = repo;
  for (const line of lines) {
    const exported = /^export (\w+)=(.*)$/.exec(line);
    if (exported?.[1] && exported[1] !== "PATH") env[exported[1]] = unquoted(exported[2] ?? "");

    const into = /^cd (.*)$/.exec(line);
    if (into?.[1]) cwd = unquoted(into[1]);
  }

  return { env, cwd };
}

function skills(on: Machine, ...args: string[]): Bun.Subprocess<"ignore", "pipe", "pipe"> {
  return Bun.spawn([join(bin, "skills"), ...args], {
    cwd: on.cwd,
    env: on.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function run(on: Machine, ...args: string[]): Promise<string> {
  return finished(skills(on, ...args));
}

async function lineMatching(
  stream: ReadableStream<Uint8Array>,
  pattern: RegExp,
): Promise<RegExpExecArray> {
  const decoder = new TextDecoder();

  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    const found = pattern.exec(text);
    if (found) return found;
  }

  throw new Error(`no line matched ${pattern.source}: ${text}`);
}

async function enroll(): Promise<void> {
  const up = await hubLive("up", temporary);
  hubUrl = /^HUB_URL=(\S+)$/m.exec(up)?.[1] ?? "";
  const code = /^init code (\S+)$/m.exec(up)?.[1] ?? "";

  a = await machine("a", "fixture");
  b = await machine("b", "empty");
  await run(a, "hub", "init", hubUrl, "--code", code, "--label", "a");

  const invite = skills(a, "hub", "invite", "--label", "b");
  const line = await lineMatching(invite.stdout, /^skills hub join \S+ (\S+)$/m);
  await run(b, "hub", "join", hubUrl, line[1] ?? "");
  expect(await invite.exited).toBe(0);

  await run(a, "hub", "sync");
  await run(b, "hub", "sync");
}

async function serve(env: Env): Promise<Dash> {
  const child = Bun.spawn([join(bin, "skills"), "dash", "--no-open", "--dist", dist], {
    cwd: a.cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "inherit",
  });

  const url = (await lineMatching(child.stdout, /^(http\S+)\n/m))[1] ?? "";
  return { process: child, url, origin: new URL(url).origin };
}

async function stopDash(served: Dash): Promise<void> {
  served.process.kill("SIGTERM");
  await served.process.exited;
}

function tokenOf(served: Dash): string {
  return served.url.slice(served.url.indexOf("#token=") + "#token=".length);
}

function get(served: Dash, path: string): Promise<Response> {
  return fetch(`${served.origin}${path}`, {
    headers: { Authorization: `Bearer ${tokenOf(served)}` },
  });
}

function syncLine(page: Page) {
  return page.locator("[data-sync]");
}

async function syncReads(page: Page, pattern: RegExp, timeout = 15_000): Promise<string> {
  try {
    await syncLine(page).filter({ hasText: pattern }).waitFor({ timeout });
  } catch (error) {
    const shown = await syncLine(page).textContent();
    const sync = await get(dash, "/sync").then((answer) => answer.text());
    throw new Error(`the shell read "${shown}" and /sync answered ${sync}, not ${pattern}`, {
      cause: error,
    });
  }

  return (await syncLine(page).textContent()) ?? "";
}

async function visit(page: Page, served: Dash, path: string): Promise<void> {
  await page
    .getByRole("link", { name: path.slice(1), exact: false })
    .first()
    .click();

  await page.waitForURL((current) => current.pathname === path && current.origin === served.origin);
}

function hubLog(): string {
  return readFileSync(join(temporary, "hub", "hub.log"), "utf8");
}

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), "dash-sync-"));
  await enroll();

  dist = await buildDashboard(join(temporary, "dist"));
  dash = await serve(a.env);
  browser = await chromium.launch();
}, 120_000);

afterAll(async () => {
  await browser?.close();
  if (dash) await stopDash(dash);
  await hubLive("down", temporary).catch(() => undefined);
  rmSync(temporary, { recursive: true, force: true });
});

test("skills dash serves the sync state of its last hub sync", async () => {
  let answer = await get(dash, "/sync");
  for (let waited = 0; answer.status === 503 && waited < 10_000; waited += 200) {
    await Bun.sleep(200);
    answer = await get(dash, "/sync");
  }

  const sync = parseSync(await answer.text());
  if (sync.state !== "synced") throw new Error(`not synced: ${JSON.stringify(sync)}`);

  expect(Math.abs(Date.now() - Date.parse(sync.lastSync))).toBeLessThan(10_000);
  expect(sync.queue).toBe(0);
  expect((await get(dash, "/sync").then((response) => response.headers)).get("Cache-Control")).toBe(
    "no-store",
  );
});

test("every view shows synced, and a row another machine adds arrives without a reload", async () => {
  const page = await browser.newPage();
  const asked: string[] = [];
  page.on("request", (request) => asked.push(new URL(request.url()).origin));

  await page.goto(dash.url.replace("/#", "/board#"));
  expect(await syncReads(page, /^synced .*, queue 0, conflicts 0/)).toMatch(/^synced /);

  for (const path of ["/frontier", "/stats"]) {
    await visit(page, dash, path);
    expect(await syncReads(page, /^synced .*, queue 0,/)).toContain("queue 0");
  }

  await visit(page, dash, "/frontier");
  let reloaded = false;
  page.on("load", () => {
    reloaded = true;
  });

  await run(b, "plans", "add", "Fixture", "extra", "P2", "S", "-", "-");
  await run(b, "hub", "sync");
  await page.waitForFunction(
    () => /004\s+extra/.test(document.querySelector("main")?.textContent ?? ""),
    undefined,
    { timeout: 15_000 },
  );

  expect(reloaded).toBe(false);
  expect(new Set(asked)).toEqual(new Set([dash.origin]));
  await page.close();
});

test("with the hub down the shell reads offline with the status reason, and back to synced once up", async () => {
  const page = await browser.newPage();
  await page.goto(dash.url.replace("/#", "/board#"));
  await syncReads(page, /^synced /);

  await hubLive("down", temporary);
  const status = await run(a, "hub", "status");
  const offline = status.split("\n").find((line) => line.startsWith("offline: "));
  if (offline === undefined)
    throw new Error(`skills hub status printed no offline line:\n${status}`);

  const exactly = new RegExp(`^${offline.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
  expect(await syncReads(page, exactly)).toBe(offline);

  for (const [path, name] of [
    ["/frontier", "Frontier"],
    ["/stats", "Stats"],
    ["/board", "Board"],
  ] as const) {
    await visit(page, dash, path);
    await page.getByRole("heading", { name, level: 1 }).waitFor();
    expect(await syncLine(page).textContent()).toBe(offline);
  }

  const began = performance.now();
  const feed = await get(dash, "/feed");
  expect(feed.status).toBe(200);
  await feed.text();
  expect(performance.now() - began).toBeLessThan(1_000);

  await hubLive("up", temporary);
  expect(await syncReads(page, /^synced /, 30_000)).toMatch(/, queue 0, conflicts 0/);
  await page.close();
});

test("with no hub configured the dash is local only and sends the hub no request", async () => {
  await stopDash(dash);

  const { HUB_URL: _, ...withoutHub } = a.env;
  const local = await serve(withoutHub);
  try {
    const before = hubLog();
    expect(await (await get(local, "/sync")).text()).toBe('{"state":"local only"}');

    const page = await browser.newPage();
    await page.goto(local.url);
    expect(await syncReads(page, /^local only$/)).toBe("local only");

    await Bun.sleep(11_000);
    expect(hubLog()).toBe(before);
    await page.close();
  } finally {
    await stopDash(local);
  }
});
