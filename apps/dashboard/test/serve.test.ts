import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Request } from "playwright";
import { parseFeed } from "skills-core";
import { buildDashboard } from "../build.ts";

const repo = resolve(import.meta.dir, "../../..");
const skills = join(repo, "skills/playbook/bin/skills");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n";

let temporary: string;
let env: Record<string, string>;
let browser: Browser;
let dash: Bun.Subprocess<"ignore", "pipe", "inherit">;
let url: string;

async function run(...args: string[]): Promise<void> {
  const child = Bun.spawn([skills, ...args], { cwd: repo, env, stdout: "pipe", stderr: "pipe" });
  const code = await child.exited;
  if (code !== 0)
    throw new Error(`skills ${args.join(" ")}: ${await new Response(child.stderr).text()}`);
}

async function firstLine(stream: ReadableStream<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();

  let text = "";
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true });
    if (text.includes("\n")) return text.slice(0, text.indexOf("\n"));
  }

  throw new Error(`skills dash printed no line: ${text}`);
}

beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), "dash-serve-"));
  const plans = join(temporary, "plans");
  mkdirSync(join(temporary, "home"));
  mkdirSync(join(plans, "Alpha"), { recursive: true });
  writeFileSync(join(plans, "Alpha", "index.tsv"), header);

  env = {
    PATH: process.env.PATH ?? "",
    HOME: join(temporary, "home"),
    PLANS_DIR: plans,
    SKILLS_CONF: join(temporary, "skills.conf"),
    TMPDIR: temporary,
  };

  await run("plans", "add", "Alpha", "shell", "P1", "S", "-", "-");
  await run("plans", "log", "Alpha", "001", "start", "check");

  const dist = await buildDashboard(join(temporary, "dist"));
  dash = Bun.spawn([skills, "dash", "--no-open", "--dist", dist], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "inherit",
  });

  url = await firstLine(dash.stdout);
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  dash?.kill("SIGTERM");
  await dash?.exited;
  rmSync(temporary, { recursive: true, force: true });
});

test("skills dash prints one URL on 127.0.0.1 with a token of 32 or more URL safe characters", () => {
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:[0-9]+\/#token=[A-Za-z0-9_-]{32,}$/);
});

test("the page polls the feed with a growing cursor and sees a new event without a reload", async () => {
  const page = await browser.newPage();
  const isFeed = (request: Request) => new URL(request.url()).pathname === "/feed";
  const cursorOf = (request: Request) => new URL(request.url()).searchParams.get("after");
  const lastId = (body: string) => {
    const id = parseFeed(body).at(-1)?.id;
    if (id === undefined) throw new Error("the feed answered no line");
    return id;
  };

  const first = page.waitForResponse((response) => isFeed(response.request()));
  await page.goto(url);
  const opened = await first;
  expect(cursorOf(opened.request())).toBeNull();
  const held = lastId(await opened.text());

  await page.waitForRequest((request) => isFeed(request) && cursorOf(request) === held);
  const handback = page.waitForResponse(
    async (response) =>
      isFeed(response.request()) && (await response.text()).includes('"handback"'),
    { timeout: 10_000 },
  );

  await run("plans", "log", "Alpha", "001", "handback", "check");
  const arrived = await handback;
  expect(cursorOf(arrived.request())).toBe(held);
  expect((await arrived.text()).trim().split("\n")).toHaveLength(1);

  const next = lastId(await arrived.text());
  await page.waitForRequest((request) => isFeed(request) && cursorOf(request) === next, {
    timeout: 10_000,
  });

  await page.getByRole("status").filter({ hasText: "3 events" }).waitFor();
  await page.close();
}, 30_000);

test("setting the time travel control rewrites the URL to carry the cut", async () => {
  const page = await browser.newPage();
  await page.goto(url);

  await page.getByLabel("Time travel").fill("2026-11-03T12:00:00Z");
  await page.getByLabel("Time travel").press("Enter");

  await page.waitForURL((current) => current.search === "?at=2026-11-03T12:00:00Z");
  expect(page.url()).toContain("#token=");
  await page.getByText("Showing the store as of 2026-11-03T12:00:00Z").waitFor();

  await page.getByRole("link", { name: "Stats" }).click();
  await page.waitForURL(
    (current) => current.pathname === "/stats" && current.search === "?at=2026-11-03T12:00:00Z",
  );

  await page.getByText("no stats").waitFor();
  await page.close();
}, 30_000);

test("a page opened without the fragment gets 401 on the feed", async () => {
  const page = await browser.newPage();
  const statuses: number[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname === "/feed") statuses.push(response.status());
  });

  await page.goto(url.slice(0, url.indexOf("#")));
  await page.getByRole("status").filter({ hasText: "no access" }).waitFor({ timeout: 10_000 });
  expect(statuses).toEqual([401]);
  await page.close();
}, 30_000);

test("the plan page retries a blob it could not read and fetches a revision once picked", async () => {
  const file = join(temporary, "plans", "Alpha", "001-shell.md");
  const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
  const versions = [
    "---\nid: 001\nslug: shell\nproject: Alpha\nsurface: the shell, private\n---\n\n# 001 shell\n\n## Outcome\n\nFirst text.\n",
  ];

  versions.push(`${versions[0]}\n## Notes\n\nSecond text.\n`);
  versions.push(`${versions[1]}\n## Landed\n\nBranch feat/shell, not merged yet.\n`);

  for (const text of versions) {
    writeFileSync(file, text);
    await run("plans", "lint", "Alpha", "001");
  }

  const page = await browser.newPage();
  const refused = new Set<string>();
  const fetched: string[] = [];
  await page.route("**/blobs/*", async (route) => {
    const sha = new URL(route.request().url()).pathname.slice("/blobs/".length);
    fetched.push(sha);
    if (refused.has(sha)) return route.continue();

    refused.add(sha);
    return route.fulfill({ status: 404, body: "not here\n" });
  });

  await page.goto(url.replace("/#", "/plan/Alpha/001#"));
  await page.getByText("revision text not available yet, trying again").first().waitFor();
  await page.getByRole("heading", { name: "Landed" }).waitFor({ timeout: 15_000 });

  const [first = "", second = "", third = ""] = versions.map(sha256);
  expect(new Set(fetched)).toEqual(new Set([second, third]));

  await page.getByLabel("From").selectOption({ index: 0 });
  await page.getByLabel("Diff of r1 against r3").waitFor({ timeout: 15_000 });

  expect(fetched).toContain(first);
  await page.close();
}, 45_000);
