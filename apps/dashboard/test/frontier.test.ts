import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compareEvents, parseTime, sceneAt } from "skills-core";
import { FrontierBoard } from "../src/views/frontier.tsx";
import { cut, events, machines, now, stored } from "./fixture.ts";

const HASH = "#token=fixture";

function render(time?: string): string {
  const at = time === undefined ? undefined : parseTime(time);
  const scene = sceneAt(events, at, now);
  return renderToStaticMarkup(
    createElement(FrontierBoard, { scene, link: (path: string) => `${path}${HASH}` }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function project(html: string, name: string): string {
  return (
    new RegExp(`<section data-project="${name}"[^>]*>(.*?)</section>`, "s").exec(html)?.[1] ?? ""
  );
}

function list(html: string, name: string, kind: string): string[] {
  const body =
    new RegExp(`<ol data-list="${kind}"[^>]*>(.*?)</ol>`, "s").exec(project(html, name))?.[1] ?? "";

  return [...body.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map(([, item = ""]) => text(item));
}

function attributes(html: string, element: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${element} ${name}="([^"]*)"`, "g"))].map(
    ([, value = ""]) => value.replace(/&gt;/g, ">"),
  );
}

function node(html: string, key: string): string {
  return new RegExp(`<g data-node="${key}"[^>]*>`).exec(html)?.[0] ?? "";
}

describe("without a time", () => {
  const html = render();

  test("Alpha holds nothing ready, 003 blocked on 002 and Beta#1, 004 in review, 002 doing", () => {
    expect(list(html, "Alpha", "ready")).toEqual([]);
    expect(list(html, "Alpha", "blocked")).toEqual(["003 board P2 waits on 002, Beta#1"]);
    expect(list(html, "Alpha", "review")).toEqual(["004 lint P2 feat/lint"]);
    expect(list(html, "Alpha", "doing")).toEqual(["002 feed P1 feat/feed"]);
    expect(list(html, "Alpha", "inbox")).toEqual([]);
  });

  test("Beta has 001 doing and Beta#1 in its inbox, marked as blocking Alpha 003", () => {
    expect(list(html, "Beta", "ready")).toEqual([]);
    expect(list(html, "Beta", "doing")).toEqual(["001 sync P1 feat/sync"]);
    expect(list(html, "Beta", "inbox")).toEqual(["Beta#1 needs sync API blocks Alpha/003"]);
  });

  test("each plan row links its plan page and keeps the token", () => {
    expect(project(html, "Alpha")).toContain(`href="/plan/Alpha/003${HASH}"`);
    expect(project(html, "Beta")).toContain(`href="/plan/Beta/001${HASH}"`);
  });

  test("the graph holds six nodes and the two blocker lines, 003 one column right", () => {
    expect(attributes(html, "g", "data-node")).toEqual([
      "Alpha/001",
      "Alpha/002",
      "Beta/001",
      "Alpha/003",
      "Alpha/004",
      "Beta#1",
    ]);

    expect(attributes(html, "line", "data-edge")).toEqual([
      "Alpha/002->Alpha/003",
      "Beta#1->Alpha/003",
    ]);

    expect(node(html, "Alpha/001")).toContain('data-status="DONE"');

    for (const key of ["Alpha/001", "Alpha/002", "Alpha/004", "Beta/001", "Beta#1"])
      expect(node(html, key)).toContain('data-column="0"');

    expect(node(html, "Alpha/003")).toContain('data-column="1"');
  });

  test("edges use the neutral token and the view holds no colour literal", () => {
    expect(html).toContain("stroke:var(--chart-neutral)");
    expect(html).not.toMatch(/style="[^"]*#/);
  });

  test("lines draw above the nodes, so a line that skips a column stays visible", () => {
    expect(html.indexOf("<line")).toBeGreaterThan(html.lastIndexOf("<g data-node"));
  });

  test("an issue node draws dashed and links nowhere, a plan node links its plan page", () => {
    expect(
      /<g data-node="Beta#1"[^>]*><title>.*?<rect[^>]*stroke-dasharray="4 3"/s.test(html),
    ).toBe(true);

    expect(html).toMatch(
      new RegExp(`<g data-node="Alpha/003"[^>]*><a href="/plan/Alpha/003${HASH}"`),
    );
  });

  test("rendering twice yields identical markup", () => {
    expect(render()).toBe(html);
  });
});

describe("at the cut", () => {
  const html = render(cut);

  test("Alpha holds 004 ready and 003 waiting on 002 alone, Beta holds 001 ready, no inbox", () => {
    expect(list(html, "Alpha", "ready")).toEqual(["004 lint P2 S"]);
    expect(list(html, "Alpha", "blocked")).toEqual(["003 board P2 waits on 002"]);
    expect(list(html, "Beta", "ready")).toEqual(["001 sync P1 L"]);
    expect(list(html, "Alpha", "inbox")).toEqual([]);
    expect(list(html, "Beta", "inbox")).toEqual([]);
  });

  test("the graph holds five nodes and one blocker line", () => {
    expect(attributes(html, "g", "data-node")).toHaveLength(5);
    expect(attributes(html, "line", "data-edge")).toEqual(["Alpha/002->Alpha/003"]);
  });

  test("rendering twice yields identical markup", () => {
    expect(render(cut)).toBe(html);
  });
});

test("an empty feed renders the empty state", () => {
  const scene = sceneAt([], undefined, now);
  const html = renderToStaticMarkup(createElement(FrontierBoard, { scene, link: (path) => path }));
  expect(text(html)).toBe("no plans");
});

test("a number filed twice shows every title and the renumber command in its inbox line", () => {
  const twice = [
    ...events,
    stored(
      "11-05T09:30",
      "Beta",
      "#1",
      "issue",
      { n: 1, title: "needs sync push", body: null, from: null },
      { from: machines.laptop },
    ),
  ].sort(compareEvents);

  const html = renderToStaticMarkup(
    createElement(FrontierBoard, {
      scene: sceneAt(twice, undefined, now),
      link: (path: string) => `${path}${HASH}`,
    }),
  );

  expect(list(html, "Beta", "inbox")).toEqual([
    "Beta#1 needs sync API | needs sync push blocks Alpha/003 conflict, run skills issues renumber Beta#1",
  ]);
});
