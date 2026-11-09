import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  machineLabels,
  parseTime,
  planPage,
  sceneAt,
  type FeedEvent,
  type RevisionEntry,
} from "skills-core";
import { MAX_EDITS, hunkHeader, unifiedDiff } from "../src/diff.ts";
import { Markdown, parseMarkdown } from "../src/markdown.tsx";
import { Shell } from "../src/shell.tsx";
import { PlanDetail, defaultPair, type Texts } from "../src/views/plan.tsx";
import { blobs, cut, events, machines, now, row, stored } from "./fixture.ts";

const HASH = "#token=fixture";

const link = (path: string) => `${path}${HASH}`;

function at(text: string): number {
  const wall = parseTime(text);
  if (wall === undefined) throw new Error(`${text} does not parse`);
  return wall;
}

function render(options: { time?: string; feed?: readonly FeedEvent[]; texts?: Texts } = {}) {
  const { time, feed = events, texts = blobs } = options;
  const scene = sceneAt(feed, time === undefined ? undefined : at(time), now);
  const page = planPage(scene.events, "Alpha", "002");
  const html = renderToStaticMarkup(
    createElement(PlanDetail, {
      project: "Alpha",
      id: "002",
      page,
      labels: machineLabels(scene.events),
      texts,
      pair: defaultPair(page.revisions),
      link,
    }),
  );

  return { page, html };
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function titles(html: string): string[] {
  return [...html.matchAll(/<span data-title=""[^>]*>(.*?)<\/span>/gs)].map(([, inner = ""]) =>
    text(inner),
  );
}

function article(html: string): string {
  return /<article[^>]*>(.*?)<\/article>/s.exec(html)?.[1] ?? "";
}

function cells(html: string, name: "in" | "out"): number[] {
  return [...html.matchAll(new RegExp(`<td data-cell="${name}"[^>]*>(\\d+)</td>`, "g"))].map(
    ([, value = ""]) => Number(value),
  );
}

function blobText(revision: RevisionEntry | undefined): string {
  const found = revision && blobs.get(revision.sha256);
  if (found === undefined) throw new Error("the fixture holds no blob for that revision");
  return found;
}

test("without a time the timeline holds one entry per event of Alpha 002 in core's order", () => {
  const { html } = render();

  expect(titles(html)).toEqual([
    "added",
    "revision",
    "TODO -> DOING",
    "start",
    "thread t-feed",
    "session s-1",
    "session s-2",
    "#12 green",
    "coderabbit fixed",
    "greptile dismissed",
    "revision",
    "heartbeat",
  ]);

  expect(html).toContain('<a href="t3-thread://v1/t-feed"');
  expect(html).toContain(`<a href="/sessions/s-1${HASH}"`);
});

test("session stats fold into two session rows whose token cells sum to 120000 in and 8000 out", () => {
  const { html, page } = render();
  const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);

  expect(page.sessions.map((session) => session.session)).toEqual(["s-1", "s-2"]);
  expect(page.sessions[0]?.machine).toBe(machines.laptop);

  expect(cells(html, "in")).toHaveLength(2);
  expect(sum(cells(html, "in"))).toBe(120000);
  expect(sum(cells(html, "out"))).toBe(8000);
  expect(html).toContain(`<tr data-session="s-1"`);
});

test("the diff of r1 against r2 only adds the Landed section", () => {
  const { page, html } = render();
  const [r1, r2] = page.revisions;
  const lines = (unifiedDiff(blobText(r1), blobText(r2)) ?? []).flatMap((hunk) =>
    hunk.lines.map((line) => `${line.mark}${line.text}`),
  );

  expect(lines.filter((line) => line.startsWith("+"))).toEqual(
    expect.arrayContaining(["+## Landed", "+Branch feat/feed, not merged yet."]),
  );

  expect(lines.filter((line) => line.startsWith("-"))).toEqual([]);

  const shown = /<pre aria-label="Diff of r1 against r2"[^>]*>(.*?)<\/pre>/s.exec(html)?.[1] ?? "";
  expect(text(shown)).toContain("+## Landed");
  expect(text(shown)).toContain("+Branch feat/feed, not merged yet.");
  expect(shown).not.toContain('data-mark="removed"');
});

