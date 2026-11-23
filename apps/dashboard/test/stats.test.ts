import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compareEvents, sceneAt, type StatsFilter } from "skills-core";
import { StatsBoard, type StatsPages } from "../src/views/stats.tsx";
import { cut, events, now, row, stored, trail } from "./fixture.ts";
import { renderShell, text } from "./render.ts";

const ALL_90: StatsFilter = { days: 90, project: undefined };

const NOTE = "outcomes per decision, not finding counts";

function board(filter: StatsFilter, at?: string, feed: typeof events = events): string {
  const scene = sceneAt(feed, at === undefined ? undefined : Date.parse(at), now);
  return renderToStaticMarkup(
    createElement(StatsBoard, { events: scene.events, now: scene.now, filter }),
  );
}

function section(html: string, name: string): string {
  return (
    new RegExp(`<section data-section="${name}"[^>]*>(.*?)</section>`, "s").exec(html)?.[1] ?? ""
  );
}

function tiles(html: string): string[] {
  return [...html.matchAll(/<div data-tile="[a-z]+"[^>]*>.*?<dd[^>]*>(.*?)<\/dd>/gs)].map(
    ([, value = ""]) => text(value),
  );
}

function marks(html: string): string[] {
  return [...html.matchAll(/data-mark="([^"]*)"/g)].map(([, mark = ""]) => mark);
}

function reviewers(html: string): string[] {
  return [...html.matchAll(/<tr data-reviewer="([^"]+)"[^>]*>(.*?)<\/tr>/gs)].map(
    ([, name = "", row = ""]) => {
      const [, fixed, dismissed] = [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell]) =>
        text(cell ?? ""),
      );

      return `${name} fixed ${fixed} dismissed ${dismissed}`;
    },
  );
}

function svgs(html: string): string[] {
  return [...html.matchAll(/<svg[^>]*>(.*?)<\/svg>/gs)].map(([, body = ""]) => body);
}

test("without a time, 90 days and every project, the page shows each fixed number", () => {
  const html = board(ALL_90);

  expect(tiles(html)).toEqual(["1 h", "6 h", "18 h"]);
  expect(text(section(html, "phases"))).toContain("median of 1 plan");

  expect(marks(section(html, "effort"))).toEqual(["Alpha 001 S 24 h"]);
  expect(marks(section(html, "models"))).toEqual(["opus 85000", "sonnet 43000"]);
  expect(marks(section(html, "plans"))).toEqual(["Alpha 002 128000"]);
  expect(marks(section(html, "throughput"))).toEqual(["2026-W45 launched 1", "2026-W45 closed 1"]);
  expect(marks(section(html, "blocks"))).toEqual([
    "reply-guard/dash 2",
    "commit-guard/commit-shape 1",
  ]);

  expect(reviewers(html)).toEqual([
    "coderabbit fixed 1 dismissed 0",
    "greptile fixed 0 dismissed 1",
  ]);

  expect(text(section(html, "reviewers"))).toContain(NOTE);
});

test("at the cut only Alpha 001's close is folded and the event lists read empty", () => {
  const html = board(ALL_90, cut);

  expect(tiles(html)).toEqual(["1 h", "6 h", "18 h"]);
  expect(marks(section(html, "throughput"))).toEqual(["2026-W45 closed 1"]);

  expect(text(section(html, "models"))).toContain("no session tokens in this window");
  expect(text(section(html, "plans"))).toContain("no session tokens in this window");
  expect(text(section(html, "blocks"))).toContain("no hook blocks in this window");
  expect(text(section(html, "reviewers"))).toContain("no review rounds in this window");
  expect(reviewers(html)).toEqual([]);
});

test("the 7 day window keeps Alpha 001 at the cut and drops it a week after its close", () => {
  expect(tiles(board({ days: 7, project: undefined }, cut))).toEqual(["1 h", "6 h", "18 h"]);

  const later = board({ days: 7, project: undefined }, "2026-11-12T00:00:00Z");
  expect(tiles(later)).toEqual(["-", "-", "-"]);
  expect(marks(section(later, "effort"))).toEqual([]);
});

