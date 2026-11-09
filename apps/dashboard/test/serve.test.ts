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

type Env = Record<string, string>;

type Dash = Bun.Subprocess<"ignore", "pipe", "inherit">;

let temporary: string;
let env: Env;

let browser: Browser;
let dist: string;
let dash: Dash;
let url: string;

function plansIn(root: string, projects: readonly string[]): Env {
  const plans = join(root, "plans");
  mkdirSync(join(root, "home"));

  for (const project of projects) {
    mkdirSync(join(plans, project), { recursive: true });
    writeFileSync(join(plans, project, "index.tsv"), header);
  }

  return {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"),
    PLANS_DIR: plans,
    SKILLS_CONF: join(root, "skills.conf"),
    TMPDIR: root,
  };
}

async function output(environment: Env, args: readonly string[]): Promise<string> {
  const child = Bun.spawn([skills, ...args], {
    cwd: repo,
    env: environment,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [code, text, error] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  if (code !== 0) throw new Error(`skills ${args.join(" ")}: ${error}`);
  return text;
}

async function run(...args: string[]): Promise<void> {
  await output(env, args);
}

function serve(environment: Env): Dash {
  return Bun.spawn([skills, "dash", "--no-open", "--dist", dist], {
    cwd: repo,
    env: environment,
    stdout: "pipe",
    stderr: "inherit",
  });
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
  env = plansIn(temporary, ["Alpha"]);

  await run("plans", "add", "Alpha", "shell", "P1", "S", "-", "-");
  await run("plans", "log", "Alpha", "001", "start", "check");

  dist = await buildDashboard(join(temporary, "dist"));
  dash = serve(env);
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

function readyIds(frontier: string): string[] {
  const lines = frontier.split("\n");
  const end = lines.indexOf("", 1);
  return lines.slice(1, end === -1 ? undefined : end).map((line) => line.split(" ")[0] ?? "");
}

test("the frontier view's ready ids match skills plans frontier for each project", async () => {
  const page = await browser.newPage();
  const root = mkdtempSync(join(tmpdir(), "plans-262-"));
  const local = plansIn(root, ["Alpha", "Beta"]);
  const skillsIn = (...args: string[]) => output(local, args);
  const live = serve(local);

  const selector = (project: string) =>
    `section[data-project="${project}"] ol[data-list="ready"] > li`;

  const shown = (project: string) =>
    page
      .locator(selector(project))
      .evaluateAll((items) => items.map((item) => item.getAttribute("data-row") ?? ""));

  const matches = async () => {
    for (const project of ["Alpha", "Beta"]) {
      const printed = readyIds(await skillsIn("plans", "frontier", project));
      const settled = ({ css, ids }: { css: string; ids: string[] }) =>
        JSON.stringify(
          [...document.querySelectorAll(css)].map((item) => item.getAttribute("data-row")),
        ) === JSON.stringify(ids);

      await page
        .waitForFunction(settled, { css: selector(project), ids: printed }, { timeout: 15_000 })
        .catch(() => undefined);

      expect(await shown(project)).toEqual(printed);
    }
  };

  const filed = [
    ["plans", "add", "Alpha", "shell", "P1", "S", "-", "-"],
    ["plans", "add", "Alpha", "feed", "P1", "M", "-", "-"],
    ["plans", "add", "Alpha", "board", "P2", "M", "002", "-"],
    ["plans", "add", "Alpha", "lint", "P2", "S", "-", "-"],
    ["plans", "add", "Beta", "sync", "P1", "L", "-", "-"],
    ["issues", "file", "Beta", "needs sync API", "--blocks", "Alpha/003"],
    ["issues", "link", "Beta#1", "001"],
  ];

  const moved = [
    ["Alpha", "001", "DONE", "feat/shell"],
    ["Alpha", "002", "DOING", "feat/feed"],
    ["Alpha", "004", "REVIEW", "feat/lint"],
    ["Beta", "001", "DOING", "feat/sync"],
  ];

  try {
    for (const args of filed) await skillsIn(...args);

    await page.goto((await firstLine(live.stdout)).replace("/#", "/frontier#"));
    await matches();
    expect(await shown("Alpha")).toEqual(["002", "001", "004"]);

    for (const args of moved) await skillsIn("plans", "set-row", ...args);

    await page.locator('section[data-project="Alpha"] ol[data-list="review"] > li').waitFor({
      timeout: 15_000,
    });

    await matches();
    expect(await shown("Alpha")).toEqual([]);
    await page.getByText("waits on 002, Beta#1").waitFor();
  } finally {
    await page.close();
    live.kill("SIGTERM");
    await live.exited;
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