test("the revision list prints what plans history prints", () => {
  const { page } = render();

  expect(page.revisions.map(({ captured, machine, size }) => [captured, machine, size])).toEqual([
    ["2026-11-01T09:00:00Z", machines.studio, blobText(page.revisions[0]).length],
    ["2026-11-04T12:00:00Z", machines.studio, blobText(page.revisions[1]).length],
  ]);
});

test("the page shows r2's text with Landed as a second level heading", () => {
  const { html, page } = render();
  const shown = article(html);

  expect(html).toContain(`<article data-revision="${page.revisions[1]?.sha256}"`);
  expect(shown).toMatch(/<h2[^>]*>Landed<\/h2>/);
  expect(shown).toContain("Branch feat/feed, not merged yet.");
});

test("at the cut the page shows r1, no Landed heading and four timeline entries", () => {
  const { html, page } = render({ time: cut });
  const shown = article(html);

  expect(titles(html)).toEqual(["added", "revision", "TODO -> DOING", "start"]);
  expect(html).toContain(`<article data-revision="${page.revisions[0]?.sha256}"`);
  expect(page.revisions).toHaveLength(1);

  expect(shown).toContain("The dashboard serves the plans feed on 127.0.0.1.");
  expect(shown).not.toContain("Landed");

  expect(page.sessions).toEqual([]);
  expect(html).not.toContain('aria-label="Diff');
});

test("a revision text renders scripts, images and javascript links as literal text", () => {
  const hostile = [
    "# 002 feed",
    "",
    "<script>alert(1)</script>",
    "",
    "![logo](https://example.com/logo.png)",
    "",
    "[run](javascript:alert(1)) and [docs](https://example.com/docs)",
    "",
  ].join("\n");

  const sha256 = new Bun.CryptoHasher("sha256").update(hostile).digest("hex");
  const feed = [
    ...events,
    stored("11-06T11:58", "Alpha", "002", "revision", {
      path: "Alpha/002-feed.md",
      sha256,
      captured: "2026-11-06T11:58:00Z",
      size: hostile.length,
      blob: sha256.slice(0, 32),
    }),
  ];

  const { html } = render({ feed, texts: new Map([...blobs, [sha256, hostile]]) });
  const shown = article(html);

  expect(text(shown)).toContain("<script>alert(1)</script>");
  expect(text(shown)).toContain("![logo](https://example.com/logo.png)");
  expect(text(shown)).toContain("[run](javascript:alert(1))");
  expect(shown).toContain('<a href="https://example.com/docs"');

  expect(html).not.toContain("<script");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
});

test("a row change that keeps the status and an unreadable payload still get an entry", () => {
  const feed = [
    ...events,
    row("11-06T11:59", "Alpha", {
      id: "002",
      slug: "feed",
      status: "DOING",
      pri: "P1",
      effort: "M",
      blocked_by: "-",
      ctx: "-",
      branch: "feat/feed",
      note: "waiting on CI",
    }),
    stored("11-06T11:59", "Alpha", "002", "pr", { pr: "twelve" } as never),
  ];

  const { html } = render({ feed });

  expect(titles(html).slice(-2)).toEqual(["DOING", "pr"]);
  expect(html).toMatch(/<span data-title=""[^>]*>DOING<\/span><span[^>]*>note<\/span>/);
});

test("hook blocks stay off the timeline and show as one line under it", () => {
  const { html, page } = render();

  expect(page.blocks).toEqual([["reply-guard/dash", 1]]);
  expect(text(html)).toContain("Hook blocks: reply-guard/dash 1");
  expect(render({ time: cut }).html).not.toContain("data-blocks");
});

test("a revision whose blob cannot be read yet says so", () => {
  const newest = render().page.revisions.at(-1)?.sha256 ?? "";
  const texts = new Map<string, string | null>([...blobs, [newest, null]]);

  expect(article(render({ texts }).html)).toBe("");
  expect(render({ texts }).html).toContain("revision text not available yet, trying again");
});