test("one project keeps only its own plans and events", () => {
  const beta = board({ days: 90, project: "Beta" });
  expect(tiles(beta)).toEqual(["-", "-", "-"]);
  expect(marks(beta)).toEqual([]);

  const alpha = board({ days: 90, project: "Alpha" });
  expect(tiles(alpha)).toEqual(["1 h", "6 h", "18 h"]);
  expect(marks(section(alpha, "blocks"))).toEqual([
    "reply-guard/dash 2",
    "commit-guard/commit-shape 1",
  ]);
});

test("every text in the stats SVGs labels one mark or names an axis", () => {
  const charts = svgs(board(ALL_90));
  expect(charts).toHaveLength(5);

  for (const chart of charts) {
    const texts = [...chart.matchAll(/<text ([^>]*)>(.*?)<\/text>/gs)].map(
      ([, attributes = "", body = ""]) => ({
        role: /data-label=""/.test(attributes)
          ? "label"
          : /data-axis=""/.test(attributes)
            ? "axis"
            : "",
        body: text(body),
      }),
    );

    const labels = texts.filter((each) => each.role === "label");
    expect(texts.every((each) => each.role !== "" && each.body !== "")).toBe(true);
    expect(labels.every((each) => /\d/.test(each.body))).toBe(true);
    expect(labels).toHaveLength(marks(chart).length);
    expect(labels.map((each) => each.body).sort()).toEqual(
      marks(chart)
        .map((mark) => mark.replace(/^\d{4}-W\d{2} /, ""))
        .sort(),
    );
  }
});

test("the stats route renders through the shell and an empty store reads no stats", () => {
  const render = (feed: typeof events) => renderShell("/stats", { events: feed });

  expect(tiles(render(events))).toEqual(["1 h", "6 h", "18 h"]);
  expect(render(events)).toContain(NOTE);
  expect(render([])).toContain(">no stats</p>");
});

test("each week of the window is listed and a plan launched twice in a week counts once", () => {
  const relaunched = [...events, trail("11-04T18:00", "Alpha", "004", "wave", "claude/opus high")];
  const html = section(
    board({ days: 30, project: undefined }, undefined, relaunched),
    "throughput",
  );

  expect(marks(html)).toEqual(["2026-W45 launched 1", "2026-W45 closed 1"]);
  expect([...html.matchAll(/<text data-axis=""[^>]*>([^<]*)</g)].map(([, week]) => week)).toEqual([
    "2026-W41 none",
    "2026-W42 none",
    "2026-W43 none",
    "2026-W44 none",
    "2026-W45",
  ]);
});

test("the picker keeps the selected project even before it has any events", () => {
  const html = board({ days: 90, project: "Beta" }, "2026-11-01T12:00:00Z");
  expect(html).toContain('<option value="Beta" selected="">Beta</option>');
  expect(tiles(html)).toEqual(["-", "-", "-"]);
});

test("blocks under no project still render, and a long rule id keeps its count visible", () => {
  const rule = "reply-guard/a-very-long-finding-name-that-would-clip";
  const feed = [stored("11-05T10:00", "-", "-", "hook-block", { rules: [rule], host: "claude" })];
  const html = board(ALL_90, undefined, feed);

  expect(html).not.toContain(">no stats</p>");
  expect(marks(section(html, "blocks"))).toEqual(["reply-guard/a-very-long-finding-name-th... 1"]);
  expect(html).toContain(`<title>${rule} 1</title>`);
});

test("a fullwidth model name is clipped by width so its count stays in the label", () => {
  const model = "モデル".repeat(10);
  const feed = [
    stored("11-05T10:00", "Alpha", "001", "session-stats", {
      host: "claude",
      session: "s-9",
      models: { [model]: { effort: "-", in: 70, out: 0 } },
      tools: {},
      records: 1,
      start: null,
      end: null,
      subagents: 0,
    }),
  ];

  expect(marks(section(board(ALL_90, undefined, feed), "models"))).toEqual([
    `${"モデル".repeat(6)}モ... 70`,
  ]);
});

