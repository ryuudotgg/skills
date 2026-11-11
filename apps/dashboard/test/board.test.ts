import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseTime, sceneAt } from "skills-core";
import { BoardTable } from "../src/views/board.tsx";
import { cut, events, now, stored } from "./fixture.ts";

const HASH = "#token=fixture";

function render(time?: string): string {
  const at = time === undefined ? undefined : parseTime(time);
  const scene = sceneAt(events, at, now);
  return renderToStaticMarkup(
    createElement(BoardTable, { scene, link: (path: string) => `${path}${HASH}` }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function rows(html: string): string[] {
  const body = /<tbody[^>]*>(.*?)<\/tbody>/s.exec(html)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(([, row = ""]) => row);
}

function cells(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell = ""]) => cell);
}

function texts(html: string): string[][] {
  return rows(html).map((row) => cells(row).map(text));
}

describe("without a time", () => {
  const html = render();

  test("two DOING rows, Alpha 002 then Beta 001, with every column", () => {
    expect(texts(html)).toEqual([
      ["Alpha 002 feed", "studio", "open", "feat/feed", "#12 green", "5 min", ""],
      ["Beta 001 sync", "laptop", "-", "feat/sync", "-", "stale 90 min", "conflict with studio"],
    ]);
  });

  test("the thread cell is a plain anchor to the T3 thread", () => {
    const [feed = ""] = rows(html);
    expect(cells(feed)[2]).toMatch(/^<a [^>]*href="t3-thread:\/\/v1\/t-feed"[^>]*>open<\/a>$/);
  });

  test("the plan cell links the plan page and keeps the token", () => {
    const [feed = "", sync = ""] = rows(html);
    expect(cells(feed)[0]).toContain(`href="/plan/Alpha/002${HASH}"`);
    expect(cells(sync)[0]).toContain(`href="/plan/Beta/001${HASH}"`);
  });

  test("stale and conflict carry the accent, a fresh heartbeat does not", () => {
    const [feed = "", sync = ""] = rows(html);
    expect(cells(feed)[5]).not.toContain("--chart-accent");
    expect(cells(sync)[5]).toContain("color:var(--chart-accent)");
    expect(cells(sync)[6]).toContain("color:var(--chart-accent)");
    expect(html.match(/--chart-accent/g)).toHaveLength(2);
  });

  test("rendering twice yields identical markup", () => {
    expect(render()).toBe(html);
  });
});

describe("at the cut", () => {
  test("one row, Alpha 002 started on studio with no thread, PR or heartbeat yet", () => {
    expect(texts(render(cut))).toEqual([
      ["Alpha 002 feed", "studio", "-", "feat/feed", "-", "none", ""],
    ]);
  });
});

test("with the time set to 12:30 the heartbeat age counts from that time", () => {
  const [feed = []] = texts(render("2026-11-06T12:30:00Z"));
  expect(feed[0]).toBe("Alpha 002 feed");
  expect(feed[5]).toBe("stale 35 min");
});

test("a merged PR shows its state, not the last check verdict", () => {
  const merged = stored("11-06T11:58", "Alpha", "002", "pr", {
    pr: 12,
    branch: "feat/feed",
    state: "merged",
    head: "abc1234",
    verdict: "green",
    failing: [],
  });

  const scene = sceneAt([...events, merged], undefined, now);
  const html = renderToStaticMarkup(createElement(BoardTable, { scene, link: (path) => path }));
  expect(texts(html)[0]?.[4]).toBe("#12 merged");
});

test("an empty feed renders the empty state", () => {
  const scene = sceneAt([], undefined, now);
  const html = renderToStaticMarkup(createElement(BoardTable, { scene, link: (path) => path }));
  expect(text(html)).toBe("no plans doing");
});