test("the shell routes /plan/Alpha/002 to the page and keeps the empty state elsewhere", () => {
  const shell = (pathname: string) =>
    renderToStaticMarkup(
      createElement(Shell, {
        pathname,
        search: "",
        hash: HASH,
        events,
        wall: now,
        feed: { kind: "live" },
        blob: async () => undefined,
      }),
    );

  expect(titles(shell("/plan/Alpha/002"))).toHaveLength(12);
  expect(shell("/plan/Alpha/002")).toContain("reading revision");
  expect(shell("/plan/Alpha/999")).toContain(">no plan</p>");
  expect(shell("/plan/Alpha")).toContain(">no plan</p>");
});

test("hunk headers follow the unified format", () => {
  const [hunk] = unifiedDiff("a\nb\nc\n", "a\nb\nc\nd\n") ?? [];
  expect(hunk && hunkHeader(hunk)).toBe("@@ -1,3 +1,4 @@");
  expect(unifiedDiff("same\n", "same\n")).toEqual([]);

  const many = (seed: string) =>
    Array.from({ length: MAX_EDITS }, (_, n) => `${seed} ${n}`).join("\n");

  expect(unifiedDiff(many("old"), many("new"))).toBeUndefined();
  expect(unifiedDiff(many("old"), `${many("old")}\nadded`)?.map(hunkHeader)).toHaveLength(1);
});

test("hunks six unchanged lines apart merge as diff -u merges them", () => {
  const before = ["a", "1", "2", "3", "4", "5", "6", "b"].join("\n");
  const after = ["A", "1", "2", "3", "4", "5", "6", "B"].join("\n");
  expect(unifiedDiff(before, after)?.map(hunkHeader)).toEqual(["@@ -1,8 +1,8 @@"]);
});

test("markdown keeps inline backticks, link parentheses and nesting in bounds", () => {
  const markup = (source: string) =>
    renderToStaticMarkup(createElement(Markdown, { text: source }));

  expect(parseMarkdown("```skills plans do``` runs it\n\n## Next")).toEqual([
    { kind: "paragraph", text: "```skills plans do``` runs it" },
    { kind: "heading", level: 2, text: "Next" },
  ]);

  expect(markup("[w](https://en.wikipedia.org/wiki/Foo_(bar)) after")).toContain(
    '<a href="https://en.wikipedia.org/wiki/Foo_(bar)"',
  );

  expect(markup("[[in](https://a.b)](https://c.d)").match(/<a /g)).toHaveLength(1);
  expect(parseMarkdown("1984. Orwell\nwrote it")).toHaveLength(1);

  expect(markup("*a **b** c*")).toContain("<em>a <strong>b</strong> c</em>");
  expect(markup("*read `PRE_*` field*")).toContain("<em>read <code");
  expect(markup("*read `PRE_*` field*")).toContain("PRE_*</code> field</em>");
  expect(() => markup("- ".repeat(2000))).not.toThrow();
});

test("a session row takes its newest record and stats written under another project", () => {
  const resumed = stored(
    "11-06T11:50",
    "Beta",
    "001",
    "session",
    {
      host: "claude",
      session: "s-2",
      branch: "feat/sync",
      plans: ["001"],
      source: "scan",
      started: "2026-11-04T09:00:00Z",
    },
    { from: machines.laptop },
  );

  const stats = stored("11-06T11:51", "Beta", "001", "session-stats", {
    host: "claude",
    session: "s-2",
    models: { sonnet: { effort: "-", in: 50000, out: 4000 } },
    tools: { Bash: 20 },
    records: 20,
    start: "2026-11-04T09:00:00Z",
    end: "2026-11-06T11:51:00Z",
    subagents: 0,
  });

  const { page } = render({ feed: [...events, resumed, stats] });
  const s2 = page.sessions.find((session) => session.session === "s-2");

  expect(page.sessions.map((session) => session.session)).toEqual(["s-1", "s-2"]);
  expect(s2).toMatchObject({ branch: "feat/sync", machine: machines.laptop, in: 50000, out: 4000 });
});