test("a long project name leaves room for the whole effort label suffix", () => {
  const project = "Interaction-design-studio-client-portal";
  const plan = {
    id: "001",
    slug: "x",
    pri: "P1",
    effort: "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    note: "-",
  };

  const feed = [
    row("11-01T09:00", project, { ...plan, status: "TODO" }, { type: "added" }),
    trail("11-01T10:00", project, "001", "start", "-"),
    trail("11-06T07:45", project, "001", "handback", "-"),
    row("11-06T08:00", project, { ...plan, status: "DONE" }),
    trail("11-06T08:00", project, "001", "done", "-"),
  ];

  const [label = ""] = marks(section(board(ALL_90, undefined, feed), "effort"));
  expect(label.endsWith(" 001 S 118 h")).toBe(true);
  expect(label.length).toBeLessThanOrEqual(44);
});

test("Tokens per plan and each effort band draw a first Page and count the more plans left out", () => {
  const spent = Array.from({ length: 25 }, (_, index) =>
    stored(
      `11-05T10:${String(index).padStart(2, "0")}`,
      "Alpha",
      String(100 + index),
      "session-stats",
      {
        host: "claude",
        session: `q-${index}`,
        models: { opus: { effort: "-", in: (index + 1) * 1000, out: 0 } },
        tools: {},
        records: 1,
        start: null,
        end: null,
        subagents: 0,
      },
    ),
  );

  const closed = Array.from({ length: 12 }, (_, index) => {
    const id = String(201 + index);
    const pad = String(index).padStart(2, "0");
    const plan = {
      id,
      slug: "x",
      pri: "P2",
      effort: "S",
      blocked_by: "-",
      ctx: "-",
      branch: "-",
      note: "-",
    };

    return [
      row(`10-30T09:${pad}`, "Alpha", { ...plan, status: "TODO" }, { type: "added" }),
      trail(`11-01T10:${pad}`, "Alpha", id, "start", "-"),
      trail(`11-03T10:${pad}`, "Alpha", id, "handback", "-"),
      row(`11-05T${pad}:00`, "Alpha", { ...plan, status: "DONE" }),
      trail(`11-05T${pad}:01`, "Alpha", id, "done", "-"),
    ];
  }).flat();

  const { events: decoded } = sceneAt([...spent, ...closed].sort(compareEvents), undefined, now);
  const ids = (html: string, name: string) =>
    marks(section(html, name)).map((mark) => mark.split(" ")[1]);

  const draw = (filter: StatsFilter, pages?: StatsPages, at?: number) =>
    renderToStaticMarkup(createElement(StatsBoard, { events: decoded, now, at, filter, pages }));

  const first = draw(ALL_90);
  expect(ids(first, "plans")).toEqual(
    Array.from({ length: 20 }, (_, index) => String(124 - index)),
  );

  expect(text(section(first, "plans"))).toContain("5 more plans not shown");
  expect(ids(first, "effort")).toEqual(
    Array.from({ length: 10 }, (_, index) => String(212 - index)),
  );

  expect(text(section(first, "effort"))).toContain("2 more plans not shown");
  expect(text(section(first, "effort"))).toContain("Show more");
  expect(first).toContain('aria-label="Tokens per plan, 25 plans"');
  expect(first).toContain('aria-label="12 closed plans by effort, build plus review time"');

  const held: StatsPages = { plans: 2, efforts: 2, filter: ALL_90, at: undefined };
  const second = draw(ALL_90, held);
  expect(marks(section(second, "plans"))).toHaveLength(25);
  expect(marks(section(second, "effort"))).toHaveLength(12);
  expect(second).not.toContain("not shown");

  const elsewhere = [
    draw({ days: 90, project: "Alpha" }, held),
    draw({ days: 30, project: undefined }, held),
    draw(ALL_90, held, now),
  ];

  for (const html of elsewhere) {
    expect(marks(section(html, "plans"))).toHaveLength(20);
    expect(marks(section(html, "effort"))).toHaveLength(10);
    expect(text(section(html, "plans"))).toContain("5 more plans not shown");
    expect(text(section(html, "effort"))).toContain("2 more plans not shown");
  }
});
